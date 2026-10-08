import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ConfigLoaderService } from '../config/config-loader.service';
import {
  FloatraApiClient,
  FloatraApiError,
  UndeliveredWebhook,
} from '../floatra/floatra-api.client';
import { OutboundTranslatorService } from '../translators/outbound-translator.service';
import { EventDedupService } from '../webhook/event-dedup.service';
import { FloatraAdapterConfig } from '../config/config.types';
import { toWebhookEvent } from '../webhook/webhook-event';
import { REDIS_CLIENT } from '../common/redis.module';

/**
 * P2-18 / Spec §6.4 — asymmetric polling fallback.
 *
 * Floatra's outbound webhook retry budget is 5 attempts spread
 * over ~6h. If the adapter is down the whole window, the gateway
 * marks the delivery FAILED / DEAD_LETTER and stops trying. This
 * poller pulls those events back, replays them through the same
 * outbound translator the live receiver uses, then ACKs the
 * gateway so the event leaves the undelivered queue.
 *
 * Cadence: every 15 minutes (configurable via
 * UNDELIVERED_POLL_INTERVAL_MIN env, range [1, 60]). Long enough
 * that we don't hammer the gateway when there's nothing pending;
 * short enough that a recovered adapter catches up within the
 * gateway's 6h retry window.
 *
 * Multi-instance safe: a Redis SET NX EX lock per platform is
 * acquired before each poll cycle. Two adapter pods configured
 * for the same platform_id will not double-replay events. The
 * lock TTL exceeds the poll budget so a crashed worker doesn't
 * starve the next cycle.
 *
 * Dedup: replays first check EventDedupService — if the live
 * receiver already processed the event (eg. webhook arrived a
 * second before the scheduler picked it up), the poller ACKs
 * and skips. This is the same dedup the live POST handler uses.
 *
 * Pagination: pulls up to MAX_PER_CYCLE per platform per cycle.
 * Bounded so a 10k-deep backlog doesn't pin a single platform's
 * cycle for hours.
 */
const POLL_LOCK_TTL_SECONDS = 5 * 60; // 5 min — covers slow gateways
const PAGE_SIZE = 50;
const MAX_PER_CYCLE = 200;
const DEFAULT_INTERVAL_MIN = 15;
const MIN_INTERVAL_MIN = 1;
const MAX_INTERVAL_MIN = 60;

@Injectable()
export class UndeliveredWebhookPoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UndeliveredWebhookPoller.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly env: ConfigService,
    private readonly loader: ConfigLoaderService,
    private readonly floatra: FloatraApiClient,
    private readonly translator: OutboundTranslatorService,
    private readonly dedup: EventDedupService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    if (this.env.get<string>('NODE_ENV') === 'test') {
      // Don't auto-schedule in unit tests — they exercise pollOnce()
      // directly. Behaviour gate, not a feature flag.
      return;
    }
    const intervalMs = this.resolveIntervalMs();
    this.timer = setInterval(() => {
      void this.pollOnce().catch((err) => {
        // Defensive — pollOnce() catches its own per-platform
        // errors; a throw at this level means a programming bug.
        this.logger.error(
          `Undelivered poller crashed: ${err instanceof Error ? err.message : err}`,
        );
      });
    }, intervalMs);
    // Don't keep the event loop alive just for the timer.
    this.timer.unref?.();
    this.logger.log(
      `Undelivered-webhook poller scheduled (every ${intervalMs / 60_000} min)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Sweep every loaded platform once. Per-platform errors are
   * logged + swallowed so one broken config doesn't poison the
   * cycle for the rest.
   */
  async pollOnce(): Promise<{ platforms: number; replayed: number }> {
    if (this.running) {
      // Skip overlapping ticks — if a cycle takes longer than the
      // interval (heavy backlog), don't pile up.
      this.logger.debug(
        'Undelivered poller already running — skipping this tick',
      );
      return { platforms: 0, replayed: 0 };
    }
    this.running = true;
    let replayed = 0;
    let platforms = 0;
    try {
      for (const platformId of this.loader.listPlatformIds()) {
        const config = this.loader.getByPlatform(platformId);
        if (!config) continue;
        platforms++;
        try {
          replayed += await this.processPlatform(config);
        } catch (err) {
          this.logger.warn(
            `Undelivered poll failed for platform ${platformId}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    } finally {
      this.running = false;
    }
    if (replayed > 0 || platforms > 0) {
      this.logger.log(
        `Undelivered poll cycle: scanned ${platforms} platform(s), ` +
          `replayed ${replayed} event(s)`,
      );
    }
    return { platforms, replayed };
  }

  private async processPlatform(config: FloatraAdapterConfig): Promise<number> {
    if (!(await this.acquireLock(config.platform_id))) {
      this.logger.debug(
        `Poll lock held by peer for platform ${config.platform_id} — skipping`,
      );
      return 0;
    }

    let offset = 0;
    let replayed = 0;
    let scanned = 0;
    try {
      while (scanned < MAX_PER_CYCLE) {
        const page = await this.floatra.listUndelivered(config, {
          limit: PAGE_SIZE,
          offset,
        });
        if (page.data.length === 0) break;

        for (const event of page.data) {
          scanned++;
          const ok = await this.replayOne(config, event);
          if (ok) replayed++;
        }

        if (!page.has_more) break;
        offset += page.data.length;
      }
    } finally {
      await this.releaseLock(config.platform_id);
    }
    return replayed;
  }

  private async replayOne(
    config: FloatraAdapterConfig,
    event: UndeliveredWebhook,
  ): Promise<boolean> {
    // Spec §4.1 dedup — if the live receiver already routed this
    // event (race against the poll cycle), short-circuit and ACK
    // so the gateway stops listing it. We re-claim the dedup key
    // to mark this poll's handling.
    const isDup = await this.dedup.isDuplicate(event.event_id);
    if (isDup) {
      await this.tryAck(config, event.event_id);
      return false;
    }

    const envelope = toWebhookEvent(
      event.event_id,
      event.payload ?? {},
      event.event_type,
    );

    try {
      await this.translator.translateAndDeliver(envelope, config);
    } catch (err) {
      // Release the dedup claim so the next tick (or a live
      // delivery) can re-try. Without this, a transient ERP
      // failure pins the event-id as "seen" for 24h and the
      // gateway keeps listing it.
      await this.dedup.release(event.event_id);
      this.logger.warn(
        `Replay failed for platform ${config.platform_id} event ` +
          `${event.event_id} (${event.event_type}): ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return false;
    }

    await this.tryAck(config, event.event_id);
    return true;
  }

  private async tryAck(
    config: FloatraAdapterConfig,
    eventId: string,
  ): Promise<void> {
    try {
      await this.floatra.acknowledgeWebhook(config, eventId);
    } catch (err) {
      // ACK failure isn't fatal — the gateway's idempotent endpoint
      // will accept the next attempt, and the event re-listing
      // costs the partner a duplicate replay (dedup catches it).
      if (err instanceof FloatraApiError && err.status === 404) {
        // Already acknowledged from another path. Log + move on.
        this.logger.debug(
          `ACK 404 for event ${eventId} on platform ${config.platform_id} (already acked)`,
        );
        return;
      }
      this.logger.warn(
        `ACK failed for event ${eventId} on platform ${config.platform_id}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private async acquireLock(platformId: string): Promise<boolean> {
    const key = this.lockKey(platformId);
    const res = await this.redis.set(
      key,
      '1',
      'EX',
      POLL_LOCK_TTL_SECONDS,
      'NX',
    );
    return res === 'OK';
  }

  private async releaseLock(platformId: string): Promise<void> {
    await this.redis.del(this.lockKey(platformId));
  }

  private lockKey(platformId: string): string {
    return `floatra:adapter:undelivered:lock:${platformId}`;
  }

  private resolveIntervalMs(): number {
    const raw = this.env.get<string>('UNDELIVERED_POLL_INTERVAL_MIN');
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    let minutes = Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MIN;
    if (minutes < MIN_INTERVAL_MIN) minutes = MIN_INTERVAL_MIN;
    if (minutes > MAX_INTERVAL_MIN) minutes = MAX_INTERVAL_MIN;
    return minutes * 60_000;
  }
}
