import { extractFirst } from './jsonpath.util';

describe('extractFirst', () => {
  it('returns the matched value for a simple path', () => {
    expect(extractFirst('$.order.amount', { order: { amount: 4500 } })).toBe(
      4500,
    );
  });

  it('returns undefined for an empty path', () => {
    expect(extractFirst('', { foo: 1 })).toBeUndefined();
  });

  it('returns undefined for a path that does not start with $', () => {
    expect(
      extractFirst('order.amount', { order: { amount: 1 } }),
    ).toBeUndefined();
  });

  it('returns undefined when the path does not match', () => {
    expect(extractFirst('$.missing', { foo: 1 })).toBeUndefined();
  });

  // CVE-2024-21506 regression — JSONPath script-block filter syntax
  // (`?(...)`) must never reach the underlying library. The path is
  // rejected at the alphabet check before evaluation, and jsonpath-plus
  // v10+ with eval:false is the defence-in-depth backstop.
  describe('CVE-2024-21506 mitigation', () => {
    const SCRIPT_BLOCK_PATHS = [
      `$[?(1==1)]`,
      `$..book[?(@.price < 10)]`,
      `$[?(process.exit(1))]`,
      `$[(@.length-1)]`,
      `$[?({}.constructor)]`,
    ];

    it.each(SCRIPT_BLOCK_PATHS)(
      'rejects script-block-style path: %s',
      (path) => {
        expect(
          extractFirst(path, { book: [{ price: 5 }, { price: 15 }] }),
        ).toBeUndefined();
      },
    );

    it('does not execute a side effect via a script block', () => {
      const sideEffect = jest.fn();
      // If the path were evaluated, calling this canary in the filter
      // body would tick the spy. With the alphabet guard + eval:false,
      // it must not.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__cve_2024_21506_canary = sideEffect;
      try {
        extractFirst(`$[?(__cve_2024_21506_canary())]`, { x: 1 });
      } catch {
        // swallow — extractFirst returns undefined on parse failure
      }
      expect(sideEffect).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).__cve_2024_21506_canary;
    });
  });
});
