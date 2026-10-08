import { isLiveKey, webhookRealmMatches } from './webhook-realm';

describe('webhook realm', () => {
  it('treats only live_pk_ keys as live', () => {
    expect(isLiveKey('live_pk_abc')).toBe(true);
    expect(isLiveKey('sbx_pk_abc')).toBe(false);
    expect(isLiveKey('pk_abc')).toBe(false);
    expect(isLiveKey('')).toBe(false);
    expect(isLiveKey(undefined)).toBe(false);
  });

  it('accepts an event only from the key realm', () => {
    expect(webhookRealmMatches({ livemode: false }, false)).toBe(true);
    expect(webhookRealmMatches({ livemode: true }, true)).toBe(true);
    expect(webhookRealmMatches({ livemode: true }, false)).toBe(false);
    expect(webhookRealmMatches({ livemode: false }, true)).toBe(false);
  });

  it('accepts an unmarked event for a sandbox key only', () => {
    expect(webhookRealmMatches({}, false)).toBe(true);
    expect(webhookRealmMatches({ livemode: null }, false)).toBe(true);
    expect(webhookRealmMatches({}, true)).toBe(false);
  });

  it('never matches a non-boolean livemode', () => {
    expect(webhookRealmMatches({ livemode: 'true' }, true)).toBe(false);
    expect(webhookRealmMatches({ livemode: 0 }, false)).toBe(false);
  });
});
