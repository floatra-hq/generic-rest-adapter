import { FloatraApiClient, FloatraApiError } from './floatra-api.client';
import { AxiosError } from 'axios';
import type {
  FloatraAdapterConfig,
  FloatraOrderPayload,
} from '../config/config.types';
import { loadResponseFixture } from '../contract/fixtures';

/**
 * P2-24 slice I: coverage for the generic-rest-adapter's outbound
 * Floatra Integration Gateway client.
 *
 * Load-bearing contracts:
 *
 *   1. Header shape on every request: Bearer + X-Platform-ID +
 *      X-Floatra-Timestamp (ISO) + Accept-Version v1. Idempotency-Key
 *      defaults to randomUUID; an explicit key wins (callers strongly
 *      prefer external_order_id so an ERP retry doesn't double-spend).
 *   2. 503 → single retry after 5s with the SAME idempotency key (a
 *      regression that minted a fresh key on retry would
 *      double-create the loan). Same URL too.
 *   3. Non-2xx other than 503 → returned in `{status, body}` (NOT
 *      thrown) — callers branch on status.
 *   4. lookupOrderByExternalId: 404 → null; 2xx → data; non-2xx
 *      → throws FloatraApiError so the caller can surface the
 *      gateway error.
 *   5. Axios THROWS (network failure) → normalizeAxiosError wraps.
 *      AxiosError with .response → status forwarded; plain Error
 *      → status 0 (the dashboard distinguishes "gateway said no"
 *      from "network ate the request").
 *   6. pingHealth uses a per-call timeout that overrides the
 *      30s client default — used by the boot-time reachability
 *      gate where a 10s budget is more appropriate than blocking
 *      startup for 30s per platform.
 *   7. listUndelivered query-string assembly + throws on non-2xx.
 */

function fakeConfig(): FloatraAdapterConfig {
  return {
    erp_type: 'generic',
    platform_id: 'plt_test',
    api_key: 'secret-key',
    webhook_secret: 's',
    floatra_gateway_url: 'https://gateway.test/v1',
    inbound: {} as never,
    outbound: {} as never,
    unavailability_fallback: 'BLOCK_CREDIT_ORDERS',
  };
}

function fakeOrderPayload(): FloatraOrderPayload {
  return {
    external_order_id: 'ord-ext-1',
    external_merchant_id: 'mer-ext-1',
    amount: 50000,
    amount_unit: 'NAIRA',
    category: 'FMCG',
    tenure_days: 14,
  } as unknown as FloatraOrderPayload;
}

function buildClient() {
  const client = new FloatraApiClient();
  // Skip the 5s sleep on 503 retries.
  jest
    .spyOn(client as unknown as { sleep: () => Promise<void> }, 'sleep')
    .mockResolvedValue(undefined);
  const http = { get: jest.fn(), post: jest.fn() };
  (client as unknown as { http: typeof http }).http = http;
  return { client, http };
}

describe('FloatraApiClient', () => {
  describe('headers + idempotency', () => {
    it('attaches Bearer + platform + ISO timestamp + accept-version + content-type on every call', async () => {
      const { client, http } = buildClient();
      http.post.mockResolvedValue({ status: 200, data: { ok: true } });
      await client.initiateOrder(fakeConfig(), fakeOrderPayload(), 'k1');
      const headers = http.post.mock.calls[0][2].headers;
      expect(headers.Authorization).toBe('Bearer secret-key');
      expect(headers['X-Platform-ID']).toBe('plt_test');
      expect(headers['Accept-Version']).toBe('v1');
      expect(headers['Content-Type']).toBe('application/json');
      // ISO-8601 timestamp (Z-terminated).
      expect(headers['X-Floatra-Timestamp']).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    it('uses the explicit idempotency key when provided (callers prefer external_order_id)', async () => {
      const { client, http } = buildClient();
      http.post.mockResolvedValue({ status: 200, data: {} });
      await client.initiateOrder(
        fakeConfig(),
        fakeOrderPayload(),
        'caller-key',
      );
      expect(http.post.mock.calls[0][2].headers['Idempotency-Key']).toBe(
        'caller-key',
      );
    });

    it('falls back to payload.external_order_id when no key is passed to initiateOrder', async () => {
      const { client, http } = buildClient();
      http.post.mockResolvedValue({ status: 200, data: {} });
      await client.initiateOrder(fakeConfig(), fakeOrderPayload());
      expect(http.post.mock.calls[0][2].headers['Idempotency-Key']).toBe(
        'ord-ext-1',
      );
    });

    it('mints a random UUID idempotency key when caller AND payload provide none', async () => {
      const { client, http } = buildClient();
      http.post.mockResolvedValue({ status: 200, data: {} });
      await client.confirmDelivery(fakeConfig(), 'loan-1', {});
      const key = http.post.mock.calls[0][2].headers['Idempotency-Key'];
      // UUIDv4 shape.
      expect(key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe('503 retry behaviour', () => {
    it('retries ONCE on 503 and reuses the SAME idempotency key (double-spend guard)', async () => {
      const { client, http } = buildClient();
      http.post
        .mockResolvedValueOnce({ status: 503, data: { error: 'busy' } })
        .mockResolvedValueOnce({ status: 200, data: { ok: true } });
      const result = await client.initiateOrder(
        fakeConfig(),
        fakeOrderPayload(),
        'caller-key',
      );
      expect(result).toEqual({ status: 200, body: { ok: true } });
      expect(http.post).toHaveBeenCalledTimes(2);
      const key1 = http.post.mock.calls[0][2].headers['Idempotency-Key'];
      const key2 = http.post.mock.calls[1][2].headers['Idempotency-Key'];
      expect(key2).toBe(key1);
      // Same URL too.
      expect(http.post.mock.calls[0][0]).toBe(http.post.mock.calls[1][0]);
    });

    it('returns the 503 envelope after the single retry is exhausted (no third attempt)', async () => {
      const { client, http } = buildClient();
      http.post
        .mockResolvedValueOnce({ status: 503, data: { error: 'busy' } })
        .mockResolvedValueOnce({ status: 503, data: { error: 'still busy' } });
      const result = await client.initiateOrder(
        fakeConfig(),
        fakeOrderPayload(),
        'caller-key',
      );
      expect(result).toEqual({ status: 503, body: { error: 'still busy' } });
      expect(http.post).toHaveBeenCalledTimes(2);
    });

    it('returns non-503 non-2xx responses in the {status, body} envelope WITHOUT throwing', async () => {
      const { client, http } = buildClient();
      // 422 = validation. Callers branch on status.
      http.post.mockResolvedValueOnce({ status: 422, data: { code: 'BAD' } });
      const result = await client.initiateOrder(
        fakeConfig(),
        fakeOrderPayload(),
        'k1',
      );
      expect(result).toEqual({ status: 422, body: { code: 'BAD' } });
      expect(http.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('normalizeAxiosError', () => {
    it('wraps AxiosError with .response into FloatraApiError carrying the upstream status', async () => {
      const { client, http } = buildClient();
      const axiosErr = new AxiosError('Request failed');
      (
        axiosErr as unknown as { response: { status: number; data: unknown } }
      ).response = {
        status: 502,
        data: { msg: 'bad gateway' },
      };
      http.post.mockRejectedValueOnce(axiosErr);
      await expect(
        client.initiateOrder(fakeConfig(), fakeOrderPayload(), 'k1'),
      ).rejects.toMatchObject({
        status: 502,
        body: { msg: 'bad gateway' },
      });
    });

    it('wraps non-axios errors into FloatraApiError with status=0 (dashboard distinguishes network vs upstream)', async () => {
      const { client, http } = buildClient();
      http.post.mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(
        client.initiateOrder(fakeConfig(), fakeOrderPayload(), 'k1'),
      ).rejects.toMatchObject({
        status: 0,
      });
    });
  });

  describe('lookupOrderByExternalId', () => {
    it('returns null on 404 (unknown external id OR cross-platform)', async () => {
      const { client, http } = buildClient();
      http.get.mockResolvedValueOnce({
        status: 404,
        data: { code: 'NOT_FOUND' },
      });
      const result = await client.lookupOrderByExternalId(
        fakeConfig(),
        'ord-ext-1',
      );
      expect(result).toBeNull();
    });

    it('returns the envelope on 2xx', async () => {
      const { client, http } = buildClient();
      const envelope = {
        floatra_order_id: 'flo-1',
        floatra_loan_id: 'loan-1',
        loan_status: 'ACTIVE',
        due_date: '2026-06-15',
        disbursed_at: '2026-06-01T10:00:00.000Z',
      };
      http.get.mockResolvedValueOnce({ status: 200, data: envelope });
      const result = await client.lookupOrderByExternalId(
        fakeConfig(),
        'ord-ext-1',
      );
      expect(result).toEqual(envelope);
    });

    it('THROWS FloatraApiError on non-404 non-2xx', async () => {
      const { client, http } = buildClient();
      http.get.mockResolvedValueOnce({ status: 500, data: { code: 'OOPS' } });
      await expect(
        client.lookupOrderByExternalId(fakeConfig(), 'ord-ext-1'),
      ).rejects.toBeInstanceOf(FloatraApiError);
    });

    it('URL-encodes the external order id (preserves slashes/spaces from ERP IDs)', async () => {
      const { client, http } = buildClient();
      http.get.mockResolvedValueOnce({ status: 404, data: {} });
      await client.lookupOrderByExternalId(fakeConfig(), 'ord/with spaces');
      expect(http.get.mock.calls[0][0]).toContain(
        encodeURIComponent('ord/with spaces'),
      );
    });
  });

  describe('listUndelivered + acknowledgeWebhook', () => {
    it('assembles a query string from limit + offset when both are passed', async () => {
      const { client, http } = buildClient();
      http.get.mockResolvedValueOnce({
        status: 200,
        data: { data: [], total: 0, offset: 0, limit: 50, has_more: false },
      });
      await client.listUndelivered(fakeConfig(), { limit: 50, offset: 100 });
      const url = http.get.mock.calls[0][0];
      expect(url).toContain('limit=50');
      expect(url).toContain('offset=100');
    });

    it('omits the query string entirely when no pagination is passed', async () => {
      const { client, http } = buildClient();
      http.get.mockResolvedValueOnce({
        status: 200,
        data: { data: [], total: 0, offset: 0, limit: 50, has_more: false },
      });
      await client.listUndelivered(fakeConfig());
      expect(http.get.mock.calls[0][0]).not.toContain('?');
    });

    it('THROWS FloatraApiError on non-2xx (caller chooses retry vs skip)', async () => {
      const { client, http } = buildClient();
      http.get.mockResolvedValueOnce({ status: 500, data: { code: 'OOPS' } });
      await expect(client.listUndelivered(fakeConfig())).rejects.toBeInstanceOf(
        FloatraApiError,
      );
    });

    it('POSTs to /webhooks/:eventId/acknowledge with the URL-encoded event id', async () => {
      const { client, http } = buildClient();
      http.post.mockResolvedValueOnce({ status: 200, data: {} });
      await client.acknowledgeWebhook(fakeConfig(), 'evt with/slash');
      expect(http.post.mock.calls[0][0]).toContain(
        `/webhooks/${encodeURIComponent('evt with/slash')}/acknowledge`,
      );
    });
  });

  describe('core response envelope', () => {
    it('lookupOrderByExternalId unwraps the core envelope', async () => {
      const { client, http } = buildClient();
      const fx = loadResponseFixture('response-order-lookup');
      http.get.mockResolvedValue({ status: fx.status, data: fx.body });
      await expect(
        client.lookupOrderByExternalId(fakeConfig(), 'SO-1001'),
      ).resolves.toEqual(
        expect.objectContaining({
          floatra_loan_id: 'loan_01',
          external_order_id: 'SO-1001',
        }),
      );
    });

    it('listUndelivered unwraps to the page object', async () => {
      const { client, http } = buildClient();
      const fx = loadResponseFixture('response-undelivered');
      http.get.mockResolvedValue({ status: fx.status, data: fx.body });
      const page = await client.listUndelivered(fakeConfig());
      expect(Array.isArray(page.data)).toBe(true);
      expect(page.data[0].event_id).toBe('dlv_disbursed');
    });

    it('post() unwraps a 2xx body', async () => {
      const { client, http } = buildClient();
      http.post.mockResolvedValue({
        status: 200,
        data: { success: true, data: { decision: 'APPROVED' }, error: null },
      });
      await expect(
        client.initiateOrder(fakeConfig(), fakeOrderPayload()),
      ).resolves.toEqual({ status: 200, body: { decision: 'APPROVED' } });
    });

    it('post() passes a non-2xx error envelope through intact', async () => {
      const { client, http } = buildClient();
      const fx = loadResponseFixture('response-error-404');
      http.post.mockResolvedValue({ status: fx.status, data: fx.body });
      await expect(
        client.cancelOrder(fakeConfig(), 'loan_01', {}),
      ).resolves.toEqual({ status: 404, body: fx.body });
    });

    it('leaves a non-envelope 2xx body untouched', async () => {
      const { client, http } = buildClient();
      http.post.mockResolvedValue({ status: 200, data: { foo: 1 } });
      await expect(
        client.initiateOrder(fakeConfig(), fakeOrderPayload()),
      ).resolves.toEqual({ status: 200, body: { foo: 1 } });
    });
  });

  describe('pingHealth', () => {
    it('uses the per-call timeout override (overrides the 30s default)', async () => {
      const { client, http } = buildClient();
      http.get.mockResolvedValueOnce({ status: 200, data: { ok: true } });
      await client.pingHealth(fakeConfig(), 10_000);
      expect(http.get.mock.calls[0][1].timeout).toBe(10_000);
    });
  });

  describe('joinUrl behaviour (via getHealth path)', () => {
    it('correctly joins a base ending with / and a path starting with /', async () => {
      const { client, http } = buildClient();
      http.get.mockResolvedValueOnce({ status: 200, data: {} });
      const config = fakeConfig();
      config.floatra_gateway_url = 'https://gateway.test/v1/';
      await client.getHealth(config);
      // Single slash join — no double-slash and no truncation.
      expect(http.get.mock.calls[0][0]).toBe(
        'https://gateway.test/v1/platform/health',
      );
    });
  });
});
