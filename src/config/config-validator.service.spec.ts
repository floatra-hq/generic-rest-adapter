import {
  ConfigValidationError,
  ConfigValidatorService,
} from './config-validator.service';
import { FloatraAdapterConfig, OutboundConfig } from './config.types';

function baseConfig(): FloatraAdapterConfig {
  return {
    erp_type: 'SAGE_300',
    platform_id: 'plat_test',
    api_key: 'k',
    webhook_secret: 's',
    floatra_gateway_url: 'https://api.floatra.com/v1/partner',
    unavailability_fallback: 'BLOCK_CREDIT_ORDERS',
    inbound: {
      auth: { type: 'none' },
      field_mappings: {
        external_order_id: '$.OrderId',
        external_merchant_id: '$.CustomerCode',
        amount: '$.Total',
        amount_unit: 'NAIRA',
      },
      category_mappings: { GENERAL: 'OTHER' },
      trigger_events: {
        order_pending: {
          condition: "$.Status == 'Pending'",
          floatra_action: 'initiate_order',
        },
      },
      response_mode: 'sync',
    },
    outbound: {
      erp_webhook_url: 'https://erp.example.com/floatra',
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

describe('ConfigValidatorService', () => {
  let svc: ConfigValidatorService;

  beforeEach(() => {
    svc = new ConfigValidatorService();
  });

  it('passes a fully-valid config', () => {
    const issues = svc.validate(baseConfig());
    expect(issues).toEqual([]);
  });

  it('rejects category_mappings values that are not core OrderCategory members', () => {
    const cfg = baseConfig();
    cfg.inbound.category_mappings = {
      PHARMACY: 'PHARMA',
      GENERAL: 'GENERAL_TRADE',
    };
    const issues = svc.validate(cfg);
    expect(issues).toContain(
      'inbound.category_mappings["PHARMACY"] = "PHARMA" is not a Floatra category (FMCG, ELECTRONICS, FASHION, AGRICULTURE, PHARMACY, OTHER)',
    );
    expect(issues).toContain(
      'inbound.category_mappings["GENERAL"] = "GENERAL_TRADE" is not a Floatra category (FMCG, ELECTRONICS, FASHION, AGRICULTURE, PHARMACY, OTHER)',
    );
  });

  it('reports a missing category_mappings once, without per-entry issues', () => {
    const cfg = baseConfig();
    delete (cfg.inbound as Partial<typeof cfg.inbound>).category_mappings;
    expect(svc.validate(cfg)).toEqual([
      'inbound.category_mappings is required (object of ERP-category → Floatra-enum)',
    ]);
  });

  it('accepts every core OrderCategory member as a category_mappings value', () => {
    const cfg = baseConfig();
    cfg.inbound.category_mappings = {
      A: 'FMCG',
      B: 'ELECTRONICS',
      C: 'FASHION',
      D: 'AGRICULTURE',
      E: 'PHARMACY',
      F: 'OTHER',
    };
    expect(svc.validate(cfg)).toEqual([]);
  });

  describe('the /v1/partner base URL guard', () => {
    const PARTNER_URL_ISSUE =
      'floatra_gateway_url must end with /v1/partner (e.g. https://api.floatra.com/v1/partner)';

    it.each([
      'https://api.floatra.io/v1',
      'https://api.floatra.com/v1',
      'https://api.floatra.com',
    ])('rejects a gateway URL not ending in /v1/partner: %s', (url) => {
      const issues = svc.validate({
        ...baseConfig(),
        floatra_gateway_url: url,
      });
      expect(issues).toContain(PARTNER_URL_ISSUE);
    });

    it('accepts the partner base URL with or without a trailing slash', () => {
      for (const url of [
        'https://api.floatra.com/v1/partner',
        'https://api.floatra.com/v1/partner/',
      ]) {
        expect(
          svc.validate({ ...baseConfig(), floatra_gateway_url: url }),
        ).not.toContain(PARTNER_URL_ISSUE);
      }
    });
  });

  describe('the reorder-lock structural guard', () => {
    it('rejects on_reorder_locked.block_merchant_orders=false', () => {
      const cfg = baseConfig();
      (
        cfg.outbound.on_reorder_locked as { block_merchant_orders: boolean }
      ).block_merchant_orders = false;
      const issues = svc.validate(cfg);
      expect(
        issues.some((i) => i.includes('block_merchant_orders MUST be true')),
      ).toBe(true);
    });

    it('rejects missing on_reorder_locked entirely', () => {
      const cfg = baseConfig();
      delete (cfg.outbound as Partial<OutboundConfig>).on_reorder_locked;
      const issues = svc.validate(cfg);
      expect(
        issues.some((i) => i.includes('on_reorder_locked is required')),
      ).toBe(true);
    });

    it('assertValid throws ConfigValidationError when reorder-lock is wrong', () => {
      const cfg = baseConfig();
      (
        cfg.outbound.on_reorder_locked as { block_merchant_orders: boolean }
      ).block_merchant_orders = false;
      expect(() => svc.assertValid(cfg)).toThrow(ConfigValidationError);
    });
  });

  describe('JSONPath fields', () => {
    it('rejects non-$ JSONPath in field_mappings', () => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.external_order_id = 'OrderId';
      const issues = svc.validate(cfg);
      expect(
        issues.some((i) => i.includes('external_order_id must start with $')),
      ).toBe(true);
    });

    it('rejects empty required JSONPath', () => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.external_merchant_id = '';
      const issues = svc.validate(cfg);
      expect(
        issues.some((i) => i.includes('external_merchant_id is required')),
      ).toBe(true);
    });
  });

  describe('trigger conditions', () => {
    it('rejects a condition with parentheses (unsupported grammar)', () => {
      const cfg = baseConfig();
      cfg.inbound.trigger_events.order_pending.condition =
        "($.Status == 'Pending')";
      const issues = svc.validate(cfg);
      expect(issues.some((i) => i.includes('condition'))).toBe(true);
    });

    it('rejects an unknown floatra_action', () => {
      const cfg = baseConfig();
      (
        cfg.inbound.trigger_events.order_pending as { floatra_action: string }
      ).floatra_action = 'launch_missiles';
      const issues = svc.validate(cfg);
      expect(issues.some((i) => i.includes('floatra_action invalid'))).toBe(
        true,
      );
    });

    it('rejects empty trigger_events', () => {
      const cfg = baseConfig();
      cfg.inbound.trigger_events = {};
      const issues = svc.validate(cfg);
      expect(
        issues.some((i) =>
          i.includes('trigger_events must define at least one event'),
        ),
      ).toBe(true);
    });
  });

  describe('response_mode + callback_url', () => {
    it('requires callback_url when response_mode = callback', () => {
      const cfg = baseConfig();
      cfg.inbound.response_mode = 'callback';
      cfg.inbound.callback_url = undefined;
      const issues = svc.validate(cfg);
      expect(issues.some((i) => i.includes('callback_url is required'))).toBe(
        true,
      );
    });
  });

  describe('unavailability_fallback', () => {
    it('rejects invalid value', () => {
      const cfg = baseConfig();
      (cfg as { unavailability_fallback: string }).unavailability_fallback =
        'IGNORE_AND_PASS';
      const issues = svc.validate(cfg);
      expect(issues.some((i) => i.includes('unavailability_fallback'))).toBe(
        true,
      );
    });
  });

  describe('inbound auth', () => {
    it('requires header_name + api_key for api_key auth', () => {
      const cfg = baseConfig();
      cfg.inbound.auth = { type: 'api_key' } as never;
      const issues = svc.validate(cfg);
      expect(issues.some((i) => i.includes('header_name'))).toBe(true);
      expect(issues.some((i) => i.includes('api_key'))).toBe(true);
    });

    // G-2: `type: none` leaves the order-initiating inbound endpoint open.
    describe("type 'none' production guard", () => {
      const original = process.env.NODE_ENV;
      afterEach(() => {
        process.env.NODE_ENV = original;
      });

      it('is allowed outside production (baseConfig uses none)', () => {
        process.env.NODE_ENV = 'development';
        const issues = svc.validate(baseConfig());
        expect(
          issues.filter((i) => i.includes("auth.type 'none'")),
        ).toHaveLength(0);
      });

      it('is rejected in production', () => {
        process.env.NODE_ENV = 'production';
        const issues = svc.validate(baseConfig());
        expect(
          issues.some((i) =>
            i.includes("inbound.auth.type 'none' is not allowed in production"),
          ),
        ).toBe(true);
      });
    });
  });

  describe('outbound auth', () => {
    it('requires header_name + api_key for api_key auth', () => {
      const cfg = baseConfig();
      cfg.outbound.erp_auth = { type: 'api_key' } as never;
      const issues = svc.validate(cfg);
      expect(
        issues.some((i) => i.includes('outbound.erp_auth.header_name')),
      ).toBe(true);
    });
  });

  // P2-17: outbound rate-limit field is optional. When supplied it
  // must be an integer in [1, 1000]. Omitted = no limiter applied.
  describe('outbound rate_limit_per_minute (P2-17)', () => {
    it('accepts an omitted field (legacy v3.0 configs still pass)', () => {
      const cfg = baseConfig();
      delete cfg.outbound.rate_limit_per_minute;
      const issues = svc.validate(cfg);
      expect(issues.some((i) => i.includes('rate_limit_per_minute'))).toBe(
        false,
      );
    });

    it('accepts an integer in [1, 1000]', () => {
      const cfg = baseConfig();
      cfg.outbound.rate_limit_per_minute = 60;
      const issues = svc.validate(cfg);
      expect(issues.some((i) => i.includes('rate_limit_per_minute'))).toBe(
        false,
      );
    });

    it.each([0, -1, 1001, 3.5])('rejects out-of-band value %s', (bad) => {
      const cfg = baseConfig();
      cfg.outbound.rate_limit_per_minute = bad;
      const issues = svc.validate(cfg);
      expect(issues.some((i) => i.includes('rate_limit_per_minute'))).toBe(
        true,
      );
    });

    it('rejects non-numeric value', () => {
      const cfg = baseConfig();
      cfg.outbound.rate_limit_per_minute = '60' as never;
      const issues = svc.validate(cfg);
      expect(issues.some((i) => i.includes('rate_limit_per_minute'))).toBe(
        true,
      );
    });
  });

  // P1-19: JSONPath script-block detector. A path with `(` or `?(`
  // must fail validation rather than silently produce undefined at
  // runtime via the translator's eval:false guard.
  describe('JSONPath script-block rejection (P1-19)', () => {
    const svc = new ConfigValidatorService();

    it.each([
      ['$.x[?(@.id > 1)]'],
      ['$.x[(some.script)]'],
      ['$.x[?( @.id == 1 )]'],
      ['$.x.{a}'],
      ['$.x[<a>]'],
      ['$.x[!a]'],
      ['$.x[a|b]'],
      ['$.x[a&b]'],
    ])('flags %s as disallowed', (path) => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.external_order_id = path;
      const issues = svc.validate(cfg);
      expect(issues.some((i) => i.includes('disallowed JSONPath syntax'))).toBe(
        true,
      );
    });

    it('accepts a clean dot/bracket path', () => {
      const cfg = baseConfig();
      cfg.inbound.field_mappings.external_order_id = '$.OrderHeader.OrderId';
      cfg.inbound.field_mappings.external_merchant_id =
        '$.OrderHeader.CustomerCode';
      cfg.inbound.field_mappings.amount = '$.OrderHeader.Total';
      const issues = svc.validate(cfg);
      expect(issues.some((i) => i.includes('disallowed JSONPath syntax'))).toBe(
        false,
      );
    });
  });
});
