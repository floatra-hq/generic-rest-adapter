import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { randomUUID } from 'node:crypto';
import {
  FloatraAdapterConfig,
  FloatraOrderPayload,
} from '../config/config.types';

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_AFTER_503_MS = 5_000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX_EXCLUSIVE = 300;

function isSuccessStatus(status: number): boolean {
  return status >= HTTP_OK_MIN && status < HTTP_OK_MAX_EXCLUSIVE;
}

/** Core wraps every response as { success, data, error, errorCode, timestamp }. */
function unwrapEnvelope(body: unknown): unknown {
  if (body && typeof body === 'object' && 'success' in body && 'data' in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

export class FloatraApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Floatra API returned ${status}: ${JSON.stringify(body)}`);
  }
}

/**
 * One row of `GET /v1/partner/webhooks/undelivered`. Shape mirrors the
 * Floatra gateway's `PlatformController.listUndelivered` response.
 * Optional fields are absent when the gateway hasn't recorded a
 * delivery attempt yet.
 */
export interface UndeliveredWebhook {
  event_id: string;
  event_type: string;
  status: 'FAILED' | 'DEAD_LETTER';
  attempts: number;
  last_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  dead_lettered_at: string | null;
  created_at: string;
  payload: Record<string, unknown>;
}

/**
 * Thin HTTP client for Floatra core's partner API
 * (`/v1/partner/*` — `floatra_gateway_url` is that base). One
 * instance per adapter — config-specific values (gateway URL, API
 * key, platform id) are passed per call so we
 * can serve multiple platforms from one process.
 *
 * Retry policy:
 *   - Timeout: 30s per request
 *   - 503: one retry after 5s
 *   - Any other non-2xx: surfaced as FloatraApiError to the caller
 *
 * Envelope: core wraps every response as
 * `{ success, data, error, errorCode, timestamp }`. 2xx bodies are
 * unwrapped to `data` before they reach callers; non-2xx bodies are
 * returned (or thrown) as the full error envelope, intact.
 *
 * Idempotency: every POST gets an `Idempotency-Key`. Callers can
 * pass their own (e.g. external_order_id) — that's strongly
 * preferred over a UUID4 because it survives the ERP retrying.
 */
@Injectable()
export class FloatraApiClient {
  private readonly logger = new Logger(FloatraApiClient.name);
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      timeout: DEFAULT_TIMEOUT_MS,
      // Don't follow 3xx — gateway redirects would mask config errors.
      maxRedirects: 0,
      // Surface non-2xx as errors so we can normalize them.
      validateStatus: () => true,
    });
  }

  async initiateOrder(
    config: FloatraAdapterConfig,
    payload: FloatraOrderPayload,
    idempotencyKey?: string,
  ): Promise<{ status: number; body: unknown }> {
    return this.post(
      config,
      '/orders/initiate',
      payload,
      idempotencyKey ?? payload.external_order_id,
    );
  }

  /**
   * Resolve an ERP-side `external_order_id` to a Floatra envelope.
   * Returns null on 404 (unknown external id OR cross-platform).
   * Throws on other non-2xx so callers can surface the gateway error.
   */
  async lookupOrderByExternalId(
    config: FloatraAdapterConfig,
    externalOrderId: string,
  ): Promise<{
    floatra_order_id: string;
    floatra_loan_id: string | null;
    loan_status: string | null;
    due_date: string | null;
    disbursed_at: string | null;
  } | null> {
    const url = this.joinUrl(
      config.floatra_gateway_url,
      `/orders/by-external-id/${encodeURIComponent(externalOrderId)}`,
    );
    const headers = this.buildHeaders(config);
    try {
      const resp = await this.http.get(url, { headers });
      if (resp.status === 404) return null;
      if (isSuccessStatus(resp.status)) {
        return unwrapEnvelope(resp.data) as {
          floatra_order_id: string;
          floatra_loan_id: string | null;
          loan_status: string | null;
          due_date: string | null;
          disbursed_at: string | null;
        };
      }
      throw new FloatraApiError(resp.status, resp.data);
    } catch (err) {
      throw this.normalizeAxiosError(err);
    }
  }

  async confirmDelivery(
    config: FloatraAdapterConfig,
    floatraOrderId: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<{ status: number; body: unknown }> {
    return this.post(
      config,
      `/orders/${encodeURIComponent(floatraOrderId)}/confirm-delivery`,
      payload,
      idempotencyKey,
    );
  }

  async cancelOrder(
    config: FloatraAdapterConfig,
    floatraOrderId: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<{ status: number; body: unknown }> {
    return this.post(
      config,
      `/orders/${encodeURIComponent(floatraOrderId)}/cancel`,
      payload,
      idempotencyKey,
    );
  }

  async getHealth(
    config: FloatraAdapterConfig,
  ): Promise<{ status: number; body: unknown }> {
    const url = this.joinUrl(config.floatra_gateway_url, '/platform/health');
    const headers = this.buildHeaders(config);
    try {
      const resp = await this.http.get(url, { headers });
      return { status: resp.status, body: resp.data };
    } catch (err) {
      throw this.normalizeAxiosError(err);
    }
  }

  /**
   * P2-18: poll the gateway's undelivered-webhook queue. Used by
   * the catch-up scheduler so a webhook the gateway tried to
   * deliver while the adapter was down isn't lost. Response shape
   * matches core's `GET /v1/partner/webhooks/undelivered` (after
   * envelope unwrapping):
   *   { data: UndeliveredEvent[], total, offset, limit, has_more }
   * On non-2xx the call throws a FloatraApiError; the caller decides
   * whether to retry or log and skip.
   */
  async listUndelivered(
    config: FloatraAdapterConfig,
    pagination: { limit?: number; offset?: number } = {},
  ): Promise<{
    data: UndeliveredWebhook[];
    total: number;
    offset: number;
    limit: number;
    has_more: boolean;
  }> {
    const qs = new URLSearchParams();
    if (pagination.limit !== undefined) {
      qs.set('limit', String(pagination.limit));
    }
    if (pagination.offset !== undefined) {
      qs.set('offset', String(pagination.offset));
    }
    const query = qs.toString();
    const path = `/webhooks/undelivered${query ? `?${query}` : ''}`;
    const url = this.joinUrl(config.floatra_gateway_url, path);
    const headers = this.buildHeaders(config);
    try {
      const resp = await this.http.get(url, { headers });
      if (isSuccessStatus(resp.status)) {
        return unwrapEnvelope(resp.data) as {
          data: UndeliveredWebhook[];
          total: number;
          offset: number;
          limit: number;
          has_more: boolean;
        };
      }
      throw new FloatraApiError(resp.status, resp.data);
    } catch (err) {
      throw this.normalizeAxiosError(err);
    }
  }

  /**
   * P2-18: acknowledge an undelivered webhook after the adapter has
   * successfully replayed it. POST /v1/partner/webhooks/:event_id/acknowledge
   * is idempotent — re-acking is a no-op — so the scheduler can be
   * conservative about when to acknowledge without risk.
   */
  async acknowledgeWebhook(
    config: FloatraAdapterConfig,
    eventId: string,
  ): Promise<{ status: number; body: unknown }> {
    return this.post(
      config,
      `/webhooks/${encodeURIComponent(eventId)}/acknowledge`,
      {},
      // No idempotency key needed — the gateway returns
      // ALREADY_ACKNOWLEDGED on replay.
      undefined,
    );
  }

  /**
   * Like getHealth, but with a per-call timeout (overrides the
   * client-level 30s default). Used by the boot-time reachability
   * gate where a 10s budget is more appropriate than blocking
   * startup for 30s per platform.
   */
  async pingHealth(
    config: FloatraAdapterConfig,
    timeoutMs: number,
  ): Promise<{ status: number; body: unknown }> {
    const url = this.joinUrl(config.floatra_gateway_url, '/platform/health');
    const headers = this.buildHeaders(config);
    try {
      const resp = await this.http.get(url, {
        headers,
        timeout: timeoutMs,
      });
      return { status: resp.status, body: resp.data };
    } catch (err) {
      throw this.normalizeAxiosError(err);
    }
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private async post(
    config: FloatraAdapterConfig,
    path: string,
    body: unknown,
    idempotencyKey: string | undefined,
  ): Promise<{ status: number; body: unknown }> {
    const url = this.joinUrl(config.floatra_gateway_url, path);
    const headers = this.buildHeaders(config, idempotencyKey);

    let retriesRemaining = 1;
    for (;;) {
      try {
        const resp = await this.http.post(url, body, { headers });
        if (resp.status === 503 && retriesRemaining > 0) {
          retriesRemaining--;
          this.logger.warn(
            `Floatra POST ${path} returned 503; retrying in ${RETRY_AFTER_503_MS}ms`,
          );
          await this.sleep(RETRY_AFTER_503_MS);
          continue;
        }
        return {
          status: resp.status,
          body: isSuccessStatus(resp.status)
            ? unwrapEnvelope(resp.data)
            : resp.data,
        };
      } catch (err) {
        throw this.normalizeAxiosError(err);
      }
    }
  }

  private buildHeaders(
    config: FloatraAdapterConfig,
    idempotencyKey?: string,
  ): Record<string, string> {
    return {
      Authorization: `Bearer ${config.api_key}`,
      'X-Platform-ID': config.platform_id,
      'X-Floatra-Timestamp': new Date().toISOString(),
      'Accept-Version': 'v1',
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey ?? randomUUID(),
    };
  }

  private joinUrl(base: string, path: string): string {
    return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  }

  private normalizeAxiosError(err: unknown): FloatraApiError {
    if (err instanceof AxiosError && err.response) {
      return new FloatraApiError(err.response.status, err.response.data);
    }
    return new FloatraApiError(
      0,
      null,
      err instanceof Error ? err.message : 'Network error',
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
