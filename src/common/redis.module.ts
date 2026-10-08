import {
  Global,
  Inject,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Single ioredis client shared across the adapter. Currently used
 * for two webhook-receiver guarantees Spec v3.1 §4.1 + §4.2
 * mandate:
 *
 *   - X-Floatra-Event-ID dedup (P0-10) — SETNX with 24h TTL so a
 *     retried `merchant.reorder_locked` doesn't fan out to the ERP
 *     twice
 *   - Timestamp replay-window enforcement (P0-9) — purely
 *     in-memory at the verifier level, but Redis keeps the dedup
 *     consistent across multi-instance deployments
 *
 * Same lazy-connect pattern as the WhatsApp gateway: onModuleInit
 * awaits a single connect() so request-time code can assume the
 * client is ready.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService) => {
        const logger = new Logger('RedisModule');
        const url = config.get<string>('REDIS_URL');
        if (!url) {
          logger.warn(
            'REDIS_URL not set; defaulting to redis://localhost:6379',
          );
        }
        return new Redis(url ?? 'redis://localhost:6379', {
          lazyConnect: true,
          connectTimeout: 10_000,
          maxRetriesPerRequest: 3,
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.redis.connect();
      this.logger.log('Redis connected');
    } catch (err) {
      this.logger.error(
        `Redis connect failed: ${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
