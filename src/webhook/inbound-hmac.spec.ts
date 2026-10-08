import { createHmac } from 'node:crypto';
import { verifyInboundHmac } from './inbound-hmac';

const SECRET = 'erp-shared-secret';
const BODY = Buffer.from('{"OrderHeader":{"OrderId":"SO-1"}}');

function sig(body: Buffer = BODY, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyInboundHmac', () => {
  it('accepts a correct raw-hex signature', () => {
    expect(verifyInboundHmac(BODY, sig(), SECRET)).toBe(true);
  });

  it('accepts a signature with the optional sha256= prefix', () => {
    // Meta-style — some ERPs prefix; we accept either form.
    expect(verifyInboundHmac(BODY, `sha256=${sig()}`, SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from('{"OrderHeader":{"OrderId":"SO-2"}}');
    expect(verifyInboundHmac(tampered, sig(), SECRET)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifyInboundHmac(BODY, sig(BODY, 'different'), SECRET)).toBe(false);
  });

  it('rejects an empty signature', () => {
    expect(verifyInboundHmac(BODY, '', SECRET)).toBe(false);
  });

  it('rejects an empty secret (defensive — flags a config miss)', () => {
    expect(verifyInboundHmac(BODY, sig(), '')).toBe(false);
  });

  it('rejects garbage hex without throwing', () => {
    expect(verifyInboundHmac(BODY, 'not-hex-at-all', SECRET)).toBe(false);
  });

  it('rejects a truncated signature (length mismatch)', () => {
    expect(verifyInboundHmac(BODY, sig().slice(0, 32), SECRET)).toBe(false);
  });
});
