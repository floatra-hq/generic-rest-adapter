import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigLoaderService } from '../config/config-loader.service';
import {
  InboundTranslationError,
  InboundTranslatorService,
} from '../translators/inbound-translator.service';
import {
  FloatraApiClient,
  FloatraApiError,
} from '../floatra/floatra-api.client';
import { verifyInboundHmac } from '../webhook/inbound-hmac';
import { ErpDeliveryService } from '../erp/erp-delivery.service';
import { FallbackAuditService } from '../audit/fallback-audit.service';
import { FloatraAdapterConfig } from '../config/config.types';
import { TranslationResult } from '../translators/inbound-translator.service';
import { constantTimeEqual } from '../common/constant-time-compare';

/**
 * POST /adapter/:platformId/inbound
 *
 * The ERP posts its native payload here. We translate it via the
 * per-platform config, call the Floatra gateway, and return either
 * the decision (sync mode) or 202 (callback mode).
 */
@Controller('adapter/:platformId/inbound')
export class InboundController {
  private readonly logger = new Logger(InboundController.name);

  constructor(
    private readonly loader: ConfigLoaderService,
    private readonly translator: InboundTranslatorService,
    private readonly floatra: FloatraApiClient,
    private readonly erpDelivery: ErpDeliveryService,
    private readonly fallbackAudit: FallbackAuditService,
  ) {}

  @Post()
  async handle(
    @Param('platformId') platformId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const config = this.loader.getByPlatform(platformId);
    if (!config) {
      throw new NotFoundException(`Unknown platform_id: ${platformId}`);
    }

    this.verifyInboundAuth(config.inbound.auth, headers, req);

    let translation;
    try {
      translation = this.translator.translate(body, config);
    } catch (err) {
      if (err instanceof InboundTranslationError) {
        throw new BadRequestException({ code: err.code, message: err.message });
      }
      throw err;
    }

    // Route to the gateway based on the trigger's action.
    let gatewayResp;
    try {
      gatewayResp = await this.routeAction(config, translation);
    } catch (err) {
      if (err instanceof FloatraApiError) {
        return this.handleFallback(
          config,
          translation,
          err,
          res,
          translation.payload.external_order_id,
        );
      }
      throw err;
    }

    if (config.inbound.response_mode === 'sync') {
      res.status(gatewayResp.status).json(gatewayResp.body);
      return;
    }

    // Callback mode — respond 202 to the ERP immediately, then POST
    // the decision to `inbound.callback_url`. The outbound retry
    // policy (5xx exponential backoff, 4xx fail-fast) matches
    // ErpDeliveryService.deliver so distributors get the same
    // delivery guarantees on callbacks as on event webhooks.
    res.status(HttpStatus.ACCEPTED).json({ accepted: true });
    this.fireCallback(config, translation, gatewayResp).catch((err) => {
      // Never let callback delivery failure crash the request — it
      // already returned 202. Log + move on; ops can replay from
      // the `inbound.callback_url` failures dashboard.
      this.logger.error(
        `Callback delivery failed for platform=${platformId} action=${translation.action}: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  /**
   * Dispatch a translated event to the right Floatra endpoint.
   *
   *   initiate_order   → /v1/partner/orders/initiate
   *   confirm_delivery → /v1/partner/orders/by-external-id/:id then
   *                      /v1/partner/orders/{floatra_loan_id}/confirm-delivery
   *   cancel_order     → same lookup, then /v1/partner/orders/{loan_id}/cancel
   *
   * Returns whatever the gateway returns. Any error (including a
   * 404 from the lookup) propagates so the caller can decide how to
   * surface it.
   */
  private async routeAction(
    config: FloatraAdapterConfig,
    translation: TranslationResult,
  ): Promise<{ status: number; body: unknown }> {
    const externalOrderId = translation.payload.external_order_id;
    switch (translation.action) {
      case 'initiate_order':
        return this.floatra.initiateOrder(config, translation.payload);

      case 'confirm_delivery': {
        const lookup = await this.floatra.lookupOrderByExternalId(
          config,
          externalOrderId,
        );
        if (!lookup || !lookup.floatra_loan_id) {
          throw new FloatraApiError(
            404,
            { error: 'ORDER_NOT_FOUND' },
            `No loan for external_order_id "${externalOrderId}"`,
          );
        }
        const idempotencyKey = `${externalOrderId}:confirm`;
        return this.floatra.confirmDelivery(
          config,
          lookup.floatra_loan_id,
          { delivered_at: new Date().toISOString() },
          idempotencyKey,
        );
      }

      case 'cancel_order': {
        const lookup = await this.floatra.lookupOrderByExternalId(
          config,
          externalOrderId,
        );
        if (!lookup || !lookup.floatra_loan_id) {
          throw new FloatraApiError(
            404,
            { error: 'ORDER_NOT_FOUND' },
            `No loan for external_order_id "${externalOrderId}"`,
          );
        }
        const idempotencyKey = `${externalOrderId}:cancel`;
        return this.floatra.cancelOrder(
          config,
          lookup.floatra_loan_id,
          {
            // The ERP doesn't tell us who cancelled or why; defaults
            // are conservative. A future enhancement maps ERP-side
            // cancel reasons via a `field_mappings.cancel_reason`
            // config field.
            cancelled_by: 'DISTRIBUTOR',
            reason_code: 'OTHER',
          },
          idempotencyKey,
        );
      }

      // Unreachable: translator only emits these three actions.
      default:
        throw new BadRequestException({
          code: 'ACTION_NOT_IMPLEMENTED',
          message: `Unknown floatra_action "${String((translation as { action: unknown }).action)}"`,
        });
    }
  }

  /**
   * Callback-mode delivery: POST the Floatra decision envelope to
   * `inbound.callback_url`. Authenticated using the same `outbound.erp_auth`
   * config the regular outbound webhooks use — the callback IS just
   * another outbound POST to the ERP.
   *
   * Body shape includes the original external_order_id so the ERP can
   * correlate the async response to the request it made.
   */
  private async fireCallback(
    config: FloatraAdapterConfig,
    translation: TranslationResult,
    gatewayResp: { status: number; body: unknown },
  ): Promise<void> {
    const callbackUrl = config.inbound.callback_url;
    if (!callbackUrl) {
      // Validator should have caught this at boot, but defensive.
      this.logger.warn(
        `Platform ${config.platform_id}: response_mode=callback but no callback_url configured`,
      );
      return;
    }
    const body = {
      external_order_id: translation.payload.external_order_id,
      action: translation.action,
      gateway_status: gatewayResp.status,
      decision: gatewayResp.body,
      delivered_at: new Date().toISOString(),
    };
    await this.erpDelivery.deliverToUrl(
      callbackUrl,
      config.outbound.erp_auth,
      body,
    );
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private verifyInboundAuth(
    auth: { type: string; [k: string]: unknown },
    headers: Record<string, string>,
    req: Request & { rawBody?: Buffer },
  ): void {
    if (auth.type === 'none') return;
    if (auth.type === 'api_key') {
      const name = (auth.header_name as string).toLowerCase();
      const expected = auth.api_key as string;
      const actual = headers[name];
      // G-1: constant-time compare — a plain !== leaks the secret via a
      // timing side-channel. Mirrors the HMAC path's timingSafeEqual.
      if (!actual || !constantTimeEqual(actual, expected)) {
        throw new ForbiddenException({
          code: 'INBOUND_AUTH_FAILED',
          message: `Header ${name} missing or invalid`,
        });
      }
      return;
    }
    if (auth.type === 'basic') {
      const value = headers['authorization'];
      if (!value || !value.startsWith('Basic ')) {
        throw new ForbiddenException({
          code: 'INBOUND_AUTH_FAILED',
          message: 'Basic auth header missing',
        });
      }
      const expected = Buffer.from(
        `${auth.username as string}:${auth.password as string}`,
      ).toString('base64');
      // G-1: constant-time compare (see api_key branch above).
      if (!constantTimeEqual(value.slice(6), expected)) {
        throw new ForbiddenException({
          code: 'INBOUND_AUTH_FAILED',
          message: 'Basic auth credentials invalid',
        });
      }
      return;
    }
    if (auth.type === 'hmac') {
      const headerName = (auth.hmac_header as string).toLowerCase();
      const secret = auth.hmac_secret as string;
      if (!secret) {
        // Validator catches this at startup, but defensive — refuse
        // to silently accept HMAC requests with no secret configured.
        throw new ForbiddenException({
          code: 'INBOUND_AUTH_FAILED',
          message: 'hmac_secret is not configured for this platform',
        });
      }
      const signature = headers[headerName];
      if (!signature) {
        throw new ForbiddenException({
          code: 'INBOUND_AUTH_FAILED',
          message: `HMAC header ${headerName} missing`,
        });
      }
      const raw = req.rawBody;
      if (!raw) {
        // main.ts wires raw-body capture globally; if this fires
        // something has gone wrong with bootstrap order.
        this.logger.error(
          'HMAC inbound auth: req.rawBody not captured — check main.ts bootstrap',
        );
        throw new ForbiddenException({
          code: 'INBOUND_AUTH_FAILED',
          message: 'HMAC verification unavailable (raw body missing)',
        });
      }
      if (!verifyInboundHmac(raw, signature, secret)) {
        throw new ForbiddenException({
          code: 'INBOUND_AUTH_FAILED',
          message: 'HMAC signature did not match',
        });
      }
      return;
    }
    throw new ForbiddenException({
      code: 'INBOUND_AUTH_FAILED',
      message: `Unknown inbound auth type: ${auth.type}`,
    });
  }

  private handleFallback(
    config: ReturnType<ConfigLoaderService['getByPlatform']>,
    translation: { triggerName: string; action: string },
    err: FloatraApiError,
    res: Response,
    externalOrderId: string,
  ): void {
    if (!config) return;
    const envOverride =
      process.env.ALLOW_FALLBACK_ON_CREDIT_OVERRIDE === 'true';
    const timestamp = new Date().toISOString();
    const baseAudit = {
      platformId: config.platform_id,
      externalOrderId,
      floatraStatus: err.status,
      envOverrideEnabled: envOverride,
      timestamp,
    };

    if (config.unavailability_fallback === 'BLOCK_CREDIT_ORDERS') {
      this.logger.error(
        `Floatra unavailable (status=${err.status}); blocking credit order for platform=${config.platform_id}`,
      );
      // P1-20: persisted audit even on the safe-path decision so ops
      // can correlate spikes in gateway downtime with order rejections.
      this.fallbackAudit.record({
        ...baseAudit,
        fallbackDecision: 'BLOCKED',
      });
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        code: 'FLOATRA_UNAVAILABLE',
        message: 'Credit unavailable — order rejected',
        floatra_status: err.status,
      });
      return;
    }
    // ALLOW_ON_CREDIT — defence-in-depth: env override required.
    if (!envOverride) {
      this.logger.error(
        `unavailability_fallback=ALLOW_ON_CREDIT set in config but ALLOW_FALLBACK_ON_CREDIT_OVERRIDE env var not enabled; blocking instead`,
      );
      this.fallbackAudit.record({
        ...baseAudit,
        fallbackDecision: 'BLOCKED_NO_OVERRIDE',
      });
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        code: 'FLOATRA_UNAVAILABLE',
        message: 'Credit unavailable and fallback override not enabled',
      });
      return;
    }
    this.logger.warn(
      `Floatra unavailable; allowing order on distributor credit for platform=${config.platform_id}`,
    );
    // P1-20: the high-impact path. Every ALLOWED_ON_DISTRIBUTOR_CREDIT
    // decision shifts loss exposure from Floatra to the distributor,
    // so this audit row is the legal record that ops will reach for
    // in a post-incident review.
    this.fallbackAudit.record({
      ...baseAudit,
      fallbackDecision: 'ALLOWED_ON_DISTRIBUTOR_CREDIT',
    });
    res.status(HttpStatus.OK).json({
      decision: 'ALLOWED_ON_DISTRIBUTOR_CREDIT',
      message:
        'Floatra gateway unavailable — order proceeds on distributor credit terms',
      _unused_translation: translation,
    });
  }
}
