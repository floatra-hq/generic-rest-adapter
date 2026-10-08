import { createHmac } from 'node:crypto';
import {
  isTimestampFresh,
  MAX_TIMESTAMP_DRIFT_MS,
  verifyFloatraSignature,
} from './hmac-verifier';
import { loadWebhookFixture } from '../contract/fixtures';

const SECRET = 'floatra-webhook-test-secret';
const BODY = Buffer.from('{"event":"order.disbursed"}');

function specSig(
  body: Buffer = BODY,
  timestamp = '2026-05-31T12:00:00+01:00',
  secret = SECRET,
): string {
  const canonical = Buffer.concat([
    Buffer.from(timestamp, 'utf8'),
    Buffer.from('.', 'utf8'),
    body,
  ]);
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

describe('verifyFloatraSignature (P0-8 spec §4.1 input shape)', () => {
  const TIMESTAMP = '2026-05-31T12:00:00+01:00';

  it('accepts a spec-shape signature: HMAC(secret, timestamp + "." + body)', () => {
    expect(
      verifyFloatraSignature(BODY, specSig(BODY, TIMESTAMP), SECRET, TIMESTAMP),
    ).toBe(true);
  });

  // P0-8 regression: the v3.0 signature scheme was HMAC(secret, body)
  // — without the timestamp leg, a captured payload can be replayed
  // under a fresh timestamp and still validate. The new verifier
  // MUST refuse that downgrade.
  it('REJECTS the legacy v3.0 HMAC-over-body-only shape', () => {
    const legacySig = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifyFloatraSignature(BODY, legacySig, SECRET, TIMESTAMP)).toBe(
      false,
    );
  });

  it('rejects when the timestamp differs from the one that was signed', () => {
    const sigForOriginalTs = specSig(BODY, TIMESTAMP);
    expect(
      verifyFloatraSignature(
        BODY,
        sigForOriginalTs,
        SECRET,
        '2026-05-31T12:00:01+01:00',
      ),
    ).toBe(false);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from('{"event":"order.disbursed_tampered"}');
    expect(
      verifyFloatraSignature(
        tampered,
        specSig(BODY, TIMESTAMP),
        SECRET,
        TIMESTAMP,
      ),
    ).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(
      verifyFloatraSignature(
        BODY,
        specSig(BODY, TIMESTAMP, 'different'),
        SECRET,
        TIMESTAMP,
      ),
    ).toBe(false);
  });

  it('rejects empty / undefined inputs defensively', () => {
    expect(verifyFloatraSignature(BODY, '', SECRET, TIMESTAMP)).toBe(false);
    expect(verifyFloatraSignature(BODY, undefined, SECRET, TIMESTAMP)).toBe(
      false,
    );
    expect(verifyFloatraSignature(BODY, specSig(), '', TIMESTAMP)).toBe(false);
    expect(verifyFloatraSignature(BODY, specSig(), SECRET, undefined)).toBe(
      false,
    );
    expect(verifyFloatraSignature(BODY, specSig(), SECRET, '')).toBe(false);
  });

  it('rejects garbage hex without throwing', () => {
    expect(
      verifyFloatraSignature(BODY, 'not-hex-at-all', SECRET, TIMESTAMP),
    ).toBe(false);
  });

  it('rejects a truncated signature (length mismatch)', () => {
    expect(
      verifyFloatraSignature(BODY, specSig().slice(0, 32), SECRET, TIMESTAMP),
    ).toBe(false);
  });
});

describe('against core-rendered deliveries', () => {
  for (const name of [
    'webhook-order.credit_approved',
    'webhook-order.disbursed',
    'webhook-merchant.reorder_locked',
    'webhook-merchant.reorder_unlocked',
  ]) {
    it(`${name}: signature verifies and timestamp is fresh at send time`, () => {
      const f = loadWebhookFixture(name);
      const ts = f.headers['X-Floatra-Timestamp'];
      expect(
        verifyFloatraSignature(
          Buffer.from(f.body),
          f.headers['X-Floatra-Signature'],
          f.secret,
          ts,
        ),
      ).toBe(true);
      expect(isTimestampFresh(ts, Number(ts) * 1000)).toBe(true);
    });
  }
});

describe('isTimestampFresh (unix seconds, P0-9 ±5 min replay window)', () => {
  const now = 1_790_000_000_000;
  it('accepts within ±5 min', () => {
    expect(isTimestampFresh('1790000000', now)).toBe(true);
    expect(isTimestampFresh(String(1_790_000_000 - 299), now)).toBe(true);
  });
  it('rejects beyond 5 min either side', () => {
    expect(isTimestampFresh(String(1_790_000_000 - 301), now)).toBe(false);
    expect(isTimestampFresh(String(1_790_000_000 + 301), now)).toBe(false);
  });
  it('rejects ISO and millisecond timestamps instead of misreading them', () => {
    expect(isTimestampFresh(new Date(now).toISOString(), now)).toBe(false);
    expect(isTimestampFresh(String(now), now)).toBe(false);
  });
  it('rejects missing / garbage', () => {
    expect(isTimestampFresh(undefined, now)).toBe(false);
    expect(isTimestampFresh('abc', now)).toBe(false);
    expect(isTimestampFresh('', now)).toBe(false);
  });
  it('exposes the ±5 min drift constant', () => {
    expect(MAX_TIMESTAMP_DRIFT_MS).toBe(5 * 60 * 1000);
  });
});
