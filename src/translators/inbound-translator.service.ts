import { Injectable, Logger } from '@nestjs/common';
import { inspect } from 'node:util';
import {
  FloatraAdapterConfig,
  FloatraCategory,
  FloatraOrderPayload,
  TriggerEvent,
} from '../config/config.types';
import {
  evaluateCondition,
  parseCondition,
} from '../config/condition-evaluator';
import { extractFirst } from './jsonpath.util';

const MIN_AMOUNT_KOBO = 1_000_000; // ₦10,000 floor
const MAX_AMOUNT_KOBO = 1_500_000_000; // ₦15M ceiling
const KOBO_PER_NAIRA = 100;
const DEFAULT_CATEGORY: FloatraCategory = 'OTHER';

/**
 * Non-negative integer kobo → decimal-Naira string with exactly 2 dp, no
 * float math. Negative or fractional kobo has no valid rendering (it would
 * emit e.g. '-0.-5'), so it is refused rather than formatted.
 */
export function koboToNairaString(kobo: number): string {
  if (!Number.isInteger(kobo) || kobo < 0) {
    throw new RangeError(
      `koboToNairaString requires a non-negative integer, got ${kobo}`,
    );
  }
  const whole = Math.trunc(kobo / KOBO_PER_NAIRA);
  const frac = kobo % KOBO_PER_NAIRA;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

export class InboundTranslationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

type Scalar = string | number | boolean;

function isScalar(v: unknown): v is Scalar {
  return (
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  );
}

/**
 * Normalise a non-null extracted value to a scalar. A single-element
 * array of a scalar unwraps (xml2js `explicitArray` output); anything
 * else (object, empty / multi-element / nested array) is refused rather
 * than stringified into an id or category core would accept silently.
 */
function toScalar(raw: unknown, field: string, sourcePath: string): Scalar {
  if (isScalar(raw)) return raw;
  if (Array.isArray(raw) && raw.length === 1 && isScalar(raw[0])) {
    return raw[0];
  }
  throw new InboundTranslationError(
    'FIELD_NOT_SCALAR',
    `Field "${field}" at JSONPath "${sourcePath}" is not a scalar (or a single-element array of one)`,
  );
}

export interface TranslationResult {
  payload: FloatraOrderPayload;
  triggerName: string;
  action: TriggerEvent['floatra_action'];
}

/**
 * Translates an ERP-native inbound payload into a Floatra-format
 * `initiate_order` / `confirm_delivery` / `cancel_order` call by
 * walking the per-platform config.
 *
 * Steps:
 *   1. Evaluate every `trigger_events[].condition` against the
 *      payload. The first matching trigger wins.
 *   2. Extract the configured JSONPath field mappings.
 *   3. Convert amount → integer kobo using `amount_unit` (for the
 *      band check), then serialize as a 2-dp decimal-Naira string.
 *   4. Resolve category via `category_mappings` (or static value).
 *   5. Validate required fields + amount bounds.
 */
@Injectable()
export class InboundTranslatorService {
  private readonly logger = new Logger(InboundTranslatorService.name);

  translate(payload: unknown, config: FloatraAdapterConfig): TranslationResult {
    const trigger = this.matchTrigger(payload, config);
    if (!trigger) {
      throw new InboundTranslationError(
        'NO_TRIGGER_MATCH',
        'No trigger_events condition matched the inbound payload',
      );
    }

    const fm = config.inbound.field_mappings;

    const externalOrderId = this.requireString(
      extractFirst(fm.external_order_id, payload),
      'external_order_id',
      fm.external_order_id,
    );
    const externalMerchantId = this.requireString(
      extractFirst(fm.external_merchant_id, payload),
      'external_merchant_id',
      fm.external_merchant_id,
    );

    const amountRaw = extractFirst(fm.amount, payload);
    const amountKobo = this.coerceAmount(amountRaw, fm.amount_unit, fm.amount);
    if (amountKobo < MIN_AMOUNT_KOBO || amountKobo > MAX_AMOUNT_KOBO) {
      throw new InboundTranslationError(
        'AMOUNT_OUT_OF_BAND',
        `Amount ${amountKobo} kobo outside [${MIN_AMOUNT_KOBO}, ${MAX_AMOUNT_KOBO}]`,
      );
    }

    const category = this.resolveCategory(payload, config);
    const tenureDays = this.resolveTenureDays(payload, config);

    return {
      action: trigger.action,
      triggerName: trigger.name,
      payload: {
        external_order_id: externalOrderId,
        external_merchant_id: externalMerchantId,
        amount: koboToNairaString(amountKobo),
        category,
        tenure_days: tenureDays,
      },
    };
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private matchTrigger(
    payload: unknown,
    config: FloatraAdapterConfig,
  ): { name: string; action: TriggerEvent['floatra_action'] } | null {
    for (const [name, evt] of Object.entries(config.inbound.trigger_events)) {
      try {
        const parsed = parseCondition(evt.condition);
        if (evaluateCondition(parsed, payload)) {
          return { name, action: evt.floatra_action };
        }
      } catch (err) {
        // Validator runs at startup, so this branch is defensive —
        // log and continue rather than abort the request.
        this.logger.error(
          `Condition for trigger "${name}" failed to parse at request time: ${err instanceof Error ? err.message : inspect(err)}`,
        );
      }
    }
    return null;
  }

  private requireString(
    raw: unknown,
    fieldName: string,
    sourcePath: string,
  ): string {
    if (raw === null || raw === undefined) {
      throw new InboundTranslationError(
        'MISSING_REQUIRED_FIELD',
        `Required field "${fieldName}" missing — JSONPath "${sourcePath}" produced no match`,
      );
    }
    const s = String(toScalar(raw, fieldName, sourcePath)).trim();
    if (s.length === 0) {
      throw new InboundTranslationError(
        'MISSING_REQUIRED_FIELD',
        `Required field "${fieldName}" extracted to empty string from "${sourcePath}"`,
      );
    }
    return s;
  }

  /**
   * Coerce a JSON-extracted amount (number | string) into integer
   * kobo. Honour `amount_unit`:
   *   - KOBO: round to integer, no scaling
   *   - NAIRA: multiply by 100, round to integer
   */
  private coerceAmount(
    raw: unknown,
    unit: 'NAIRA' | 'KOBO',
    sourcePath: string,
  ): number {
    if (raw === null || raw === undefined) {
      throw new InboundTranslationError(
        'MISSING_REQUIRED_FIELD',
        'Required field "amount" missing — JSONPath produced no match',
      );
    }
    const scalar = toScalar(raw, 'amount', sourcePath);
    const n = typeof scalar === 'number' ? scalar : Number(String(scalar));
    if (!Number.isFinite(n)) {
      throw new InboundTranslationError(
        'AMOUNT_NOT_NUMERIC',
        `amount could not be parsed as number: ${String(scalar)}`,
      );
    }
    if (unit === 'KOBO') return Math.round(n);
    return Math.round(n * KOBO_PER_NAIRA);
  }

  /**
   * D-11: resolve tenure_days from the inbound mapping if present,
   * otherwise default to 14 (T0/T1 baseline). Spec §3.7 accepts
   * only {14, 30}; anything else fails translation so the gateway
   * never sees a non-spec value.
   */
  private resolveTenureDays(
    payload: unknown,
    config: FloatraAdapterConfig,
  ): FloatraOrderPayload['tenure_days'] {
    const fm = config.inbound.field_mappings;
    if (!fm.tenure_days) return 14;

    let raw: Scalar;
    if (fm.tenure_days.startsWith('$')) {
      const extracted = extractFirst(fm.tenure_days, payload);
      if (extracted === null || extracted === undefined) return 14;
      raw = toScalar(extracted, 'tenure_days', fm.tenure_days);
    } else {
      raw = fm.tenure_days;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || (n !== 14 && n !== 30)) {
      throw new InboundTranslationError(
        'TENURE_DAYS_INVALID',
        `tenure_days "${String(raw)}" is not in the spec set {14, 30}`,
      );
    }
    return n;
  }

  private resolveCategory(
    payload: unknown,
    config: FloatraAdapterConfig,
  ): FloatraCategory {
    const fm = config.inbound.field_mappings;
    if (!fm.category) return DEFAULT_CATEGORY;

    let erpCategory: string;
    if (fm.category.startsWith('$')) {
      const v = extractFirst(fm.category, payload);
      if (v === null || v === undefined) {
        throw new InboundTranslationError(
          'CATEGORY_NOT_FOUND',
          `category JSONPath "${fm.category}" produced no match`,
        );
      }
      erpCategory = String(toScalar(v, 'category', fm.category));
    } else {
      // Static category — use as-is (still passes through the
      // mapping table so distributors can normalize via a single
      // dictionary).
      erpCategory = fm.category;
    }

    const mapped = config.inbound.category_mappings[erpCategory];
    if (!mapped) {
      throw new InboundTranslationError(
        'CATEGORY_UNMAPPED',
        `ERP category "${erpCategory}" has no entry in inbound.category_mappings`,
      );
    }
    // ConfigValidatorService rejects mapping values outside
    // FLOATRA_CATEGORIES at boot, so the cast is safe.
    return mapped as FloatraCategory;
  }
}
