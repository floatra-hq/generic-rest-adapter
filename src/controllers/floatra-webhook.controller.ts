import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigLoaderService } from '../config/config-loader.service';
import { OutboundTranslatorService } from '../translators/outbound-translator.service';
import { EventDedupService } from '../webhook/event-dedup.service';
import {
  isTimestampFresh,
  verifyFloatraSignature,
} from '../webhook/hmac-verifier';
import { toWebhookEvent } from '../webhook/webhook-event';

/**
 * POST /adapter/:platformId/floatra-webhook
 *
 * Receives outbound events from the Floatra gateway. Spec v3.1 §4.1
 * mandates four security checks the receiver MUST perform before
 * routing the event:
 *
 *   1. Signature verify: HMAC(secret, timestamp + "." + body)  (P0-8)
 *   2. Replay-window: |now - X-Floatra-Timestamp| <= 5 min     (P0-9)
 *   3. Event-ID dedup: SETNX (X-Floatra-Event-ID, 24h TTL)     (P0-10)
 *   4. JSON parse + shape check (X-Floatra-Event-ID + body.event)
 *
 * Core sends a FLAT camelCase payload ({ event, loanId, amount, ...,
 * timestamp }) with the event id in X-Floatra-Event-ID; it is wrapped
 * into the internal envelope by `toWebhookEvent`.
 *
 * 403 on signature mismatch / stale timestamp; 400 on a malformed body
 * or missing event id; 200 `{ accepted, duplicate }` on a duplicate
 * event-id — core (#1220) treats any non-2xx as a failed delivery.
 */
@Controller('adapter/:platformId/floatra-webhook')
export class FloatraWebhookController {
  private readonly logger = new Logger(FloatraWebhookController.name);

  constructor(
    private readonly loader: ConfigLoaderService,
    private readonly translator: OutboundTranslatorService,
    private readonly dedup: EventDedupService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Param('platformId') platformId: string,
    @Headers('x-floatra-signature') signature: string | undefined,
    @Headers('x-floatra-timestamp') timestamp: string | undefined,
    @Headers('x-floatra-event-id') eventIdHeader: string | undefined,
    @Headers('x-floatra-delivery-attempt') deliveryAttempt: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<{ accepted: true; duplicate?: true }> {
    const config = this.loader.getByPlatform(platformId);
    if (!config) {
      throw new NotFoundException(`Unknown platform_id: ${platformId}`);
    }

    // Express raw body — bootstrap configures the json middleware
    // to capture the buffer on req.rawBody so we can HMAC-verify
    // before parsing tampers with byte order.
    const raw = req.rawBody;
    if (!raw) {
      throw new BadRequestException(
        'Adapter is misconfigured: raw body not captured. Check main.ts bootstrap.',
      );
    }

    // P0-8: signature is HMAC over (timestamp + "." + body), NOT
    // body alone. v3.0 was incompatible with the spec-compliant
    // gateway emit shape.
    if (
      !verifyFloatraSignature(raw, signature, config.webhook_secret, timestamp)
    ) {
      this.logger.warn(
        `HMAC verification failed for platform ${platformId} — rejecting`,
      );
      throw new ForbiddenException('Invalid signature');
    }

    // P0-9: ±5 min freshness check on X-Floatra-Timestamp. Without
    // this, even a valid signature is replayable indefinitely.
    if (!isTimestampFresh(timestamp)) {
      this.logger.warn(
        `Timestamp drift exceeded for platform ${platformId} (ts=${timestamp ?? 'missing'}) — rejecting`,
      );
      throw new ForbiddenException('Stale timestamp');
    }

    const payload = parseObjectBody(raw);
    if (!eventIdHeader || typeof payload.event !== 'string') {
      throw new BadRequestException(
        'Webhook missing X-Floatra-Event-ID or body.event',
      );
    }
    const event = toWebhookEvent(eventIdHeader, payload);

    // P0-10: event-ID dedup. Core (#1220) treats any non-2xx as a failed
    // delivery, so a duplicate is acknowledged with 200; a 409 would be
    // retried until dead-lettered.
    if (await this.dedup.isDuplicate(event.event_id)) {
      this.logger.log(
        `Duplicate event ${event.event_id} for platform=${platformId} (attempt=${deliveryAttempt ?? '?'})`,
      );
      return { accepted: true, duplicate: true };
    }

    try {
      await this.translator.translateAndDeliver(event, config);
    } catch (err) {
      // Release the dedup claim so Floatra's retry can re-attempt.
      // Without this, a transient ERP failure pins the event-id as
      // "seen" for 24h and the retry is silently skipped.
      await this.dedup.release(event.event_id);
      this.logger.error(
        `Outbound delivery failed for platform=${platformId} event=${event.event_type}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    return { accepted: true };
  }
}

/**
 * Parse the verified raw body. Valid JSON is not necessarily an object: a
 * signed `null`, array, string or number would otherwise TypeError (500) on
 * `payload.event`, so anything but a plain object is a 400.
 */
function parseObjectBody(raw: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf-8'));
  } catch {
    throw new BadRequestException('Body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException('Body is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}
