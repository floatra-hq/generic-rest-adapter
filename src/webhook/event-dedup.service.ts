import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis.module';

const DEDUP_TTL_SECONDS = 24 * 60 * 60; // Spec §4.1: 24-hour retention
const dedupKey = (eventId: string): string => `floatra_evt:${eventId}`;

/**
 * X-Floatra-Event-ID dedup (P0-10 / Spec §4.1).
 *
 * Floatra retries outbound webhooks on 5xx with the spec schedule
 * (1m / 5m / 15m / 1h / 4h). Each retry carries the same
 * X-Floatra-Event-ID. Without server-side dedup, a retried
 * `merchant.reorder_locked` is forwarded to the partner ERP twice
 * — which the ERP MAY or MAY NOT handle idempotently.
 *
 * SETNX-style claim with a 24h TTL. Returns true iff the event has
 * already been processed (skip), false otherwise (process + the
 * key is now claimed).
 */
@Injectable()
export class EventDedupService {
  private readonly logger = new Logger(EventDedupService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async isDuplicate(eventId: string | undefined): Promise<boolean> {
    if (!eventId) return false;
    const claimed = await this.redis.set(
      dedupKey(eventId),
      '1',
      'EX',
      DEDUP_TTL_SECONDS,
      'NX',
    );
    return claimed === null;
  }

  /**
   * Release a previously-claimed event so a subsequent retry can
   * re-attempt processing. Used when downstream processing failed
   * for an internal reason and we want Floatra's next retry to
   * succeed rather than be silently deduped away.
   */
  async release(eventId: string | undefined): Promise<void> {
    if (!eventId) return;
    await this.redis.del(dedupKey(eventId));
  }
}
