import {
  InboundTranslationError,
  InboundTranslatorService,
  koboToNairaString,
} from './inbound-translator.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FloatraAdapterConfig,
  InboundFieldMappings,
} from '../config/config.types';
import { loadJsonFixture } from '../contract/fixtures';

const EXAMPLE_CONFIG_PATH = join(
  __dirname,
  '..',
  '..',
  'configs',
  'example.json',
);

/** configs/example.json with `overrides` applied onto inbound.field_mappings. */
function exampleConfig(
  overrides: Partial<InboundFieldMappings> = {},
): FloatraAdapterConfig {
  const cfg = JSON.parse(
    readFileSync(EXAMPLE_CONFIG_PATH, 'utf8'),
  ) as FloatraAdapterConfig;
  cfg.inbound.field_mappings = { ...cfg.inbound.field_mappings, ...overrides };
  return cfg;
}

function baseConfig(
  overrides: {
    category?: string;
    categoryMappings?: Record<string, string>;
    amountUnit?: 'NAIRA' | 'KOBO';
    condition?: string;
  } = {},
): FloatraAdapterConfig {
  return {
    erp_type: 'TEST',
    platform_id: 'plat_test',
    api_key: 'k',
    webhook_secret: 's',
    floatra_gateway_url: 'https://example/v1',
    unavailability_fallback: 'BLOCK_CREDIT_ORDERS',
    inbound: {
      auth: { type: 'none' },
      field_mappings: {
        external_order_id: '$.OrderHeader.OrderId',
        external_merchant_id: '$.OrderHeader.CustomerCode',
        amount: '$.OrderHeader.Total',
        amount_unit: overrides.amountUnit ?? 'NAIRA',
        category: overrides.category ?? '$.OrderHeader.Group',
      },
      category_mappings: overrides.categoryMappings ?? {
        BEVERAGES: 'FMCG',
        PHARMACY: 'PHARMACY',
      },
      trigger_events: {
        order_pending: {
          condition: overrides.condition ?? "$.OrderHeader.Status == 'Pending'",
          floatra_action: 'initiate_order',
        },
      },
      response_mode: 'sync',
    },
    outbound: {
      erp_webhook_url: 'https://erp/x',
      erp_auth: { type: 'none' },
      event_mappings: {},
      on_reorder_locked: {
        block_merchant_orders: true,
        update_merchant_field: 'CreditHold',
        update_merchant_value: true,
      },
      on_reorder_unlocked: {
        unblock_merchant_orders: true,
        update_merchant_field: 'CreditHold',
        update_merchant_value: false,
      },
    },
  };
}

describe('InboundTranslatorService', () => {
  let svc: InboundTranslatorService;

  beforeEach(() => {
    svc = new InboundTranslatorService();
  });

  // The body core's InitiateOrderDto accepts: `amount` as a 2-dp
  // decimal-Naira string, `category` from core's OrderCategory enum.
  describe('initiate request contract (InitiateOrderDto)', () => {
    const erpOrder = {
      OrderHeader: {
        OrderId: 'SO-1001',
        CustomerCode: 'CUST-77',
        Total: 250000 as unknown,
        CustomerGroup: 'BEVERAGES',
        Status: 'Pending',
        PaymentMethod: 'Credit',
      },
    };

    it('produces exactly the body core accepts (contract fixture)', () => {
      const { payload } = svc.translate(erpOrder, exampleConfig());
      expect(payload).toEqual(loadJsonFixture('initiate-order-request'));
    });

    it.each([
      [12345.678, 'NAIRA', '12345.68'],
      ['50000', 'NAIRA', '50000.00'],
      [1000000, 'KOBO', '10000.00'],
      [1234505, 'KOBO', '12345.05'],
    ])('amount %p (%s) → %s', (amount, unit, expected) => {
      const cfg = exampleConfig({ amount_unit: unit as 'NAIRA' | 'KOBO' });
      const { payload } = svc.translate(
        {
          ...erpOrder,
          OrderHeader: { ...erpOrder.OrderHeader, Total: amount },
        },
        cfg,
      );
      expect(payload.amount).toBe(expected);
    });

    it('defaults category to OTHER when none is mapped', () => {
      const cfg = exampleConfig({ category: undefined });
      expect(svc.translate(erpOrder, cfg).payload.category).toBe('OTHER');
    });

    it('uses the mapped category when one is configured', () => {
      expect(svc.translate(erpOrder, exampleConfig()).payload.category).toBe(
        'FMCG',
      );
    });
  });

  describe('JSONPath extraction', () => {
    it('extracts nested fields from a Sage-like shape', () => {
      const result = svc.translate(
        {
          OrderHeader: {
            OrderId: 'SO-1001',
            CustomerCode: 'C-42',
            Total: 50000,
            Status: 'Pending',
            Group: 'BEVERAGES',
          },
        },
        baseConfig(),
      );
      expect(result.payload).toMatchObject({
        external_order_id: 'SO-1001',
        external_merchant_id: 'C-42',
        amount: '50000.00',
        category: 'FMCG',
        tenure_days: 14,
      });
      expect(result.action).toBe('initiate_order');
      expect(result.triggerName).toBe('order_pending');
    });

    it('extracts from a Dynamics-like flat shape', () => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.external_order_id = '$.OrderNumber';
      cfg.inbound.field_mappings.external_merchant_id = '$.AccountId';
      cfg.inbound.field_mappings.amount = '$.GrandTotal';
      cfg.inbound.field_mappings.category = '$.SegmentTag';
      cfg.inbound.trigger_events.order_pending.condition =
        "$.OrderStatus == 'Pending'";

      const result = svc.translate(
        {
          OrderNumber: 'D-7',
          AccountId: 'acc-3',
          GrandTotal: 12_500,
          OrderStatus: 'Pending',
          SegmentTag: 'PHARMACY',
        },
        cfg,
      );
      expect(result.payload).toMatchObject({
        external_order_id: 'D-7',
        external_merchant_id: 'acc-3',
        amount: '12500.00',
        category: 'PHARMACY',
      });
    });

    it('extracts from a FieldAssist-like nested shape', () => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.external_order_id = '$.order.orderRefId';
      cfg.inbound.field_mappings.external_merchant_id = '$.order.retailer.code';
      cfg.inbound.field_mappings.amount = '$.order.amount.grossNaira';
      cfg.inbound.field_mappings.category = '$.order.channel';
      cfg.inbound.trigger_events.order_pending.condition =
        "$.order.state == 'AWAITING_CREDIT'";

      const result = svc.translate(
        {
          order: {
            orderRefId: 'FA-2026-001',
            retailer: { code: 'RT-9' },
            amount: { grossNaira: 75_000 },
            state: 'AWAITING_CREDIT',
            channel: 'BEVERAGES',
          },
        },
        cfg,
      );
      expect(result.payload.external_order_id).toBe('FA-2026-001');
      expect(result.payload.amount).toBe('75000.00');
    });
  });

  describe('amount conversion', () => {
    it('NAIRA multiplies by 100', () => {
      const result = svc.translate(
        {
          OrderHeader: {
            OrderId: 'X',
            CustomerCode: 'M',
            Total: 50_000,
            Status: 'Pending',
            Group: 'BEVERAGES',
          },
        },
        baseConfig({ amountUnit: 'NAIRA' }),
      );
      expect(result.payload.amount).toBe('50000.00');
    });

    it('KOBO passes through as integer', () => {
      const result = svc.translate(
        {
          OrderHeader: {
            OrderId: 'X',
            CustomerCode: 'M',
            Total: 5_000_000,
            Status: 'Pending',
            Group: 'BEVERAGES',
          },
        },
        baseConfig({ amountUnit: 'KOBO' }),
      );
      expect(result.payload.amount).toBe('50000.00');
    });

    it('parses string amount', () => {
      const result = svc.translate(
        {
          OrderHeader: {
            OrderId: 'X',
            CustomerCode: 'M',
            Total: '50000.50',
            Status: 'Pending',
            Group: 'BEVERAGES',
          },
        },
        baseConfig({ amountUnit: 'NAIRA' }),
      );
      expect(result.payload.amount).toBe('50000.50');
    });

    it('rejects non-numeric amount', () => {
      expect(() =>
        svc.translate(
          {
            OrderHeader: {
              OrderId: 'X',
              CustomerCode: 'M',
              Total: 'not-a-number',
              Status: 'Pending',
              Group: 'BEVERAGES',
            },
          },
          baseConfig(),
        ),
      ).toThrow(/AMOUNT_NOT_NUMERIC/);
    });

    it('rejects amount below ₦10,000 floor', () => {
      expect(() =>
        svc.translate(
          {
            OrderHeader: {
              OrderId: 'X',
              CustomerCode: 'M',
              Total: 5_000,
              Status: 'Pending',
              Group: 'BEVERAGES',
            },
          },
          baseConfig({ amountUnit: 'NAIRA' }),
        ),
      ).toThrow(/AMOUNT_OUT_OF_BAND/);
    });

    it('rejects amount above ₦15M ceiling', () => {
      expect(() =>
        svc.translate(
          {
            OrderHeader: {
              OrderId: 'X',
              CustomerCode: 'M',
              Total: 20_000_000,
              Status: 'Pending',
              Group: 'BEVERAGES',
            },
          },
          baseConfig({ amountUnit: 'NAIRA' }),
        ),
      ).toThrow(/AMOUNT_OUT_OF_BAND/);
    });
  });

  describe('category mapping', () => {
    it('rejects an unmapped category', () => {
      const cfg = baseConfig();
      try {
        svc.translate(
          {
            OrderHeader: {
              OrderId: 'X',
              CustomerCode: 'M',
              Total: 50_000,
              Status: 'Pending',
              Group: 'TOBACCO',
            },
          },
          cfg,
        );
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(InboundTranslationError);
        expect((err as InboundTranslationError).code).toBe('CATEGORY_UNMAPPED');
      }
    });
  });

  describe('trigger matching', () => {
    it('returns NO_TRIGGER_MATCH when no condition fires', () => {
      try {
        svc.translate(
          {
            OrderHeader: {
              OrderId: 'X',
              CustomerCode: 'M',
              Total: 50_000,
              Status: 'Shipped', // not pending
              Group: 'BEVERAGES',
            },
          },
          baseConfig(),
        );
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(InboundTranslationError);
        expect((err as InboundTranslationError).code).toBe('NO_TRIGGER_MATCH');
      }
    });
  });

  // ERP payloads (e.g. xml2js explicitArray output) can wrap scalars in
  // single-element arrays. Those unwrap; anything non-scalar is refused
  // rather than posted to core as JSON text.
  describe('scalar normalisation (FIELD_NOT_SCALAR)', () => {
    function order(overrides: Record<string, unknown>): unknown {
      return {
        OrderHeader: {
          OrderId: 'SO-1001',
          CustomerCode: 'C-42',
          Total: 50_000,
          Status: 'Pending',
          Group: 'BEVERAGES',
          ...overrides,
        },
      };
    }

    function codeOf(fn: () => unknown): string | undefined {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(InboundTranslationError);
        return (err as InboundTranslationError).code;
      }
      return undefined;
    }

    it('unwraps a single-element array external_order_id', () => {
      const result = svc.translate(
        order({ OrderId: ['SO-1001'] }),
        baseConfig(),
      );
      expect(result.payload.external_order_id).toBe('SO-1001');
    });

    it('rejects an object external_merchant_id', () => {
      expect(
        codeOf(() =>
          svc.translate(order({ CustomerCode: { code: 'X' } }), baseConfig()),
        ),
      ).toBe('FIELD_NOT_SCALAR');
    });

    it('names the field and JSONPath in the FIELD_NOT_SCALAR message', () => {
      expect(() =>
        svc.translate(order({ CustomerCode: { code: 'X' } }), baseConfig()),
      ).toThrow(/external_merchant_id.*\$\.OrderHeader\.CustomerCode/);
    });

    it('rejects a multi-element array external_order_id', () => {
      expect(
        codeOf(() =>
          svc.translate(order({ OrderId: ['A', 'B'] }), baseConfig()),
        ),
      ).toBe('FIELD_NOT_SCALAR');
    });

    it('rejects an empty array external_order_id', () => {
      expect(
        codeOf(() => svc.translate(order({ OrderId: [] }), baseConfig())),
      ).toBe('FIELD_NOT_SCALAR');
    });

    it('rejects a nested array external_order_id', () => {
      expect(
        codeOf(() =>
          svc.translate(order({ OrderId: [['SO-1001']] }), baseConfig()),
        ),
      ).toBe('FIELD_NOT_SCALAR');
    });

    it('unwraps a single-element array amount (NAIRA)', () => {
      const result = svc.translate(
        order({ Total: [250_000] }),
        baseConfig({ amountUnit: 'NAIRA' }),
      );
      expect(result.payload.amount).toBe('250000.00');
    });

    it('rejects an object amount', () => {
      expect(
        codeOf(() =>
          svc.translate(order({ Total: { value: 50_000 } }), baseConfig()),
        ),
      ).toBe('FIELD_NOT_SCALAR');
    });

    it('unwraps a single-element array category', () => {
      const result = svc.translate(
        order({ Group: ['BEVERAGES'] }),
        baseConfig(),
      );
      expect(result.payload.category).toBe('FMCG');
    });

    it('rejects an object category', () => {
      expect(
        codeOf(() =>
          svc.translate(order({ Group: { name: 'BEVERAGES' } }), baseConfig()),
        ),
      ).toBe('FIELD_NOT_SCALAR');
    });

    it('unwraps a single-element array tenure_days', () => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.tenure_days = '$.OrderHeader.Tenure';
      const result = svc.translate(order({ Tenure: ['30'] }), cfg);
      expect(result.payload.tenure_days).toBe(30);
    });

    it('rejects an object tenure_days', () => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.tenure_days = '$.OrderHeader.Tenure';
      expect(
        codeOf(() => svc.translate(order({ Tenure: { days: 30 } }), cfg)),
      ).toBe('FIELD_NOT_SCALAR');
    });
  });

  describe('required-field guards', () => {
    it('rejects missing external_order_id', () => {
      expect(() =>
        svc.translate(
          {
            OrderHeader: {
              CustomerCode: 'M',
              Total: 50_000,
              Status: 'Pending',
              Group: 'BEVERAGES',
            },
          },
          baseConfig(),
        ),
      ).toThrow(/MISSING_REQUIRED_FIELD/);
    });

    it('rejects missing amount field', () => {
      expect(() =>
        svc.translate(
          {
            OrderHeader: {
              OrderId: 'X',
              CustomerCode: 'M',
              Status: 'Pending',
              Group: 'BEVERAGES',
            },
          },
          baseConfig(),
        ),
      ).toThrow(/MISSING_REQUIRED_FIELD/);
    });
  });

  // D-11: tenure_days plumbed from the inbound mapping. Defaults to
  // 14 (T0/T1 baseline) when no mapping is configured; can be
  // overridden via a JSONPath or a static string in
  // field_mappings.tenure_days.
  describe('tenure_days (D-11)', () => {
    function payload(): unknown {
      return {
        OrderHeader: {
          OrderId: 'SO-1001',
          CustomerCode: 'C-42',
          Total: 50000,
          Status: 'Pending',
          Group: 'BEVERAGES',
          Tenure: 30,
        },
      };
    }

    it('defaults to 14 when no mapping is configured', () => {
      const result = svc.translate(payload(), baseConfig());
      expect(result.payload).toMatchObject({ tenure_days: 14 });
    });

    it('extracts tenure_days via JSONPath when mapped', () => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.tenure_days = '$.OrderHeader.Tenure';
      const result = svc.translate(payload(), cfg);
      expect(result.payload).toMatchObject({ tenure_days: 30 });
    });

    it('accepts a static "30" override', () => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.tenure_days = '30';
      const result = svc.translate(payload(), cfg);
      expect(result.payload).toMatchObject({ tenure_days: 30 });
    });

    it('falls back to 14 when the JSONPath misses (defensive)', () => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.tenure_days = '$.OrderHeader.NotPresent';
      const result = svc.translate(payload(), cfg);
      expect(result.payload).toMatchObject({ tenure_days: 14 });
    });

    it('rejects tenure_days outside the spec set {14, 30}', () => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.tenure_days = '45';
      expect(() => svc.translate(payload(), cfg)).toThrow(
        /TENURE_DAYS_INVALID/,
      );
    });

    it('rejects non-numeric tenure_days', () => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.tenure_days = 'thirty';
      expect(() => svc.translate(payload(), cfg)).toThrow(
        /TENURE_DAYS_INVALID/,
      );
    });
  });
});

describe('koboToNairaString', () => {
  it('formats non-negative integer kobo as a 2-dp decimal-Naira string', () => {
    expect(koboToNairaString(25_000_000)).toBe('250000.00');
    expect(koboToNairaString(1_000_005)).toBe('10000.05');
    expect(koboToNairaString(0)).toBe('0.00');
  });

  it('throws on negative kobo instead of emitting a malformed string', () => {
    expect(() => koboToNairaString(-5)).toThrow(RangeError);
  });

  it('throws on non-integer kobo', () => {
    expect(() => koboToNairaString(100.5)).toThrow(RangeError);
  });
});
