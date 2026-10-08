import { Injectable, Logger } from '@nestjs/common';
import { JSONPath } from 'jsonpath-plus';
import {
  FLOATRA_CATEGORIES,
  FloatraAdapterConfig,
  InboundAuth,
  OutboundAuth,
} from './config.types';
import { ConditionParseError, parseCondition } from './condition-evaluator';

export class ConfigValidationError extends Error {
  constructor(
    public readonly platformId: string,
    public readonly issues: string[],
  ) {
    super(
      `Adapter config for "${platformId}" is invalid:\n  - ${issues.join('\n  - ')}`,
    );
  }
}

/**
 * Fails the adapter startup if any per-platform config is invalid.
 *
 * Critical checks (mandatory, never bypassable):
 *   1. on_reorder_locked.block_merchant_orders === true
 *   2. trigger_events conditions parse under the safe subset
 *   3. JSONPath expressions in inbound.field_mappings parse via
 *      jsonpath-plus
 *   4. Any inbound mapping that references category resolves to a
 *      Floatra enum value via category_mappings (or is a static value)
 *
 * Soft checks (logged warnings, no fail):
 *   - floatra_gateway_url reachability
 *   - ERP webhook URL reachability
 *
 * The validator returns the list of issues so callers can build
 * detailed reports (used by the /adapter/config/validate endpoint).
 */
@Injectable()
export class ConfigValidatorService {
  private readonly logger = new Logger(ConfigValidatorService.name);

  validate(config: FloatraAdapterConfig): string[] {
    const issues: string[] = [];
    this.validateIdentity(config, issues);
    this.validateInbound(config.inbound, issues);
    this.validateOutbound(config.outbound, issues);
    this.validateFallback(config, issues);
    return issues;
  }

  private validateIdentity(
    config: FloatraAdapterConfig,
    issues: string[],
  ): void {
    const asRecord = config as unknown as Record<string, unknown>;
    this.requireString(asRecord, 'platform_id', issues);
    this.requireString(asRecord, 'api_key', issues);
    this.requireString(asRecord, 'webhook_secret', issues);
    this.requireString(asRecord, 'floatra_gateway_url', issues);

    if (
      config.floatra_gateway_url &&
      !/^https?:\/\//.test(config.floatra_gateway_url)
    ) {
      issues.push('floatra_gateway_url must start with http:// or https://');
    }
    if (
      config.floatra_gateway_url &&
      !/\/v1\/partner\/?$/.test(config.floatra_gateway_url)
    ) {
      issues.push(
        'floatra_gateway_url must end with /v1/partner (e.g. https://api.floatra.com/v1/partner)',
      );
    }
  }

  private validateInbound(
    inbound: FloatraAdapterConfig['inbound'] | undefined,
    issues: string[],
  ): void {
    if (!inbound) {
      issues.push('inbound block is required');
      return;
    }
    this.validateInboundAuth(inbound.auth, issues);
    this.validateFieldMappings(inbound.field_mappings, issues);
    this.validateTriggers(inbound.trigger_events, issues);

    if (!['sync', 'callback'].includes(inbound.response_mode)) {
      issues.push(
        `inbound.response_mode must be 'sync' or 'callback', got ${inbound.response_mode}`,
      );
    }
    if (inbound.response_mode === 'callback' && !inbound.callback_url) {
      issues.push(
        'inbound.callback_url is required when response_mode = callback',
      );
    }

    this.validateCategoryMappings(inbound.category_mappings, issues);
  }

  private validateFieldMappings(
    fm: FloatraAdapterConfig['inbound']['field_mappings'] | undefined,
    issues: string[],
  ): void {
    if (!fm) {
      issues.push('inbound.field_mappings is required');
      return;
    }
    this.validateJsonPath(
      fm.external_order_id,
      'inbound.field_mappings.external_order_id',
      issues,
    );
    this.validateJsonPath(
      fm.external_merchant_id,
      'inbound.field_mappings.external_merchant_id',
      issues,
    );
    this.validateJsonPath(fm.amount, 'inbound.field_mappings.amount', issues);
    if (fm.amount_unit !== 'NAIRA' && fm.amount_unit !== 'KOBO') {
      issues.push(
        `inbound.field_mappings.amount_unit must be NAIRA or KOBO, got ${String(fm.amount_unit)}`,
      );
    }
    if (fm.agent_id)
      this.validateJsonPath(
        fm.agent_id,
        'inbound.field_mappings.agent_id',
        issues,
      );
    if (fm.delivery_date)
      this.validateJsonPath(
        fm.delivery_date,
        'inbound.field_mappings.delivery_date',
        issues,
      );
    // category is either a JSONPath or a static value — the
    // translator interprets it. Only validate if it's a path.
    if (fm.category && fm.category.startsWith('$')) {
      this.validateJsonPath(
        fm.category,
        'inbound.field_mappings.category',
        issues,
      );
    }
  }

  private validateTriggers(
    triggers: FloatraAdapterConfig['inbound']['trigger_events'] | undefined,
    issues: string[],
  ): void {
    if (!triggers || Object.keys(triggers).length === 0) {
      issues.push('inbound.trigger_events must define at least one event');
      return;
    }
    for (const [name, evt] of Object.entries(triggers)) {
      try {
        parseCondition(evt.condition);
      } catch (err) {
        if (err instanceof ConditionParseError) {
          issues.push(
            `inbound.trigger_events.${name}.condition: ${err.message}`,
          );
        } else {
          issues.push(
            `inbound.trigger_events.${name}.condition: unknown parse error`,
          );
        }
      }
      if (
        !['initiate_order', 'confirm_delivery', 'cancel_order'].includes(
          evt.floatra_action,
        )
      ) {
        issues.push(
          `inbound.trigger_events.${name}.floatra_action invalid: ${evt.floatra_action}`,
        );
      }
    }
  }

  /**
   * Every mapping value must be a member of core's OrderCategory enum —
   * InitiateOrderDto 400s anything else.
   */
  private validateCategoryMappings(
    mappings: Record<string, string> | undefined,
    issues: string[],
  ): void {
    if (!mappings || typeof mappings !== 'object') {
      issues.push(
        'inbound.category_mappings is required (object of ERP-category → Floatra-enum)',
      );
      return;
    }
    for (const [erp, floatra] of Object.entries(mappings)) {
      if (
        !(FLOATRA_CATEGORIES as readonly string[]).includes(String(floatra))
      ) {
        issues.push(
          `inbound.category_mappings["${erp}"] = "${String(floatra)}" is not a Floatra category (${FLOATRA_CATEGORIES.join(', ')})`,
        );
      }
    }
  }

  private validateOutbound(
    outbound: FloatraAdapterConfig['outbound'] | undefined,
    issues: string[],
  ): void {
    if (!outbound) {
      issues.push('outbound block is required');
      return;
    }
    if (!outbound.erp_webhook_url) {
      issues.push('outbound.erp_webhook_url is required');
    } else if (!/^https?:\/\//.test(outbound.erp_webhook_url)) {
      issues.push(
        'outbound.erp_webhook_url must start with http:// or https://',
      );
    }

    this.validateOutboundAuth(outbound.erp_auth, issues);

    // The critical guard: on_reorder_locked MUST block merchant
    // orders. This is the structural mechanism preventing a
    // distributor from quietly disabling the merchant lock.
    const lock = outbound.on_reorder_locked;
    if (!lock) {
      issues.push('outbound.on_reorder_locked is required');
    } else if (lock.block_merchant_orders !== true) {
      issues.push(
        'outbound.on_reorder_locked.block_merchant_orders MUST be true — refusing to allow merchant orders during a reorder lock',
      );
    }

    if (!outbound.on_reorder_unlocked) {
      issues.push('outbound.on_reorder_unlocked is required');
    }

    this.validateRateLimit(outbound.rate_limit_per_minute, issues);
  }

  /**
   * P2-17: outbound rate limit. Optional — omitted means no
   * limiter is applied. When supplied must be an integer in
   * [1, 1000] req/min. Below 1 is meaningless; above 1000 is
   * out-of-band for what an ERP can realistically absorb (and
   * suggests the distributor doesn't actually want a limit).
   */
  private validateRateLimit(rate: unknown, issues: string[]): void {
    if (rate === undefined) return;
    if (
      typeof rate !== 'number' ||
      !Number.isInteger(rate) ||
      rate < 1 ||
      rate > 1000
    ) {
      issues.push(
        'outbound.rate_limit_per_minute must be an integer in [1, 1000] when supplied',
      );
    }
  }

  private validateFallback(
    config: FloatraAdapterConfig,
    issues: string[],
  ): void {
    if (
      config.unavailability_fallback !== 'BLOCK_CREDIT_ORDERS' &&
      config.unavailability_fallback !== 'ALLOW_ON_CREDIT'
    ) {
      issues.push(
        `unavailability_fallback must be BLOCK_CREDIT_ORDERS or ALLOW_ON_CREDIT, got ${String(config.unavailability_fallback)}`,
      );
    }
  }

  /**
   * Validate-or-throw. The startup path uses this; the
   * /adapter/config/validate endpoint uses validate() directly so it
   * can return the full issue list.
   */
  assertValid(config: FloatraAdapterConfig): void {
    const issues = this.validate(config);
    if (issues.length > 0) {
      throw new ConfigValidationError(config.platform_id, issues);
    }
  }

  // ---- helpers ----

  private requireString(
    obj: Record<string, unknown>,
    key: string,
    issues: string[],
  ): void {
    const v = obj[key];
    if (typeof v !== 'string' || v.length === 0) {
      issues.push(`${key} is required (non-empty string)`);
    }
  }

  private validateInboundAuth(auth: InboundAuth, issues: string[]): void {
    if (!auth) {
      issues.push('inbound.auth is required');
      return;
    }
    if (auth.type === 'api_key') {
      if (!auth.header_name)
        issues.push('inbound.auth.header_name is required for api_key');
      if (!auth.api_key)
        issues.push('inbound.auth.api_key is required for api_key');
    } else if (auth.type === 'basic') {
      if (!auth.username || !auth.password) {
        issues.push(
          'inbound.auth.username and password are required for basic',
        );
      }
    } else if (auth.type === 'hmac') {
      if (!auth.hmac_header || !auth.hmac_secret) {
        issues.push(
          'inbound.auth.hmac_header and hmac_secret are required for hmac',
        );
      }
    } else if (auth.type === 'none') {
      // G-2: `none` leaves POST /adapter/:platformId/inbound open, and that
      // endpoint can initiate real Floatra orders. Allowed in dev for local
      // testing, but a hard-fail in production so a platform can't ship
      // unauthenticated by accident.
      if (process.env.NODE_ENV === 'production') {
        issues.push(
          "inbound.auth.type 'none' is not allowed in production — the " +
            'inbound endpoint can initiate real orders. Configure api_key, ' +
            'basic, or hmac.',
        );
      }
    } else {
      issues.push(
        `inbound.auth.type unknown: ${(auth as { type: string }).type}`,
      );
    }
  }

  private validateOutboundAuth(auth: OutboundAuth, issues: string[]): void {
    if (!auth) {
      issues.push('outbound.erp_auth is required');
      return;
    }
    if (auth.type === 'api_key') {
      if (!auth.header_name)
        issues.push('outbound.erp_auth.header_name is required for api_key');
      if (!auth.api_key)
        issues.push('outbound.erp_auth.api_key is required for api_key');
    } else if (auth.type === 'basic') {
      if (!auth.username || !auth.password) {
        issues.push(
          'outbound.erp_auth.username and password are required for basic',
        );
      }
    } else if (auth.type !== 'none') {
      issues.push(
        `outbound.erp_auth.type unknown: ${(auth as { type: string }).type}`,
      );
    }
  }

  /**
   * P1-19: jsonpath-plus supports `(...)` script expressions and
   * `?(...)` filter expressions that evaluate as JavaScript. The
   * runtime translator (extractFirst) already rejects these chars
   * with `eval: false` set, but a validation pass that ignores them
   * lets distributors author configs that silently return undefined
   * forever once they hit production. Reject at config-load time so
   * the issue surfaces with a clear error.
   *
   * Same disallowed set as `translators/jsonpath.util.ts` —
   * single-sourced into a constant if it ever needs to diverge.
   */
  private static readonly DISALLOWED_PATH_CHARS = /[();={}<>!&|]/;

  /**
   * Representative payload for the smoke test. `{}` would accept
   * `$.a.b.c` because the path is structurally valid even though
   * it'd match nothing. A nested object exercises the real
   * descent-and-extract path the validator is trying to vet.
   */
  private static readonly SMOKE_PAYLOAD = {
    OrderHeader: {
      OrderId: 'sample',
      CustomerCode: 'sample',
      Total: 1000,
      Status: 'Pending',
    },
    Lines: [{ ProductCode: 'X', Qty: 1, Price: 1000 }],
  };

  private validateJsonPath(
    expr: string,
    field: string,
    issues: string[],
  ): void {
    if (!expr) {
      issues.push(`${field} is required`);
      return;
    }
    if (!expr.startsWith('$')) {
      issues.push(`${field} must start with $ (JSONPath): got "${expr}"`);
      return;
    }
    // P1-19: explicit script-block detector. Catches both filter
    // expressions `?(@.x > 1)` and script expressions `(x)` so a
    // distributor authoring a malicious or accidentally-script-ful
    // path fails boot instead of silently returning undefined at
    // runtime via the translator's eval:false guard.
    if (ConfigValidatorService.DISALLOWED_PATH_CHARS.test(expr.slice(1))) {
      issues.push(
        `${field} contains disallowed JSONPath syntax (script / filter blocks): "${expr}". ` +
          `Use a plain dot/bracket path; runtime translator rejects scripts via eval:false.`,
      );
      return;
    }
    try {
      // Use a representative object so paths that actually descend
      // into nested fields are smoke-tested rather than just
      // syntax-checked. `eval: false` matches the runtime call so
      // validation and execution share the same parser semantics.
      JSONPath({
        path: expr,
        json: ConfigValidatorService.SMOKE_PAYLOAD as object,
        wrap: true,
        eval: false,
      });
    } catch (err) {
      issues.push(
        `${field} parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
