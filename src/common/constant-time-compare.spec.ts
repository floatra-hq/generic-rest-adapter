import { constantTimeEqual } from './constant-time-compare';

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('sk_secret_value', 'sk_secret_value')).toBe(true);
  });

  it('returns false for different same-length strings', () => {
    expect(constantTimeEqual('sk_secret_value', 'sk_secret_valuX')).toBe(false);
  });

  it('returns false for different-length strings (no throw)', () => {
    expect(constantTimeEqual('short', 'a-much-longer-secret')).toBe(false);
  });

  it('returns false when one side is empty', () => {
    expect(constantTimeEqual('', 'secret')).toBe(false);
    expect(constantTimeEqual('secret', '')).toBe(false);
  });

  it('handles unicode without throwing', () => {
    expect(constantTimeEqual('kéy', 'kéy')).toBe(true);
    expect(constantTimeEqual('kéy', 'key')).toBe(false);
  });
});
