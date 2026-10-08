import { Injectable, Logger } from '@nestjs/common';
import {
  FloatraAdapterConfig,
  FloatraWebhookEvent,
} from '../config/config.types';
import { extractFirst } from './jsonpath.util';
import { ErpDeliveryService } from '../erp/erp-delivery.service';

export class OutboundTranslationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Translates an inbound Floatra webhook event into the ERP's native
 * shape using `outbound.event_mappings[<event_type>]` and POSTs it
 * to the ERP webhook URL via ErpDeliveryService.
 *
 * Critical: the `merchant.reorder_locked` event MUST flow through
 * `on_reorder_locked` — the config validator already enforces
 * `block_merchant_orders === true`, but the translator double-checks
 * here so a future config reload can't sneak it past.
 */
@Injectable()
export class OutboundTranslatorService {
  private readonly logger = new Logger(OutboundTranslatorService.name);

  constructor(private readonly delivery: ErpDeliveryService) {}

  async translateAndDeliver(
    event: FloatraWebhookEvent,
    config: FloatraAdapterConfig,
  ): Promise<void> {
    // Special-case the reorder lock events — they have dedicated
    // config blocks with stronger guarantees than the generic
    // event_mappings entries.
    if (event.event_type === 'merchant.reorder_locked') {
      await this.handleReorderLocked(event, config);
      return;
    }
    if (event.event_type === 'merchant.reorder_unlocked') {
      await this.handleReorderUnlocked(event, config);
      return;
    }

    const mapping = config.outbound.event_mappings[event.event_type];
    if (!mapping) {
      // Not configured — log + drop. Better than 500-ing on every
      // unsubscribed event the gateway forwards.
      this.logger.warn(
        `No outbound mapping for event_type "${event.event_type}" on platform ${config.platform_id} — dropping`,
      );
      return;
    }

    const body: Record<string, unknown> = {
      event_id: event.event_id,
      event_name: mapping.erp_event_name,
      occurred_at: event.occurred_at,
    };

    for (const [erpField, jsonPath] of Object.entries(mapping.field_mappings)) {
      body[erpField] = extractFirst(jsonPath, event);
    }

    if (mapping.update_fields) {
      const updates: Record<string, unknown> = {};
      for (const u of mapping.update_fields) {
        updates[u.erp_field] = extractFirst(u.floatra_field, event);
      }
      body.update_fields = updates;
    }

    if (mapping.trigger_action) {
      body.trigger_action = mapping.trigger_action;
    }

    await this.delivery.deliver(config, body);
  }

  // ----------------------------------------------------------------
  // Specials
  // ----------------------------------------------------------------

  private async handleReorderLocked(
    event: FloatraWebhookEvent,
    config: FloatraAdapterConfig,
  ): Promise<void> {
    const lock = config.outbound.on_reorder_locked;
    if (!lock || lock.block_merchant_orders !== true) {
      // Validator should have caught this at startup. Belt-and-braces.
      throw new OutboundTranslationError(
        'REORDER_LOCK_MISCONFIGURED',
        `Platform ${config.platform_id} reorder-lock config invalid — refusing to deliver event`,
      );
    }
    const body: Record<string, unknown> = {
      event_id: event.event_id,
      event_name: 'merchant.reorder_locked',
      occurred_at: event.occurred_at,
      data: event.data,
      block_merchant_orders: true,
      merchant_external_id:
        typeof event.data.merchantExternalId === 'string'
          ? event.data.merchantExternalId
          : null,
      update: {
        field: lock.update_merchant_field,
        value: lock.update_merchant_value,
      },
    };
    await this.delivery.deliver(config, body);
  }

  private async handleReorderUnlocked(
    event: FloatraWebhookEvent,
    config: FloatraAdapterConfig,
  ): Promise<void> {
    const unlock = config.outbound.on_reorder_unlocked;
    if (!unlock) {
      this.logger.warn(
        `Platform ${config.platform_id} has no on_reorder_unlocked config — dropping unlock event`,
      );
      return;
    }
    const body: Record<string, unknown> = {
      event_id: event.event_id,
      event_name: 'merchant.reorder_unlocked',
      occurred_at: event.occurred_at,
      data: event.data,
      unblock_merchant_orders: unlock.unblock_merchant_orders,
      merchant_external_id:
        typeof event.data.merchantExternalId === 'string'
          ? event.data.merchantExternalId
          : null,
      update: {
        field: unlock.update_merchant_field,
        value: unlock.update_merchant_value,
      },
    };
    await this.delivery.deliver(config, body);
  }
}
