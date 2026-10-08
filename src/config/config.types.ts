/**
 * Per-platform adapter config — loaded once at startup, validated by
 * ConfigValidatorService. Distributors author this JSON; the adapter
 * runs without any ERP-specific code.
 *
 * Schema mirrors Prompt 3 §"CONFIGURATION SCHEMA". Lives here as a
 * TypeScript interface so the validator + translators get
 * compile-time field-name coverage, but runtime validation is the
 * source of truth — distributors edit JSON, not TS.
 */

export interface FloatraAdapterConfig {
  // Identity
  erp_type: string;
  platform_id: string;
  api_key: string;
  webhook_secret: string;
  floatra_gateway_url: string;

  inbound: InboundConfig;
  outbound: OutboundConfig;

  /**
   * Behaviour when the Floatra Gateway is unreachable.
   *   - BLOCK_CREDIT_ORDERS: refuse to translate; ERP gets 503
   *   - ALLOW_ON_CREDIT: still translate + log, ERP places orders
   *     on its own credit (legally distinct from Floatra-funded).
   *     Requires ALLOW_FALLBACK_ON_CREDIT_OVERRIDE=true in env.
   */
  unavailability_fallback: 'BLOCK_CREDIT_ORDERS' | 'ALLOW_ON_CREDIT';
}

// ----------------------------------------------------------------
// Inbound: ERP → Adapter → Floatra
// ----------------------------------------------------------------

export interface InboundConfig {
  auth: InboundAuth;
  field_mappings: InboundFieldMappings;
  category_mappings: Record<string, string>;
  trigger_events: Record<string, TriggerEvent>;
  /**
   * - sync: respond to the ERP HTTP call with the Floatra decision
   * - callback: respond 202 immediately, deliver decision via
   *   callback_url
   */
  response_mode: 'sync' | 'callback';
  callback_url?: string;
}

export type InboundAuth =
  | { type: 'none' }
  | { type: 'api_key'; header_name: string; api_key: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'hmac'; hmac_header: string; hmac_secret: string };

export interface InboundFieldMappings {
  external_order_id: string; // JSONPath
  external_merchant_id: string; // JSONPath
  amount: string; // JSONPath
  amount_unit: 'NAIRA' | 'KOBO';
  agent_id?: string;
  delivery_date?: string;
  /** Either a JSONPath (resolved against payload) or a static value. */
  category?: string;
  /**
   * D-11: tenure in days. JSONPath (resolved against payload) OR a
   * static value. Spec §3.7 limits the merchant's accepted set to
   * {14, 30}; values outside that throw at translation time so the
   * gateway gets a clean DTO. When omitted the adapter defaults to
   * 14 (T0/T1 baseline tenure).
   */
  tenure_days?: string;
}

export interface TriggerEvent {
  /**
   * Safe-subset expression (==, !=, >, <, >=, <=, &&, ||) evaluated
   * against the inbound payload via JSONPath references.
   *
   * Example: "$.Status == 'Pending'"
   */
  condition: string;
  floatra_action: 'initiate_order' | 'confirm_delivery' | 'cancel_order';
}

// ----------------------------------------------------------------
// Outbound: Floatra → Adapter → ERP
// ----------------------------------------------------------------

export interface OutboundConfig {
  erp_webhook_url: string;
  erp_auth: OutboundAuth;
  event_mappings: Record<string, EventMapping>;
  /**
   * MUST set block_merchant_orders = true. The validator rejects
   * configs that don't — this is the structural enforcement layer
   * that prevents a distributor from accepting reorder-locked
   * webhooks without blocking the merchant.
   */
  on_reorder_locked: {
    block_merchant_orders: true;
    update_merchant_field: string;
    update_merchant_value: unknown;
  };
  on_reorder_unlocked: {
    unblock_merchant_orders: boolean;
    update_merchant_field: string;
    update_merchant_value: unknown;
  };
  /**
   * P2-17: outbound rate limit (per-minute) when POSTing to
   * `erp_webhook_url`. The fixed-window counter is keyed per
   * `platform_id`, so two platforms share no bucket. Burst-friendly
   * by design — within a minute the adapter can push up to the
   * limit, then waits until the window rolls over. Omitted = no
   * limiter applied (legacy v3.0 behaviour). Validator caps the
   * range to [1, 1000] req/min.
   */
  rate_limit_per_minute?: number;
}

export type OutboundAuth =
  | { type: 'none' }
  | { type: 'api_key'; header_name: string; api_key: string }
  | { type: 'basic'; username: string; password: string };

export interface EventMapping {
  erp_event_name: string;
  field_mappings: Record<string, string>;
  update_fields?: Array<{ erp_field: string; floatra_field: string }>;
  trigger_action?: string;
}

// ----------------------------------------------------------------
// Internal payload types
// ----------------------------------------------------------------

/** Core's OrderCategory enum — the only values InitiateOrderDto accepts. */
export const FLOATRA_CATEGORIES = [
  'FMCG',
  'ELECTRONICS',
  'FASHION',
  'AGRICULTURE',
  'PHARMACY',
  'OTHER',
] as const;
export type FloatraCategory = (typeof FLOATRA_CATEGORIES)[number];

/**
 * The Floatra-format payload produced by InboundTranslatorService.
 * Maps onto `POST /v1/partner/orders/initiate` (core's InitiateOrderDto,
 * which rejects unknown fields): `amount` is a 2-dp decimal-Naira string.
 */
export interface FloatraOrderPayload {
  external_order_id: string;
  external_merchant_id: string;
  amount: string;
  category: FloatraCategory;
  tenure_days: 14 | 30;
}

/**
 * The adapter's internal envelope for a webhook from Floatra core
 * (built by `toWebhookEvent`). `event_id` is the X-Floatra-Event-ID
 * header (core's delivery id); `event_type` is the payload's `event`;
 * `data` is core's FLAT payload as sent — camelCase fields, money as
 * decimal-Naira strings (e.g. `"amount": "250000.00"`). Mappings address
 * fields as `$.data.<coreField>`; OutboundTranslatorService routes via
 * event_mappings[event_type].
 */
export interface FloatraWebhookEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}
