import {
  evaluateCondition,
  parseCondition,
  ConditionParseError,
} from './condition-evaluator';

describe('parseCondition (security-critical)', () => {
  describe('accepted grammar', () => {
    it('parses a simple equality', () => {
      expect(() => parseCondition("$.Status == 'Pending'")).not.toThrow();
    });

    it('parses numeric comparison', () => {
      expect(() => parseCondition('$.Order.Total > 10000')).not.toThrow();
    });

    it('parses boolean literal', () => {
      expect(() => parseCondition('$.Verified == true')).not.toThrow();
    });

    it('parses && combination', () => {
      expect(() => parseCondition("$.A == 'x' && $.B > 5")).not.toThrow();
    });

    it('parses || combination', () => {
      expect(() => parseCondition("$.A == 'x' || $.A == 'y'")).not.toThrow();
    });

    it('handles && inside a quoted string literal', () => {
      const parsed = parseCondition("$.S == 'a && b'");
      expect(parsed.terms).toHaveLength(1);
      expect(parsed.terms[0].rhs).toEqual({ kind: 'string', value: 'a && b' });
    });
  });

  describe('rejected: arbitrary code / unsupported syntax', () => {
    it('rejects parentheses', () => {
      expect(() => parseCondition("($.A == 'x')")).toThrow(ConditionParseError);
    });

    it('rejects semicolons', () => {
      expect(() => parseCondition("$.A == 'x'; doSomething()")).toThrow(
        ConditionParseError,
      );
    });

    it('rejects function-call-style JSONPath', () => {
      expect(() => parseCondition('$.foo() == 1')).toThrow(ConditionParseError);
    });

    it('rejects assignment in JSONPath', () => {
      expect(() => parseCondition('$.x=1 == 1')).toThrow(ConditionParseError);
    });

    it('rejects unterminated string', () => {
      expect(() => parseCondition("$.A == 'oops")).toThrow(ConditionParseError);
    });

    it('rejects empty input', () => {
      expect(() => parseCondition('   ')).toThrow(ConditionParseError);
    });

    it('rejects term without operator', () => {
      expect(() => parseCondition('$.A')).toThrow(ConditionParseError);
    });

    it('rejects unrecognised operand', () => {
      expect(() => parseCondition('foo == bar')).toThrow(ConditionParseError);
    });
  });
});

describe('evaluateCondition', () => {
  it('matches string equality', () => {
    const c = parseCondition("$.Status == 'Pending'");
    expect(evaluateCondition(c, { Status: 'Pending' })).toBe(true);
    expect(evaluateCondition(c, { Status: 'Shipped' })).toBe(false);
  });

  it('matches numeric > comparison', () => {
    const c = parseCondition('$.Total > 10000');
    expect(evaluateCondition(c, { Total: 15000 })).toBe(true);
    expect(evaluateCondition(c, { Total: 5000 })).toBe(false);
    expect(evaluateCondition(c, { Total: 10000 })).toBe(false);
  });

  it('matches boolean equality', () => {
    const c = parseCondition('$.Flag == true');
    expect(evaluateCondition(c, { Flag: true })).toBe(true);
    expect(evaluateCondition(c, { Flag: false })).toBe(false);
  });

  it('returns false for missing JSONPath match in == comparison', () => {
    const c = parseCondition("$.Nonexistent == 'x'");
    expect(evaluateCondition(c, { Other: 1 })).toBe(false);
  });

  it('returns true for missing JSONPath in != comparison (undefined !== "x")', () => {
    const c = parseCondition("$.Nonexistent != 'x'");
    expect(evaluateCondition(c, { Other: 1 })).toBe(true);
  });

  it('honours && short-circuit semantics across terms', () => {
    const c = parseCondition("$.A == 'x' && $.B > 5");
    expect(evaluateCondition(c, { A: 'x', B: 10 })).toBe(true);
    expect(evaluateCondition(c, { A: 'x', B: 1 })).toBe(false);
    expect(evaluateCondition(c, { A: 'y', B: 10 })).toBe(false);
  });

  it('honours || semantics across terms', () => {
    const c = parseCondition("$.A == 'x' || $.A == 'y'");
    expect(evaluateCondition(c, { A: 'x' })).toBe(true);
    expect(evaluateCondition(c, { A: 'y' })).toBe(true);
    expect(evaluateCondition(c, { A: 'z' })).toBe(false);
  });

  it('numeric comparison with non-numeric operand returns false (not throws)', () => {
    const c = parseCondition('$.Total > 10');
    expect(evaluateCondition(c, { Total: 'oops' })).toBe(false);
  });

  it('extracts deep JSONPath', () => {
    const c = parseCondition("$.Order.Header.Status == 'OK'");
    expect(evaluateCondition(c, { Order: { Header: { Status: 'OK' } } })).toBe(
      true,
    );
  });
});
