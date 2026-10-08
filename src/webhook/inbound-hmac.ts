import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify an inbound HMAC signature from an ERP webhook.
 *
 * Per Prompt 3 §"CONFIGURATION SCHEMA" — `inbound.auth.type = "hmac"`
 * means the ERP signs each request with `inbound.auth.hmac_secret`
 * and puts the result in the header named `inbound.auth.hmac_header`.
 *
 * Algorithm: HMAC-SHA256 over the raw body, hex-encoded (no prefix).
 * Same shape as Floatra core's outbound webhook signature — pick this
 * shape so distributors only have to learn one HMAC convention if
 * they integrate both directions.
 *
 * Constant-time compare via `timingSafeEqual` so an attacker can't
 * learn the signature byte-by-byte via response timing.
 *
 * Returns true iff the signature matches. Empty signature, empty
 * secret, or length mismatch all return false.
 */
export function verifyInboundHmac(
  rawBody: Buffer,
  signatureHex: string | undefined,
  secret: string,
): boolean {
  if (!signatureHex || !secret) return false;
  // Strip an optional `sha256=` prefix so ERPs that follow the Meta
  // convention (and many do) still work.
  const sigHex = signatureHex.startsWith('sha256=')
    ? signatureHex.slice(7)
    : signatureHex;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(sigHex, 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
