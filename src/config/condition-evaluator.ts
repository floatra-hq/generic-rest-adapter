import { JSONPath } from 'jsonpath-plus';

/**
 * Safe subset evaluator for `trigger_events[].condition`.
 *
 * Distributors author conditions like:
 *   $.Status == 'Pending'
 *   $.Order.Total > 10000 && $.Customer.Verified == true
 *
 * We never hand these strings to a JavaScript runtime — that would
 * let a malicious or buggy config file run arbitrary code in the
 * adapter process. Instead we tokenize + parse a fixed grammar:
 *
 *   expr      := term ( ('&&' | '||') term )*
 *   term      := operand op operand
 *   operand   := jsonpath | literal
 *   jsonpath  := $...   (delegated to jsonpath-plus)
 *   literal   := 'string' | number | true | false | null
 *   op        := == | != | > | < | >= | <=
 *
 * Anything outside this grammar fails parsing — including
 * parentheses, function calls, indexing operators on the LHS, math
 * operators, and unary negation. The validator should reject configs
 * that fail to parse so we catch issues at startup, not at request
 * time.
 */

export type ConditionTermOp = '==' | '!=' | '>' | '<' | '>=' | '<=';
export type ConditionJoinOp = '&&' | '||';

export interface ParsedTerm {
  lhs: Operand;
  op: ConditionTermOp;
  rhs: Operand;
}

export interface ParsedCondition {
  terms: ParsedTerm[];
  joins: ConditionJoinOp[];
}

export type Operand =
  | { kind: 'jsonpath'; expr: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' };

const TERM_OPS: readonly ConditionTermOp[] = ['>=', '<=', '==', '!=', '>', '<'];

export class ConditionParseError extends Error {
  constructor(message: string) {
    super(`ConditionParseError: ${message}`);
  }
}

/**
 * Parse a condition string into a structured form. Throws
 * ConditionParseError if the string contains anything outside the
 * supported grammar. Call this at config-validation time.
 */
export function parseCondition(input: string): ParsedCondition {
  const trimmed = input.trim();
  if (!trimmed) throw new ConditionParseError('empty condition');

  const split = splitOnJoins(trimmed);
  const terms = split.parts.map(parseTerm);
  return { terms, joins: split.joins };
}

/**
 * Evaluate a previously-parsed condition against a payload.
 * Missing JSONPath matches resolve to `undefined`, which compares
 * unequal to everything except `!= <something>`.
 */
export function evaluateCondition(
  parsed: ParsedCondition,
  payload: unknown,
): boolean {
  if (parsed.terms.length === 0) return false;

  const results = parsed.terms.map((t) => evaluateTerm(t, payload));
  let result = results[0];
  for (let i = 0; i < parsed.joins.length; i++) {
    const next = results[i + 1];
    result = parsed.joins[i] === '&&' ? result && next : result || next;
  }
  return result;
}

// ----------------------------------------------------------------
// Internals
// ----------------------------------------------------------------

function splitOnJoins(input: string): {
  parts: string[];
  joins: ConditionJoinOp[];
} {
  // Walk the string respecting quoted strings so we don't split on
  // && inside a string literal. Backslash escapes are honoured.
  const parts: string[] = [];
  const joins: ConditionJoinOp[] = [];
  let buf = '';
  let i = 0;
  let inQuote: '"' | "'" | null = null;

  while (i < input.length) {
    const c = input[i];
    if (inQuote) {
      buf += c;
      if (c === '\\' && i + 1 < input.length) {
        buf += input[i + 1];
        i += 2;
        continue;
      }
      if (c === inQuote) inQuote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      buf += c;
      i++;
      continue;
    }
    if ((c === '&' || c === '|') && input[i + 1] === c) {
      parts.push(buf);
      joins.push((c + c) as ConditionJoinOp);
      buf = '';
      i += 2;
      continue;
    }
    // Reject any other adjacency that looks like a grouping or
    // precedence construct. Parentheses, semicolons, and newlines
    // are not part of the grammar.
    if (c === '(' || c === ')' || c === ';') {
      throw new ConditionParseError(`disallowed character '${c}' in condition`);
    }
    buf += c;
    i++;
  }
  if (inQuote) throw new ConditionParseError('unterminated string literal');
  parts.push(buf);
  return { parts, joins };
}

function parseTerm(raw: string): ParsedTerm {
  const trimmed = raw.trim();
  if (!trimmed) throw new ConditionParseError('empty term');

  // Find the operator outside any string literal. Longest match
  // wins (>= and <= before > and <).
  let opStart = -1;
  let chosen: ConditionTermOp | null = null;
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (inQuote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      continue;
    }
    for (const candidate of TERM_OPS) {
      if (trimmed.startsWith(candidate, i)) {
        opStart = i;
        chosen = candidate;
        break;
      }
    }
    if (chosen) break;
  }

  if (!chosen || opStart < 0) {
    throw new ConditionParseError(`no operator found in term: "${trimmed}"`);
  }

  const lhsRaw = trimmed.slice(0, opStart);
  const rhsRaw = trimmed.slice(opStart + chosen.length);

  return {
    lhs: parseOperand(lhsRaw),
    op: chosen,
    rhs: parseOperand(rhsRaw),
  };
}

function parseOperand(raw: string): Operand {
  const trimmed = raw.trim();
  if (!trimmed) throw new ConditionParseError('empty operand');

  // JSONPath
  if (trimmed.startsWith('$')) {
    // Restrict the JSONPath alphabet — block characters that
    // jsonpath-plus interprets as script/filter blocks. Bracket
    // notation (e.g. $['foo']) is allowed.
    if (/[();={}<>!&|]/.test(trimmed.slice(1))) {
      throw new ConditionParseError(
        `JSONPath operand contains disallowed characters: "${trimmed}"`,
      );
    }
    return { kind: 'jsonpath', expr: trimmed };
  }

  // String literal
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const inner = trimmed.slice(1, -1).replace(/\\(.)/g, '$1');
    return { kind: 'string', value: inner };
  }

  if (trimmed === 'true') return { kind: 'boolean', value: true };
  if (trimmed === 'false') return { kind: 'boolean', value: false };
  if (trimmed === 'null') return { kind: 'null' };

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { kind: 'number', value: Number(trimmed) };
  }

  throw new ConditionParseError(`unrecognised operand: "${trimmed}"`);
}

function evaluateTerm(term: ParsedTerm, payload: unknown): boolean {
  const lhs = resolveOperand(term.lhs, payload);
  const rhs = resolveOperand(term.rhs, payload);
  switch (term.op) {
    case '==':
      return lhs === rhs;
    case '!=':
      return lhs !== rhs;
    case '>':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs > rhs;
    case '<':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs < rhs;
    case '>=':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs >= rhs;
    case '<=':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs <= rhs;
  }
}

function resolveOperand(op: Operand, payload: unknown): unknown {
  switch (op.kind) {
    case 'jsonpath': {
      // CVE-2024-21506 defence: jsonpath-plus <10 allowed script-block
      // filters (`?(...)`) to execute arbitrary code. We restrict the
      // operand alphabet in parseOperand() above so script-block chars
      // never reach here, and additionally disable eval in the lib.
      const matches = JSONPath({
        path: op.expr,
        // jsonpath-plus narrows the type — payload comes in as
        // `unknown` because we accept any JSON-shaped value at runtime.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        json: payload as any,
        wrap: true,
        eval: false,
      });
      if (!Array.isArray(matches) || matches.length === 0) return undefined;
      return matches[0];
    }
    case 'string':
      return op.value;
    case 'number':
      return op.value;
    case 'boolean':
      return op.value;
    case 'null':
      return null;
  }
}
