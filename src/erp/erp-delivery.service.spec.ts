import { ErpDeliveryService } from './erp-delivery.service';
import { FloatraAdapterConfig } from '../config/config.types';

/**
 * Two behaviours under test:
 *
 *   1. The new rate-limiter check fires (P2-17) before every
 *      deliver() POST.
 *   2. The deliverToUrl callback path bypasses the limiter
 *      (callbacks aren't part of the event-stream budget).
 *
 * The HTTP layer itself is exercised by the inbound-controller +
 * floatra-webhook-controller specs; here we only need to assert
 * the limiter hook + URL routing.
 */

describe('ErpDeliveryService (P2-17 wiring)', () => {
  function build() {
    const rateLimiter = { acquire: jest.fn().mockResolvedValue(undefined) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new ErpDeliveryService(rateLimiter as any);
    // Stub the underlying axios POST so deliver() doesn't actually
    // hit the network.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).http = {
      post: jest.fn().mockResolvedValue({ status: 200, data: { ok: true } }),
    };
    return { svc, rateLimiter };
  }

  function config(
    overrides: Partial<FloatraAdapterConfig['outbound']> = {},
  ): FloatraAdapterConfig {
    return {
      erp_type: 'GENERIC',
      platform_id: 'plat-A',
      api_key: 'k',
      webhook_secret: 's',
      floatra_gateway_url: 'https://gw.test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inbound: {} as any,
      outbound: {
        erp_webhook_url: 'https://erp.test/wh',
        erp_auth: { type: 'none' },
        event_mappings: {},
        on_reorder_locked: {
          block_merchant_orders: true,
          update_merchant_field: 'locked',
          update_merchant_value: true,
        },
        on_reorder_unlocked: {
          unblock_merchant_orders: true,
          update_merchant_field: 'locked',
          update_merchant_value: false,
        },
        ...overrides,
      },
      unavailability_fallback: 'BLOCK_CREDIT_ORDERS',
    };
  }

  it('deliver(config, body) consults the limiter with the platform_id + configured rate', async () => {
    const { svc, rateLimiter } = build();
    await svc.deliver(config({ rate_limit_per_minute: 30 }), {
      hello: 'world',
    });
    expect(rateLimiter.acquire).toHaveBeenCalledWith('plat-A', 30);
  });

  it('deliver(config, body) consults the limiter with undefined when no rate is configured (no-op path)', async () => {
    const { svc, rateLimiter } = build();
    await svc.deliver(config(), { hello: 'world' });
    expect(rateLimiter.acquire).toHaveBeenCalledWith('plat-A', undefined);
  });

  it('deliverToUrl(url, auth, body) does NOT consult the limiter — callback path is separate budget', async () => {
    const { svc, rateLimiter } = build();
    await svc.deliverToUrl(
      'https://erp.test/callback',
      { type: 'none' },
      { hello: 'world' },
    );
    expect(rateLimiter.acquire).not.toHaveBeenCalled();
  });

  it('propagates a limiter throw without sending the POST', async () => {
    const { svc, rateLimiter } = build();
    rateLimiter.acquire.mockRejectedValueOnce(new Error('rate limit exceeded'));
    await expect(
      svc.deliver(config({ rate_limit_per_minute: 1 }), { x: 1 }),
    ).rejects.toThrow(/rate limit exceeded/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).http.post).not.toHaveBeenCalled();
  });
});
