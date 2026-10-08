import { EventDedupService } from './event-dedup.service';

/**
 * P0-10: spec §4.1 event-ID dedup.
 *
 * Without server-side dedup, Floatra's retry budget (5 attempts at
 * 1m / 5m / 15m / 1h / 4h) means a single retried
 * merchant.reorder_locked event could fan out to the partner ERP
 * up to 5 times. The dedup short-circuits all but the first.
 */
describe('EventDedupService', () => {
  function makeRedis(initialSet: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initialSet));
    return {
      set: jest.fn(
        async (
          key: string,
          value: string,
          _ex: string,
          _ttl: number,
          mode: string,
        ) => {
          if (mode === 'NX' && store.has(key)) return null;
          store.set(key, value);
          return 'OK';
        },
      ),
      del: jest.fn(async (key: string) => {
        const had = store.has(key);
        store.delete(key);
        return had ? 1 : 0;
      }),
    };
  }

  it('returns false (not duplicate) on the first claim for an event ID', async () => {
    const redis = makeRedis();
    const svc = new EventDedupService(redis as never);
    expect(await svc.isDuplicate('evt-1')).toBe(false);
    // Claim was set with a 24h TTL.
    expect(redis.set).toHaveBeenCalledWith(
      'floatra_evt:evt-1',
      '1',
      'EX',
      24 * 60 * 60,
      'NX',
    );
  });

  it('returns true (duplicate) on the second claim for the same event ID', async () => {
    const redis = makeRedis();
    const svc = new EventDedupService(redis as never);
    await svc.isDuplicate('evt-1'); // first claim
    expect(await svc.isDuplicate('evt-1')).toBe(true); // retry deduped
  });

  it('returns false for an undefined event ID (defensive — caller falls back to body event_id)', async () => {
    const redis = makeRedis();
    const svc = new EventDedupService(redis as never);
    expect(await svc.isDuplicate(undefined)).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('release() removes the claim so a retry can re-attempt', async () => {
    const redis = makeRedis();
    const svc = new EventDedupService(redis as never);
    await svc.isDuplicate('evt-1'); // claim
    await svc.release('evt-1');
    // Now a retry should NOT be deduped.
    expect(await svc.isDuplicate('evt-1')).toBe(false);
  });

  it('release() is a no-op for an undefined event ID', async () => {
    const redis = makeRedis();
    const svc = new EventDedupService(redis as never);
    await svc.release(undefined);
    expect(redis.del).not.toHaveBeenCalled();
  });
});
