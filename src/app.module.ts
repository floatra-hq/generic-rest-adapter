import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisModule } from './common/redis.module';
import { ConfigLoaderService } from './config/config-loader.service';
import { ConfigValidatorService } from './config/config-validator.service';
import { InboundTranslatorService } from './translators/inbound-translator.service';
import { OutboundTranslatorService } from './translators/outbound-translator.service';
import { FloatraApiClient } from './floatra/floatra-api.client';
import { ErpDeliveryService } from './erp/erp-delivery.service';
import { OutboundRateLimiterService } from './erp/outbound-rate-limiter.service';
import { EventDedupService } from './webhook/event-dedup.service';
import { FallbackAuditService } from './audit/fallback-audit.service';
import { UndeliveredWebhookPoller } from './scheduler/undelivered-webhook.poller';
import { InboundController } from './controllers/inbound.controller';
import { FloatraWebhookController } from './controllers/floatra-webhook.controller';
import { HealthController } from './controllers/health.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), RedisModule],
  controllers: [InboundController, FloatraWebhookController, HealthController],
  providers: [
    ConfigValidatorService,
    ConfigLoaderService,
    InboundTranslatorService,
    OutboundTranslatorService,
    FloatraApiClient,
    OutboundRateLimiterService,
    ErpDeliveryService,
    EventDedupService,
    FallbackAuditService,
    UndeliveredWebhookPoller,
  ],
})
export class AppModule {}
