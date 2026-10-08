import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { FloatraAdapterConfig, OutboundAuth } from '../config/config.types';
import { OutboundRateLimiterService } from './outbound-rate-limiter.service';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_5XX_RETRIES = 3;

/**
 * POSTs the translated payload to the ERP's webhook URL.
 *
 * Retry behaviour:
 *   - 5xx: retry up to 3x with exponential backoff (2s, 6s, 18s)
 *   - 4xx: fail fast — almost always a config issue
 *   - network errors: same as 5xx
 *
 * Auth:
 *   - none: nothing
 *   - api_key: header_name = api_key
 *   - basic: Basic base64(username:password)
 *
 * The body is the translated payload; we don't transform it here.
 */
@Injectable()
export class ErpDeliveryService {
  private readonly logger = new Logger(ErpDeliveryService.name);
  private readonly http: AxiosInstance;

  constructor(private readonly rateLimiter: OutboundRateLimiterService) {
    this.http = axios.create({
      timeout: DEFAULT_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
    });
  }

  async deliver(
    config: FloatraAdapterConfig,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    // P2-17: shape outbound traffic per-platform before the POST.
    // The limiter is a no-op when `rate_limit_per_minute` isn't
    // configured (legacy behaviour preserved). Acquiring here
    // covers both the regular webhook path AND retry attempts —
    // a 5xx burst still counts against the partner's budget.
    await this.rateLimiter.acquire(
      config.platform_id,
      config.outbound.rate_limit_per_minute,
    );
    return this.deliverToUrl(
      config.outbound.erp_webhook_url,
      config.outbound.erp_auth,
      body,
    );
  }

  /**
   * Same retry policy as `deliver`, but the caller supplies the URL
   * + auth explicitly. Used by the inbound-callback path (Spec / Prompt
   * 3 §"ENDPOINTS" `response_mode: "callback"`) which POSTs the
   * Floatra decision back to `inbound.callback_url`, not the standard
   * `outbound.erp_webhook_url`.
   *
   * The rate limiter is NOT applied here — callback URLs are a
   * different endpoint owned by the same partner, and the partner
   * sized `rate_limit_per_minute` for the steady-state event
   * webhook stream. Adding callbacks to the same bucket would
   * starve event delivery; if a partner needs callback shaping
   * too, a second config field would be the right shape.
   */
  async deliverToUrl(
    url: string,
    auth: OutboundAuth,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const headers = this.buildHeaders(auth);

    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt <= MAX_5XX_RETRIES) {
      try {
        const resp = await this.http.post(url, body, { headers });
        if (resp.status >= 200 && resp.status < 300) {
          return { status: resp.status, body: resp.data };
        }
        if (resp.status >= 400 && resp.status < 500) {
          // Fast-fail on 4xx — distinct from 5xx so distributors can
          // see immediately when their config has the wrong endpoint
          // or auth.
          this.logger.error(
            `ERP webhook ${url} returned ${resp.status} (4xx, fail-fast): ${JSON.stringify(resp.data)}`,
          );
          return { status: resp.status, body: resp.data };
        }
        lastErr = new Error(
          `ERP webhook returned ${resp.status}: ${JSON.stringify(resp.data)}`,
        );
      } catch (err) {
        lastErr = err;
      }

      attempt++;
      if (attempt > MAX_5XX_RETRIES) break;
      const delayMs = 2_000 * Math.pow(3, attempt - 1);
      this.logger.warn(
        `ERP webhook attempt ${attempt} failed; retrying in ${delayMs}ms`,
      );
      await this.sleep(delayMs);
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(
          `ERP webhook delivery failed after ${MAX_5XX_RETRIES} retries`,
        );
  }

  private buildHeaders(auth: OutboundAuth): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'floatra-generic-rest-adapter/0.1',
    };
    if (auth.type === 'api_key') {
      headers[auth.header_name] = auth.api_key;
    } else if (auth.type === 'basic') {
      const token = Buffer.from(`${auth.username}:${auth.password}`).toString(
        'base64',
      );
      headers.Authorization = `Basic ${token}`;
    }
    return headers;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
