import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison for secrets.
 *
 * Use when comparing an attacker-supplied value (request header, token)
 * against a configured secret. A plain `===`/`!==` short-circuits on the
 * first differing byte, leaking a timing side-channel that can recover the
 * secret byte-by-byte. `timingSafeEqual` compares the full buffers in
 * constant time.
 *
 * A length mismatch returns false immediately (lengths are not secret in
 * the same way byte contents are, and timingSafeEqual requires equal-length
 * buffers).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
