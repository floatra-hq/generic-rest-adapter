/**
 * Which realm (live vs sandbox) a Floatra webhook belongs to, and whether it
 * matches the realm of the adapter's configured API key.
 *
 * A platform's sandbox and live keys share webhook destinations AND the
 * signing secret, so a valid signature says nothing about the realm. Core
 * stamps a top-level `livemode` boolean on every delivery; this is the only
 * signal. Without the check, a sandbox test event (e.g. a sandbox
 * `order.credit_approved`) would reach a production ERP and fire its
 * `trigger_action` (release to warehouse) for real.
 *
 * Same rule as the Odoo and ERPNext connectors (`webhook_realm_matches`):
 *   - `livemode` is a boolean: it must equal the key's realm;
 *   - `livemode` is absent (only deliveries queued before core added it):
 *     refused for a LIVE key, since it could be a sandbox event about records
 *     named like real ones, and accepted for a sandbox key, where the worst
 *     case is a sandbox record updated from an old event;
 *   - anything else (a non-boolean `livemode`) never matches.
 */

/** Core mints live platform keys ONLY as `live_pk_<hex>`. */
export const LIVE_KEY_PREFIX = 'live_pk_';

export function isLiveKey(apiKey: string | undefined | null): boolean {
  return typeof apiKey === 'string' && apiKey.startsWith(LIVE_KEY_PREFIX);
}

export function webhookRealmMatches(
  payload: Record<string, unknown>,
  liveKey: boolean,
): boolean {
  const livemode = payload.livemode;
  if (livemode === undefined || livemode === null) {
    return !liveKey;
  }
  return typeof livemode === 'boolean' && livemode === liveKey;
}
