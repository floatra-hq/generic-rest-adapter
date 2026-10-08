import { OutboundRateLimiterService } from './outbound-rate-limiter.service';

/**
 * P2-17: per-platform fixed-window rate limit. The service is
 * deliberately built without a sleep-real-time dependency at the
 * unit-test level — we control wall-clock + setTimeout via jest
 * fake timers + a counter mock for the Redis bucket.
 */

describe('OutboundRateLimiterService (P2-17)', () => {
  function makeRedis() {
    const store = new Map<string, number>();
    return {
      store,
      incr: jest.fn(async (key: string) => {
        const next = (store.get(key) ?? 0) + 1;
        store.set(key, next);
        return next;
      }),
      decr: jest.fn(async (key: string) => {
        const next = (store.get(key) ?? 0) - 1;
        store.set(key, next);
        return next;
      }),
      expire: jest.fn(async (_key: string, _ttl: number) => 1),
    };
  }

  function build() {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new OutboundRateLimiterService(redis as any);
    return { redis, svc };
  }

  it('no-ops when ratePerMinute is undefined (legacy adapter config)', async () => {
    const { redis, svc } = build();
    await svc.acquire('plat-A', undefined);
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('no-ops when ratePerMinute is 0 (explicit-disable)', async () => {
    const { redis, svc } = build();
    await svc.acquire('plat-A', 0);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('allows up to N calls within a single minute window', async () => {
    const { redis, svc } = build();
    for (let i = 0; i < 5; i++) {
      await svc.acquire('plat-A', 5);
    }
    expect(redis.incr).toHaveBeenCalledTimes(5);
    // EXPIRE only fires on the first INCR (used === 1).
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.decr).not.toHaveBeenCalled();
  });

  it('scopes buckets per platform (Platform A budget does not affect Platform B)', async () => {
    const { redis, svc } = build();
    await svc.acquire('plat-A', 1);
    await svc.acquire('plat-B', 1);
    // Each platform got its own first-window INCR + EXPIRE.
    expect(redis.expire).toHaveBeenCalledTimes(2);
    const keys = redis.expire.mock.calls.map((c) => c[0] as string);
    expect(keys[0]).toMatch(/plat-A/);
    expect(keys[1]).toMatch(/plat-B/);
  });

  it('rolls back the INCR when the slot is over budget so the counter stays accurate', async () => {
    const { redis, svc } = build();
    // Pre-fill the bucket to the limit.
    await svc.acquire('plat-A', 2);
    await svc.acquire('plat-A', 2);
    expect(redis.incr).toHaveBeenCalledTimes(2);
    expect(redis.decr).not.toHaveBeenCalled();

    // A 3rd attempt pushes to 3 (> 2). The limiter should INCR,
    // notice over-budget, then DECR before sleeping. We tear the
    // caller down before the wait loop finishes — the unit
    // contract under test is "over-budget = at least one DECR",
    // not "throws after 30s".
    const racing = svc.acquire('plat-A', 2);
    // Yield so the limiter's microtask runs to the first DECR.
    await new Promise((r) => setTimeout(r, 50));
    expect(redis.incr).toHaveBeenCalledTimes(3);
    expect(redis.decr).toHaveBeenCalled();
    // The counter (post-DECR) stays at the limit, not 3.
    const bucketKey = Array.from(redis.store.keys())[0];
    expect(redis.store.get(bucketKey)).toBe(2);
    // Don't await `racing` — it's still polling. Free a slot so
    // it resolves cleanly instead of leaking.
    redis.store.set(bucketKey, 0);
    await racing;
  });

  it('keys buckets by minute so callers rotate forward into a new window', async () => {
    const { redis, svc } = build();
    const realNow = Date.now;
    // Pin "now" at minute 100 — first 3 calls land in bucket
    // ...:100.
    Date.now = (): number => 100 * 60_000;
    await svc.acquire('plat-A', 3);
    await svc.acquire('plat-A', 3);
    await svc.acquire('plat-A', 3);

    // Roll to minute 101 — fresh bucket.
    Date.now = (): number => 101 * 60_000;
    await svc.acquire('plat-A', 3);

    Date.now = realNow;

    const incrKeys = redis.incr.mock.calls.map((c) => c[0] as string);
    expect(incrKeys.slice(0, 3)).toEqual(
      Array(3).fill('floatra:adapter:outbound:rate:plat-A:100'),
    );
    expect(incrKeys[3]).toBe('floatra:adapter:outbound:rate:plat-A:101');
  });
});
