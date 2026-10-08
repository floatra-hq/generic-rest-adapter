import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Spec v3.1 §4.1: ±5-minute timestamp drift window. Webhook
 * receivers MUST reject any payload outside the window even if
 * the HMAC validates — without this, a captured payload + sig pair
 * can be replayed indefinitely (or until secret rotation).
 */
export const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

/**
 * Verify the HMAC-SHA256 signature Floatra applies to outbound
 * webhooks.
 *
 * **Spec v3.1 §4.1 input shape (P0-8):** the gateway signs
 *     HMAC-SHA256(secret, X-Floatra-Timestamp + "." + rawBody)
 *
 * v3.0 of this adapter computed `HMAC(secret, rawBody)` alone —
 * which would not validate against a spec-compliant Gateway, AND
 * gave up the replay-protection that timestamp binding provides
 * (a captured payload can be replayed under a fresh timestamp
 * without re-signing).
 *
 * timingSafeEqual avoids leaking the secret via a timing
 * side-channel.
 */
export function verifyFloatraSignature(
  rawBody: Buffer,
  signatureHex: string | undefined,
  secret: string,
  timestamp: string | undefined,
): boolean {
  if (!signatureHex || !timestamp || !secret) return false;
  const canonical = Buffer.concat([
    Buffer.from(timestamp, 'utf8'),
    Buffer.from('.', 'utf8'),
    rawBody,
  ]);
  const expected = createHmac('sha256', secret).update(canonical).digest('hex');
  const a = Buffer.from(expected, 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(signatureHex, 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A unix-seconds timestamp: digits only, 9–11 long (rejects ms and ISO). */
const UNIX_SECONDS = /^\d{9,11}$/;
const MS_PER_SECOND = 1000;

/**
 * Returns true iff the given X-Floatra-Timestamp — unix SECONDS, as
 * core sends it (see partner-webhooks.processor.ts) — falls within
 * MAX_TIMESTAMP_DRIFT_MS of the receiver's wall clock. ISO strings and
 * millisecond timestamps are rejected rather than misread.
 *
 * P0-9: even when the HMAC is valid, a captured-but-not-tampered
 * payload can be replayed indefinitely. The freshness check is the
 * second leg of replay protection alongside the signature's
 * timestamp binding.
 *
 * Exported as its own function so the controller can call it
 * after verifyFloatraSignature with a single concern per call.
 */
export function isTimestampFresh(
  timestamp: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!timestamp || !UNIX_SECONDS.test(timestamp)) return false;
  return (
    Math.abs(now - Number(timestamp) * MS_PER_SECOND) <= MAX_TIMESTAMP_DRIFT_MS
  );
}
