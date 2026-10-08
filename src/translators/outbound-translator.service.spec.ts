import {
  OutboundTranslatorService,
  OutboundTranslationError,
} from './outbound-translator.service';
import type {
  FloatraAdapterConfig,
  FloatraWebhookEvent,
} from '../config/config.types';
import type { ErpDeliveryService } from '../erp/erp-delivery.service';

/**
 * P2-24 slice G: coverage for the outbound translator — Floatra
 * → ERP webhook fan-out for the generic REST adapter.
 *
 * Load-bearing contracts:
 *
 *   1. `merchant.reorder_locked` MUST flow through the dedicated
 *      `on_reorder_locked` block with `block_merchant_orders=true`.
 *      The config validator enforces this at startup, but the
 *      translator double-checks — a hot config reload could
 *      otherwise sneak a broken config past.
 *   2. `merchant.reorder_unlocked` is *optional* — drop with a
 *      WARN rather than throw, since unlock without a config is
 *      annoying but not financially dangerous.
 *   3. Unknown event_type → log+drop. Throwing would 5xx every
 *      unsubscribed event the gateway forwards.
 *   4. Generic mapped event → builds the body using event_mappings,
 *      preserves event_id / occurred_at, wraps `update_fields`
 *      into a nested object, and threads `trigger_action`.
 */

function baseConfig(
  overrides: Partial<FloatraAdapterConfig['outbound']> = {},
): FloatraAdapterConfig {
  return {
    erp_type: 'generic',
    platform_id: 'plt_test',
    api_key: 'k',
    webhook_secret: 's',
    floatra_gateway_url: 'https://gateway.test',
    inbound: {} as never,
    outbound: {
      erp_webhook_url: 'https://erp.test/hook',
      erp_auth: { type: 'none' },
      event_mappings: {},
      on_reorder_locked: {
        block_merchant_orders: true,
        update_merchant_field: 'credit_status',
        update_merchant_value: 'locked',
      },
      on_reorder_unlocked: {
        unblock_merchant_orders: true,
        update_merchant_field: 'credit_status',
        update_merchant_value: 'active',
      },
      ...overrides,
    },
    unavailability_fallback: 'BLOCK_CREDIT_ORDERS',
  };
}

function baseEvent(
  overrides: Partial<FloatraWebhookEvent> = {},
): FloatraWebhookEvent {
  return {
    event_id: 'evt-1',
    event_type: 'order.credit_approved',
    occurred_at: '2026-06-01T08:00:00.000Z',
    data: {},
    ...overrides,
  };
}

describe('OutboundTranslatorService', () => {
  function build() {
    const delivery = { deliver: jest.fn().mockResolvedValue(undefined) };
    const service = new OutboundTranslatorService(
      delivery as unknown as ErpDeliveryService,
    );
    return { service, delivery };
  }

  describe('merchant.reorder_locked', () => {
    it('delivers the spec-shaped body when on_reorder_locked is configured', async () => {
      const { service, delivery } = build();
      const event = baseEvent({
        event_id: 'evt-lock',
        event_type: 'merchant.reorder_locked',
        data: { merchant_id: 'm-1' },
      });
      await service.translateAndDeliver(event, baseConfig());
      expect(delivery.deliver).toHaveBeenCalledTimes(1);
      const body = delivery.deliver.mock.calls[0][1];
      expect(body.event_id).toBe('evt-lock');
      expect(body.event_name).toBe('merchant.reorder_locked');
      expect(body.block_merchant_orders).toBe(true);
      expect(body.update).toEqual({
        field: 'credit_status',
        value: 'locked',
      });
      // Raw event data is forwarded so the ERP can inspect merchant_id.
      expect(body.data).toEqual({ merchant_id: 'm-1' });
    });

    it("names the ERP's own customer id (merchantExternalId) so the ERP knows WHICH customer to block", async () => {
      const { service, delivery } = build();
      await service.translateAndDeliver(
        baseEvent({
          event_type: 'merchant.reorder_locked',
          data: { merchantId: 'mer_01', merchantExternalId: 'CUST-77' },
        }),
        baseConfig(),
      );
      expect(delivery.deliver.mock.calls[0][1].merchant_external_id).toBe(
        'CUST-77',
      );
    });

    it('sends merchant_external_id: null when core has no external id (absent or non-string)', async () => {
      const { service, delivery } = build();
      await service.translateAndDeliver(
        baseEvent({ event_type: 'merchant.reorder_locked', data: {} }),
        baseConfig(),
      );
      await service.translateAndDeliver(
        baseEvent({
          event_type: 'merchant.reorder_locked',
          data: { merchantExternalId: 77 },
        }),
        baseConfig(),
      );
      expect(delivery.deliver.mock.calls[0][1].merchant_external_id).toBeNull();
      expect(delivery.deliver.mock.calls[1][1].merchant_external_id).toBeNull();
    });

    it('THROWS OutboundTranslationError when block_merchant_orders is not true (belt-and-braces)', async () => {
      const { service, delivery } = build();
      const event = baseEvent({ event_type: 'merchant.reorder_locked' });
      const config = baseConfig({
        on_reorder_locked: {
          block_merchant_orders: false as unknown as true,
          update_merchant_field: 'x',
          update_merchant_value: 'y',
        },
      });
      await expect(
        service.translateAndDeliver(event, config),
      ).rejects.toBeInstanceOf(OutboundTranslationError);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });
  });

  describe('merchant.reorder_unlocked', () => {
    it('delivers the spec-shaped body when on_reorder_unlocked is configured', async () => {
      const { service, delivery } = build();
      const event = baseEvent({
        event_id: 'evt-unlock',
        event_type: 'merchant.reorder_unlocked',
      });
      await service.translateAndDeliver(event, baseConfig());
      const body = delivery.deliver.mock.calls[0][1];
      expect(body.event_name).toBe('merchant.reorder_unlocked');
      expect(body.unblock_merchant_orders).toBe(true);
      expect(body.update).toEqual({
        field: 'credit_status',
        value: 'active',
      });
    });

    it("names the ERP's own customer id (merchantExternalId) so the ERP knows WHICH customer to unblock", async () => {
      const { service, delivery } = build();
      await service.translateAndDeliver(
        baseEvent({
          event_type: 'merchant.reorder_unlocked',
          data: { merchantId: 'mer_01', merchantExternalId: 'CUST-77' },
        }),
        baseConfig(),
      );
      expect(delivery.deliver.mock.calls[0][1].merchant_external_id).toBe(
        'CUST-77',
      );
    });

    it('sends merchant_external_id: null on unlock when core has no external id', async () => {
      const { service, delivery } = build();
      await service.translateAndDeliver(
        baseEvent({ event_type: 'merchant.reorder_unlocked', data: {} }),
        baseConfig(),
      );
      expect(delivery.deliver.mock.calls[0][1].merchant_external_id).toBeNull();
    });

    it('DROPS the event with a warning when on_reorder_unlocked is missing (annoying but not dangerous)', async () => {
      const { service, delivery } = build();
      const config = baseConfig();
      // Force unset by casting through unknown.
      (
        config.outbound as unknown as { on_reorder_unlocked: unknown }
      ).on_reorder_unlocked = undefined;
      await service.translateAndDeliver(
        baseEvent({ event_type: 'merchant.reorder_unlocked' }),
        config,
      );
      expect(delivery.deliver).not.toHaveBeenCalled();
    });
  });

  describe('generic event_mappings path', () => {
    it('drops + warns when no mapping exists for the event_type (no 500 on unsubscribed events)', async () => {
      const { service, delivery } = build();
      await service.translateAndDeliver(
        baseEvent({ event_type: 'order.never.mapped' }),
        baseConfig(),
      );
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('translates field_mappings via JSONPath into the body', async () => {
      const { service, delivery } = build();
      const event = baseEvent({
        event_type: 'order.credit_approved',
        data: { merchant_id: 'm-1', amount_ngn: 50000 },
      });
      const config = baseConfig({
        event_mappings: {
          'order.credit_approved': {
            erp_event_name: 'erp.credit.ok',
            field_mappings: {
              merchant_external_id: '$.data.merchant_id',
              approved_amount: '$.data.amount_ngn',
            },
          },
        },
      });
      await service.translateAndDeliver(event, config);
      const body = delivery.deliver.mock.calls[0][1];
      expect(body.event_id).toBe('evt-1');
      expect(body.event_name).toBe('erp.credit.ok');
      expect(body.occurred_at).toBe('2026-06-01T08:00:00.000Z');
      expect(body.merchant_external_id).toBe('m-1');
      expect(body.approved_amount).toBe(50000);
    });

    it('omits a mapped field from the ERP body when core sent no such field (e.g. externalOrderId on a checkout loan)', async () => {
      const { service, delivery } = build();
      const config = baseConfig({
        event_mappings: {
          'order.disbursed': {
            erp_event_name: 'erp.disbursed',
            field_mappings: {
              sales_order_id: '$.data.externalOrderId',
              loan_id: '$.data.loanId',
            },
          },
        },
      });
      await service.translateAndDeliver(
        baseEvent({ event_type: 'order.disbursed', data: { loanId: 'l-1' } }),
        config,
      );
      // What actually goes on the wire: the body is JSON-serialised, so an
      // unmatched JSONPath (undefined) drops the key rather than sending null.
      const wire = JSON.parse(
        JSON.stringify(delivery.deliver.mock.calls[0][1]),
      ) as Record<string, unknown>;
      expect(wire.loan_id).toBe('l-1');
      expect(wire).not.toHaveProperty('sales_order_id');
    });

    it('wraps update_fields entries into a nested `update_fields` object', async () => {
      const { service, delivery } = build();
      const event = baseEvent({
        event_type: 'order.credit_approved',
        data: { merchant_id: 'm-1', tier: 'T2' },
      });
      const config = baseConfig({
        event_mappings: {
          'order.credit_approved': {
            erp_event_name: 'erp.credit.ok',
            field_mappings: {},
            update_fields: [
              { erp_field: 'tier_at_approval', floatra_field: '$.data.tier' },
            ],
          },
        },
      });
      await service.translateAndDeliver(event, config);
      const body = delivery.deliver.mock.calls[0][1];
      expect(body.update_fields).toEqual({ tier_at_approval: 'T2' });
    });

    it('threads trigger_action onto the body when set on the mapping', async () => {
      const { service, delivery } = build();
      const event = baseEvent({ event_type: 'order.credit_approved' });
      const config = baseConfig({
        event_mappings: {
          'order.credit_approved': {
            erp_event_name: 'erp.credit.ok',
            field_mappings: {},
            trigger_action: 'release_hold',
          },
        },
      });
      await service.translateAndDeliver(event, config);
      const body = delivery.deliver.mock.calls[0][1];
      expect(body.trigger_action).toBe('release_hold');
    });

    it('omits trigger_action from the body when not configured', async () => {
      const { service, delivery } = build();
      const event = baseEvent({ event_type: 'order.credit_approved' });
      const config = baseConfig({
        event_mappings: {
          'order.credit_approved': {
            erp_event_name: 'erp.credit.ok',
            field_mappings: {},
          },
        },
      });
      await service.translateAndDeliver(event, config);
      const body = delivery.deliver.mock.calls[0][1];
      expect('trigger_action' in body).toBe(false);
    });
  });
});
