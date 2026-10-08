import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis.module';

/**
 * P2-17: outbound rate limit when POSTing to an ERP's webhook URL.
 *
 * Fixed-window per-minute counter, keyed per `platform_id`. The
 * window is the calendar UTC minute; each acquire() Redis-INCRs
 * the slot and (on first hit) sets a 60s TTL. If the slot is over
 * the configured limit, the caller sleeps until the next window
 * — bounded by `MAX_WAIT_MS` so a misconfigured limit (e.g. 1
 * req/min against a 200-event batch) doesn't hold a request
 * forever.
 *
 * Why fixed-window vs token bucket: distributor-friendly. The
 * config field is "requests per minute" — exactly what the limiter
 * enforces, no leaky-bucket math the partner has to reason about.
 * Burstiness is acceptable for ERP webhooks (each is independent;
 * no per-request side effects to coordinate).
 *
 * Multi-instance safe: the bucket lives in Redis, so two adapter
 * pods sharing the same `platform_id` config share the budget.
 */
const MAX_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

@Injectable()
export class OutboundRateLimiterService {
  private readonly logger = new Logger(OutboundRateLimiterService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Block until the caller has a slot under the per-minute limit
   * for `platformId`. Returns nothing on success, throws on timeout.
   *
   * When `ratePerMinute` is undefined or <= 0, no-ops immediately
   * — the field is optional and defaults to "no shaping".
   */
  async acquire(
    platformId: string,
    ratePerMinute: number | undefined,
  ): Promise<void> {
    if (!ratePerMinute || ratePerMinute <= 0) return;

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const key = this.bucketKey(platformId, Math.floor(Date.now() / 60_000));
      const used = await this.redis.incr(key);
      if (used === 1) {
        // First hit of this minute — claim the TTL. INCR + EXPIRE
        // is not atomic but EXPIRE on the second-and-later caller
        // is a no-op (Redis sets TTL even when it already exists,
        // but the value here is the same 60s, so it's idempotent).
        await this.redis.expire(key, 60);
      }
      if (used <= ratePerMinute) return;

      // Over budget. Roll back our claim so a slow-but-rare burst
      // doesn't keep the counter pinned above the limit — DECR is
      // safe because we just INCR'd.
      await this.redis.decr(key);

      // Sleep a short interval and re-check. Picking up between
      // calls is intentional — multiple waiters race for the next
      // slot fairly without per-platform queuing infrastructure.
      const remaining = deadline - Date.now();
      await this.sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, remaining)));
    }

    throw new Error(
      `Outbound rate limit exceeded for platform ${platformId} after ` +
        `${MAX_WAIT_MS}ms wait (limit=${ratePerMinute}/min)`,
    );
  }

  private bucketKey(platformId: string, minute: number): string {
    return `floatra:adapter:outbound:rate:${platformId}:${minute}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
