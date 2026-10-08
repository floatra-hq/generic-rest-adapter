import { UndeliveredWebhookPoller } from './undelivered-webhook.poller';
import {
  FloatraApiError,
  UndeliveredWebhook,
} from '../floatra/floatra-api.client';
import { FloatraAdapterConfig } from '../config/config.types';
import { loadResponseFixture } from '../contract/fixtures';

/**
 * P2-18: per-platform undelivered-webhook polling.
 *
 * Tests exercise pollOnce() directly — the onModuleInit
 * setInterval path is gated off in NODE_ENV=test so it doesn't
 * interfere here.
 */

describe('UndeliveredWebhookPoller (P2-18)', () => {
  function buildConfig(
    platformId: string,
    apiKey = 'api-key',
  ): FloatraAdapterConfig {
    return {
      erp_type: 'GENERIC',
      platform_id: platformId,
      api_key: apiKey,
      webhook_secret: 'secret',
      floatra_gateway_url: 'https://gw.test',
      inbound: {} as never,
      outbound: {
        erp_webhook_url: 'https://erp.test/webhook',
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
      },
      unavailability_fallback: 'BLOCK_CREDIT_ORDERS',
    };
  }

  function event(
    overrides: Partial<UndeliveredWebhook> = {},
  ): UndeliveredWebhook {
    return {
      event_id: overrides.event_id ?? 'evt-1',
      event_type: overrides.event_type ?? 'merchant.reorder_locked',
      status: overrides.status ?? 'FAILED',
      attempts: overrides.attempts ?? 3,
      last_attempt_at: overrides.last_attempt_at ?? '2026-06-01T10:00:00Z',
      last_status_code: overrides.last_status_code ?? 500,
      last_error: overrides.last_error ?? 'connection refused',
      dead_lettered_at: overrides.dead_lettered_at ?? null,
      created_at: overrides.created_at ?? '2026-06-01T09:00:00Z',
      // Core's flat payload: `event` + `timestamp` live inside it.
      payload: overrides.payload ?? {
        event: 'merchant.reorder_locked',
        merchantId: 'm-1',
        timestamp: '2026-06-01T08:59:00Z',
      },
    };
  }

  function makeRedis() {
    const store = new Map<string, string>();
    return {
      store,
      set: jest.fn(async (key: string, val: string, ..._args: unknown[]) => {
        if (store.has(key)) return null; // simulating NX
        store.set(key, val);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => {
        const had = store.has(key);
        store.delete(key);
        return had ? 1 : 0;
      }),
    };
  }

  function build({
    platformIds = ['plat-A'],
    pages = [
      { data: [event()], total: 1, offset: 0, limit: 50, has_more: false },
    ],
    translatorError = null as Error | null,
    deduped = false,
    apiKey = 'api-key',
  }: {
    platformIds?: string[];
    pages?: Array<{
      data: UndeliveredWebhook[];
      total: number;
      offset: number;
      limit: number;
      has_more: boolean;
    }>;
    translatorError?: Error | null;
    deduped?: boolean;
    apiKey?: string;
  } = {}) {
    const configs = new Map(
      platformIds.map((p) => [p, buildConfig(p, apiKey)]),
    );
    const loader = {
      listPlatformIds: jest.fn().mockReturnValue(platformIds),
      getByPlatform: jest.fn((id: string) => configs.get(id)),
    };
    const floatra = {
      listUndelivered: jest.fn().mockImplementation(
        async () =>
          pages.shift() ?? {
            data: [],
            total: 0,
            offset: 0,
            limit: 50,
            has_more: false,
          },
      ),
      acknowledgeWebhook: jest
        .fn()
        .mockResolvedValue({ status: 200, body: {} }),
    };
    const translator = {
      translateAndDeliver: jest.fn().mockImplementation(async () => {
        if (translatorError) throw translatorError;
      }),
    };
    const dedup = {
      isDuplicate: jest.fn().mockResolvedValue(deduped),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const redis = makeRedis();
    const env = {
      get: jest.fn((key: string) => (key === 'NODE_ENV' ? 'test' : undefined)),
    };

    const poller = new UndeliveredWebhookPoller(
      env as never,
      loader as never,
      floatra as never,
      translator as never,
      dedup as never,
      redis as never,
    );

    return { poller, loader, floatra, translator, dedup, redis };
  }

  it('replays one event end-to-end: dedup OK → translate+deliver → ack', async () => {
    const { poller, floatra, translator, dedup } = build();
    const result = await poller.pollOnce();
    expect(result).toEqual({ platforms: 1, replayed: 1 });
    expect(dedup.isDuplicate).toHaveBeenCalledWith('evt-1');
    expect(translator.translateAndDeliver).toHaveBeenCalledTimes(1);
    expect(floatra.acknowledgeWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ platform_id: 'plat-A' }),
      'evt-1',
    );
    // Translator received the row mapped through toWebhookEvent:
    // payload → data, payload.event → event_type, and payload.timestamp
    // (the event time, not the delivery row's created_at) → occurred_at.
    const call = translator.translateAndDeliver.mock.calls[0][0];
    expect(call).toMatchObject({
      event_id: 'evt-1',
      event_type: 'merchant.reorder_locked',
      occurred_at: '2026-06-01T08:59:00Z',
      data: { event: 'merchant.reorder_locked', merchantId: 'm-1' },
    });
  });

  it('replays a core undelivered row as the flat-payload envelope', async () => {
    const page = loadResponseFixture('response-undelivered').body.data; // unwrapped by the client (Task 4)
    // The fixture is a live event (`livemode: true`), so a live key replays it.
    const { poller, floatra, translator } = build({ apiKey: 'live_pk_test' });
    floatra.listUndelivered.mockResolvedValueOnce(page);
    await poller.pollOnce();
    expect(translator.translateAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: 'dlv_disbursed',
        event_type: 'order.disbursed',
        data: expect.objectContaining({ externalOrderId: 'SO-1001' }),
      }),
      expect.anything(),
    );
  });

  it("routes a row whose payload lacks `event` by the row's event_type (not dropped as '')", async () => {
    const { poller, translator, floatra } = build({
      pages: [
        {
          data: [
            event({
              event_type: 'order.disbursed',
              payload: { loanId: 'loan-9', timestamp: '2026-06-01T08:59:00Z' },
            }),
          ],
          total: 1,
          offset: 0,
          limit: 50,
          has_more: false,
        },
      ],
    });
    await poller.pollOnce();
    expect(translator.translateAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'order.disbursed' }),
      expect.anything(),
    );
    expect(floatra.acknowledgeWebhook).toHaveBeenCalledTimes(1);
  });

  it('never applies an event from the other realm, and ACKs it', async () => {
    const { poller, translator, floatra } = build({
      pages: [
        {
          data: [
            event({
              payload: {
                event: 'merchant.reorder_locked',
                merchantId: 'm-1',
                livemode: true,
                timestamp: '2026-06-01T08:59:00Z',
              },
            }),
          ],
          total: 1,
          offset: 0,
          limit: 50,
          has_more: false,
        },
      ],
    });
    const result = await poller.pollOnce();
    expect(result.replayed).toBe(0);
    expect(translator.translateAndDeliver).not.toHaveBeenCalled();
    expect(floatra.acknowledgeWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ platform_id: 'plat-A' }),
      'evt-1',
    );
  });

  it('skips translate when the dedup cache already saw the event, but still ACKs', async () => {
    const { poller, translator, floatra } = build({ deduped: true });
    const result = await poller.pollOnce();
    expect(result.replayed).toBe(0);
    expect(translator.translateAndDeliver).not.toHaveBeenCalled();
    expect(floatra.acknowledgeWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ platform_id: 'plat-A' }),
      'evt-1',
    );
  });

  it('releases the dedup claim + does NOT ACK when delivery fails', async () => {
    const { poller, dedup, floatra } = build({
      translatorError: new Error('ERP down'),
    });
    const result = await poller.pollOnce();
    expect(result.replayed).toBe(0);
    expect(dedup.release).toHaveBeenCalledWith('evt-1');
    expect(floatra.acknowledgeWebhook).not.toHaveBeenCalled();
  });

  it('walks pagination until has_more = false', async () => {
    const { poller, floatra, translator } = build({
      pages: [
        {
          data: [event({ event_id: 'evt-1' }), event({ event_id: 'evt-2' })],
          total: 3,
          offset: 0,
          limit: 50,
          has_more: true,
        },
        {
          data: [event({ event_id: 'evt-3' })],
          total: 3,
          offset: 2,
          limit: 50,
          has_more: false,
        },
      ],
    });
    const result = await poller.pollOnce();
    expect(result.replayed).toBe(3);
    expect(floatra.listUndelivered).toHaveBeenCalledTimes(2);
    expect(translator.translateAndDeliver).toHaveBeenCalledTimes(3);
  });

  it('isolates per-platform errors so one broken platform does not poison the cycle', async () => {
    const broken = new Error('platform A gateway is down');
    const { poller, loader, floatra, translator } = build({
      platformIds: ['plat-A', 'plat-B'],
    });
    // First call (plat-A) throws; second (plat-B) returns one event.
    let call = 0;
    floatra.listUndelivered.mockImplementation(async () => {
      call++;
      if (call === 1) throw broken;
      return {
        data: [event()],
        total: 1,
        offset: 0,
        limit: 50,
        has_more: false,
      };
    });

    const result = await poller.pollOnce();
    expect(result.platforms).toBe(2);
    expect(result.replayed).toBe(1);
    expect(translator.translateAndDeliver).toHaveBeenCalledTimes(1);
    expect(loader.listPlatformIds).toHaveBeenCalledTimes(1);
  });

  it('skips a platform when the per-platform Redis lock is already held by a peer', async () => {
    const { poller, redis, floatra } = build();
    // Pre-claim the lock.
    redis.store.set('floatra:adapter:undelivered:lock:plat-A', '1');
    const result = await poller.pollOnce();
    expect(result.replayed).toBe(0);
    expect(floatra.listUndelivered).not.toHaveBeenCalled();
  });

  it('treats an ACK 404 as benign (already-acknowledged from another path)', async () => {
    const { poller, floatra } = build();
    floatra.acknowledgeWebhook.mockRejectedValueOnce(
      new FloatraApiError(404, { error: 'EVENT_NOT_FOUND' }),
    );
    const result = await poller.pollOnce();
    expect(result.replayed).toBe(1);
  });

  it('refuses to overlap: a second pollOnce() while the first is running short-circuits', async () => {
    const { poller, floatra } = build();
    // Stall the first cycle on the gateway call so we can issue a
    // second one before the first finishes.
    let resolveListing: (v: unknown) => void = () => undefined;
    floatra.listUndelivered.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveListing = resolve;
        }),
    );

    const first = poller.pollOnce();
    // Yield so the first cycle sets running = true + reaches the
    // stalled listUndelivered call before we issue the second.
    await new Promise((r) => setImmediate(r));
    const second = await poller.pollOnce();
    expect(second).toEqual({ platforms: 0, replayed: 0 });

    resolveListing({
      data: [],
      total: 0,
      offset: 0,
      limit: 50,
      has_more: false,
    });
    await first;
  });
});
