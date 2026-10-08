import { InboundController } from './inbound.controller';
import { ConfigLoaderService } from '../config/config-loader.service';
import { InboundTranslatorService } from '../translators/inbound-translator.service';
import { FloatraAdapterConfig } from '../config/config.types';

/**
 * Controller-level integration tests covering the action-routing +
 * callback-mode delivery added in #45 / #46.
 *
 * The pure translator + validator already have rich unit tests.
 * Here we focus on:
 *   - confirm_delivery → lookup-then-confirm sequence
 *   - cancel_order → lookup-then-cancel sequence
 *   - 404 from the lookup surfaces gracefully (no orphan confirm)
 *   - callback-mode: 202 to ERP + async POST to callback_url
 */

function baseConfig(
  overrides: Partial<FloatraAdapterConfig> = {},
): FloatraAdapterConfig {
  return {
    erp_type: 'SAGE_300',
    platform_id: 'plat_test',
    api_key: 'k',
    webhook_secret: 's',
    floatra_gateway_url: 'https://api.floatra.com/v1/partner',
    unavailability_fallback: 'BLOCK_CREDIT_ORDERS',
    inbound: {
      auth: { type: 'none' },
      field_mappings: {
        external_order_id: '$.OrderId',
        external_merchant_id: '$.CustomerCode',
        amount: '$.Total',
        amount_unit: 'NAIRA',
      },
      category_mappings: { GENERAL: 'OTHER' },
      trigger_events: {
        order_confirmed: {
          condition: "$.Status == 'Delivered'",
          floatra_action: 'confirm_delivery',
        },
      },
      response_mode: 'sync',
    },
    outbound: {
      erp_webhook_url: 'https://erp.example.com/floatra',
      erp_auth: { type: 'none' },
      event_mappings: {},
      on_reorder_locked: {
        block_merchant_orders: true,
        update_merchant_field: 'CreditHold',
        update_merchant_value: true,
      },
      on_reorder_unlocked: {
        unblock_merchant_orders: true,
        update_merchant_field: 'CreditHold',
        update_merchant_value: false,
      },
    },
    ...overrides,
  };
}

function makeRes() {
  const calls: Array<{ status: number; body: unknown }> = [];
  interface FakeRes {
    status(code: number): FakeRes;
    json(b: unknown): FakeRes;
    __pending: number;
    __calls: Array<{ status: number; body: unknown }>;
  }
  const res: FakeRes = {
    status(code: number) {
      this.__pending = code;
      return this;
    },
    json(b: unknown) {
      calls.push({ status: this.__pending ?? 200, body: b });
      return this;
    },
    __pending: 200,
    __calls: calls,
  };
  return res as {
    status: (n: number) => unknown;
    json: (b: unknown) => unknown;
    __calls: Array<{ status: number; body: unknown }>;
  };
}

describe('InboundController', () => {
  let loader: ConfigLoaderService;
  let translator: InboundTranslatorService;
  let floatra: {
    initiateOrder: jest.Mock;
    confirmDelivery: jest.Mock;
    cancelOrder: jest.Mock;
    lookupOrderByExternalId: jest.Mock;
  };
  let erpDelivery: { deliver: jest.Mock; deliverToUrl: jest.Mock };
  let fallbackAudit: { record: jest.Mock; getLogPath: jest.Mock };
  let controller: InboundController;

  // Test config that we can mutate per-test.
  let cfg: FloatraAdapterConfig;

  beforeEach(() => {
    cfg = baseConfig();
    // Wrap a real translator — the test mutates `cfg.inbound.trigger_events`
    // per case to flip the action.
    translator = new InboundTranslatorService();
    loader = {
      getByPlatform: (id: string) => (id === 'plat_test' ? cfg : undefined),
    } as ConfigLoaderService;
    floatra = {
      initiateOrder: jest.fn(),
      confirmDelivery: jest.fn(),
      cancelOrder: jest.fn(),
      lookupOrderByExternalId: jest.fn(),
    };
    erpDelivery = {
      deliver: jest.fn(),
      deliverToUrl: jest.fn().mockResolvedValue({ status: 200, body: {} }),
    };
    fallbackAudit = { record: jest.fn(), getLogPath: jest.fn() };
    controller = new InboundController(
      loader,
      translator,
      floatra as never,
      erpDelivery as never,
      fallbackAudit as never,
    );
  });

  function req(body: Record<string, unknown>): {
    body: Record<string, unknown>;
    rawBody?: Buffer;
    headers: Record<string, string>;
  } {
    return {
      body,
      headers: {},
    };
  }

  // ---- confirm_delivery (#45) ----

  describe('confirm_delivery action', () => {
    it('looks up the Floatra loan id and calls confirm-delivery', async () => {
      cfg.inbound.trigger_events.order_confirmed.floatra_action =
        'confirm_delivery';
      floatra.lookupOrderByExternalId.mockResolvedValueOnce({
        floatra_order_id: 'order-uuid',
        floatra_loan_id: 'loan-uuid',
        loan_status: 'FUNDED',
        due_date: null,
        disbursed_at: null,
      });
      floatra.confirmDelivery.mockResolvedValueOnce({
        status: 200,
        body: { delivered_at: '2026-05-12T00:00:00Z' },
      });

      const r = req({
        OrderId: 'SO-1',
        CustomerCode: 'C-1',
        Total: 50000,
        Status: 'Delivered',
      });
      const res = makeRes();
      await controller.handle(
        'plat_test',
        r.body,
        r.headers,
        r as never,
        res as never,
      );

      expect(floatra.lookupOrderByExternalId).toHaveBeenCalledWith(cfg, 'SO-1');
      expect(floatra.confirmDelivery).toHaveBeenCalledWith(
        cfg,
        'loan-uuid',
        expect.objectContaining({ delivered_at: expect.any(String) }),
        'SO-1:confirm',
      );
      expect(floatra.initiateOrder).not.toHaveBeenCalled();
      expect(res.__calls[0].status).toBe(200);
    });

    it('falls back when lookup returns null (no Floatra loan)', async () => {
      cfg.inbound.trigger_events.order_confirmed.floatra_action =
        'confirm_delivery';
      cfg.unavailability_fallback = 'BLOCK_CREDIT_ORDERS';
      floatra.lookupOrderByExternalId.mockResolvedValueOnce(null);

      const r = req({
        OrderId: 'SO-NEW',
        CustomerCode: 'C-1',
        Total: 50000,
        Status: 'Delivered',
      });
      const res = makeRes();
      await controller.handle(
        'plat_test',
        r.body,
        r.headers,
        r as never,
        res as never,
      );

      expect(floatra.confirmDelivery).not.toHaveBeenCalled();
      // BLOCK_CREDIT_ORDERS fallback → 503 to the ERP
      expect(res.__calls[0].status).toBe(503);
    });

    it('falls back when lookup returns loan_id: null (order created but never funded)', async () => {
      cfg.inbound.trigger_events.order_confirmed.floatra_action =
        'confirm_delivery';
      floatra.lookupOrderByExternalId.mockResolvedValueOnce({
        floatra_order_id: 'order-1',
        floatra_loan_id: null,
        loan_status: null,
        due_date: null,
        disbursed_at: null,
      });

      const r = req({
        OrderId: 'SO-1',
        CustomerCode: 'C-1',
        Total: 50000,
        Status: 'Delivered',
      });
      const res = makeRes();
      await controller.handle(
        'plat_test',
        r.body,
        r.headers,
        r as never,
        res as never,
      );
      expect(floatra.confirmDelivery).not.toHaveBeenCalled();
    });
  });

  // ---- cancel_order (#45) ----

  describe('cancel_order action', () => {
    it('looks up the Floatra loan id and calls cancel with conservative defaults', async () => {
      cfg.inbound.trigger_events.order_confirmed.floatra_action =
        'cancel_order';
      floatra.lookupOrderByExternalId.mockResolvedValueOnce({
        floatra_order_id: 'order-uuid',
        floatra_loan_id: 'loan-uuid',
        loan_status: 'FUNDED',
        due_date: null,
        disbursed_at: null,
      });
      floatra.cancelOrder.mockResolvedValueOnce({
        status: 200,
        body: { cancelled: true },
      });

      const r = req({
        OrderId: 'SO-1',
        CustomerCode: 'C-1',
        Total: 50000,
        Status: 'Delivered',
      });
      const res = makeRes();
      await controller.handle(
        'plat_test',
        r.body,
        r.headers,
        r as never,
        res as never,
      );

      expect(floatra.cancelOrder).toHaveBeenCalledWith(
        cfg,
        'loan-uuid',
        { cancelled_by: 'DISTRIBUTOR', reason_code: 'OTHER' },
        'SO-1:cancel',
      );
      expect(res.__calls[0].status).toBe(200);
    });
  });

  // ---- callback-mode delivery (#46) ----

  describe('callback-mode response delivery', () => {
    it('returns 202 sync AND fires a POST to inbound.callback_url with the decision', async () => {
      cfg.inbound.response_mode = 'callback';
      cfg.inbound.callback_url = 'https://erp.example.com/floatra-callback';
      floatra.initiateOrder.mockResolvedValueOnce({
        status: 200,
        body: { decision: 'APPROVED', floatra_order_id: 'flt-1' },
      });
      // Switch the trigger to initiate_order so the controller calls
      // initiateOrder (which is the common callback-mode case — the
      // ERP can't block on credit-check latency).
      cfg.inbound.trigger_events.order_confirmed.floatra_action =
        'initiate_order';

      const r = req({
        OrderId: 'SO-1',
        CustomerCode: 'C-1',
        Total: 50000,
        Status: 'Delivered',
      });
      const res = makeRes();
      await controller.handle(
        'plat_test',
        r.body,
        r.headers,
        r as never,
        res as never,
      );

      // Sync response is 202 + accepted envelope.
      expect(res.__calls[0]).toEqual({
        status: 202,
        body: { accepted: true },
      });
      // Callback fired. The `fireCallback` is awaited via .catch — we
      // give the microtask queue one tick to settle.
      await new Promise((resolve) => setImmediate(resolve));
      expect(erpDelivery.deliverToUrl).toHaveBeenCalledWith(
        'https://erp.example.com/floatra-callback',
        cfg.outbound.erp_auth,
        expect.objectContaining({
          external_order_id: 'SO-1',
          action: 'initiate_order',
          gateway_status: 200,
          decision: { decision: 'APPROVED', floatra_order_id: 'flt-1' },
        }),
      );
    });

    it('does not crash the request when callback delivery fails (already responded 202)', async () => {
      cfg.inbound.response_mode = 'callback';
      cfg.inbound.callback_url = 'https://erp.example.com/floatra-callback';
      cfg.inbound.trigger_events.order_confirmed.floatra_action =
        'initiate_order';
      floatra.initiateOrder.mockResolvedValueOnce({
        status: 200,
        body: { decision: 'APPROVED' },
      });
      erpDelivery.deliverToUrl.mockRejectedValueOnce(
        new Error('ERP callback URL refused connection'),
      );

      const r = req({
        OrderId: 'SO-1',
        CustomerCode: 'C-1',
        Total: 50000,
        Status: 'Delivered',
      });
      const res = makeRes();
      await expect(
        controller.handle(
          'plat_test',
          r.body,
          r.headers,
          r as never,
          res as never,
        ),
      ).resolves.toBeUndefined();
      expect(res.__calls[0].status).toBe(202);
      // Let the .catch run.
      await new Promise((resolve) => setImmediate(resolve));
      // Test passes if no unhandled rejection.
    });

    it('falls through silently when response_mode=callback but callback_url is unset', async () => {
      cfg.inbound.response_mode = 'callback';
      cfg.inbound.callback_url = undefined;
      cfg.inbound.trigger_events.order_confirmed.floatra_action =
        'initiate_order';
      floatra.initiateOrder.mockResolvedValueOnce({
        status: 200,
        body: { decision: 'APPROVED' },
      });

      const r = req({
        OrderId: 'SO-1',
        CustomerCode: 'C-1',
        Total: 50000,
        Status: 'Delivered',
      });
      const res = makeRes();
      await controller.handle(
        'plat_test',
        r.body,
        r.headers,
        r as never,
        res as never,
      );
      expect(res.__calls[0].status).toBe(202);
      await new Promise((resolve) => setImmediate(resolve));
      expect(erpDelivery.deliverToUrl).not.toHaveBeenCalled();
    });
  });
});
