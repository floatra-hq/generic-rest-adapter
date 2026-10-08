import { HealthController } from './health.controller';
import type { ConfigLoaderService } from '../config/config-loader.service';
import type { ConfigValidatorService } from '../config/config-validator.service';
import type { FloatraApiClient } from '../floatra/floatra-api.client';
import type { FloatraAdapterConfig } from '../config/config.types';

/**
 * P2-24 slice H: coverage for the adapter health controller.
 *
 * Three endpoints, three sets of contracts:
 *
 *   GET /adapter/health
 *     - `status: 'ready'` ONLY when at least one config is loaded.
 *     - Empty config list → `status: 'no-configs-loaded'`. A
 *       regression that returned `ready` regardless would hide
 *       the "the adapter started but no /configs mount worked"
 *       failure mode.
 *
 *   GET /adapter/:platformId/health
 *     - Unknown platformId → `configLoaded: false`, no Floatra
 *       call (saves a doomed round-trip).
 *     - Known platformId → makes the round-trip; 2xx → reachable,
 *       non-2xx → unreachable with status forwarded.
 *     - Floatra throws → swallowed, returns `floatraReachable:
 *       false` WITHOUT a status (NEVER re-throws — a 5xx here
 *       would mark the pod itself unhealthy and Railway would
 *       loop the restart).
 *
 *   GET /adapter/:platformId/config/validate
 *     - Unknown platformId → `valid: false` with a single-issue
 *       explanation. NEVER throws — this is a setup-time
 *       diagnostic, throwing would mask the missing-config root
 *       cause.
 *     - Known platformId → forwards the validator's issue list
 *       verbatim. Empty list → `valid: true`.
 */

const PLATFORM_ID = 'plt_test';

function fakeConfig(): FloatraAdapterConfig {
  return {
    erp_type: 'generic',
    platform_id: PLATFORM_ID,
    api_key: 'k',
    webhook_secret: 's',
    floatra_gateway_url: 'https://gateway.test',
    inbound: {} as never,
    outbound: {} as never,
    unavailability_fallback: 'BLOCK_CREDIT_ORDERS',
  };
}

describe('HealthController (generic-rest-adapter)', () => {
  function build() {
    const loader = {
      listPlatformIds: jest.fn(),
      getByPlatform: jest.fn(),
    };
    const validator = { validate: jest.fn() };
    const floatra = { getHealth: jest.fn() };
    const controller = new HealthController(
      loader as unknown as ConfigLoaderService,
      validator as unknown as ConfigValidatorService,
      floatra as unknown as FloatraApiClient,
    );
    return { controller, loader, validator, floatra };
  }

  describe('GET /adapter/health (global)', () => {
    it("returns status 'ready' with the platform list when at least one config is loaded", () => {
      const { controller, loader } = build();
      loader.listPlatformIds.mockReturnValue(['plt_a', 'plt_b']);
      expect(controller.global()).toEqual({
        status: 'ready',
        platformIds: ['plt_a', 'plt_b'],
      });
    });

    it("returns status 'no-configs-loaded' when zero configs are loaded", () => {
      const { controller, loader } = build();
      loader.listPlatformIds.mockReturnValue([]);
      expect(controller.global()).toEqual({
        status: 'no-configs-loaded',
        platformIds: [],
      });
    });
  });

  describe('GET /adapter/:platformId/health (per-platform)', () => {
    it('reports configLoaded=false WITHOUT calling Floatra when the platform is unknown', async () => {
      const { controller, loader, floatra } = build();
      loader.getByPlatform.mockReturnValue(null);
      const result = await controller.perPlatform('unknown');
      expect(result).toEqual({
        platformId: 'unknown',
        configLoaded: false,
        floatraReachable: false,
      });
      expect(floatra.getHealth).not.toHaveBeenCalled();
    });

    it('reports floatraReachable=true on a 2xx Floatra response', async () => {
      const { controller, loader, floatra } = build();
      loader.getByPlatform.mockReturnValue(fakeConfig());
      floatra.getHealth.mockResolvedValue({ status: 200 });
      expect(await controller.perPlatform(PLATFORM_ID)).toEqual({
        platformId: PLATFORM_ID,
        configLoaded: true,
        floatraReachable: true,
        floatraStatus: 200,
      });
    });

    it('reports floatraReachable=false BUT forwards the status on a non-2xx Floatra response', async () => {
      const { controller, loader, floatra } = build();
      loader.getByPlatform.mockReturnValue(fakeConfig());
      floatra.getHealth.mockResolvedValue({ status: 503 });
      expect(await controller.perPlatform(PLATFORM_ID)).toEqual({
        platformId: PLATFORM_ID,
        configLoaded: true,
        floatraReachable: false,
        floatraStatus: 503,
      });
    });

    it('SWALLOWS Floatra errors and returns floatraReachable=false (NEVER re-throws — Railway probe protection)', async () => {
      const { controller, loader, floatra } = build();
      loader.getByPlatform.mockReturnValue(fakeConfig());
      floatra.getHealth.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await controller.perPlatform(PLATFORM_ID);
      expect(result).toEqual({
        platformId: PLATFORM_ID,
        configLoaded: true,
        floatraReachable: false,
      });
      // No status field when we don't have one — a regression that
      // defaulted to e.g. 0 would muddle the dashboard signal.
      expect('floatraStatus' in result).toBe(false);
    });
  });

  describe('GET /adapter/:platformId/config/validate', () => {
    it('returns valid=false with a single-issue explanation when the platform is unknown', () => {
      const { controller, loader, validator } = build();
      loader.getByPlatform.mockReturnValue(null);
      expect(controller.validate('unknown')).toEqual({
        platformId: 'unknown',
        valid: false,
        issues: ['No config loaded for platform_id unknown'],
      });
      expect(validator.validate).not.toHaveBeenCalled();
    });

    it('returns valid=true with an empty issue list when the validator reports clean', () => {
      const { controller, loader, validator } = build();
      loader.getByPlatform.mockReturnValue(fakeConfig());
      validator.validate.mockReturnValue([]);
      expect(controller.validate(PLATFORM_ID)).toEqual({
        platformId: PLATFORM_ID,
        valid: true,
        issues: [],
      });
    });

    it('returns valid=false and forwards the validator issue list verbatim', () => {
      const { controller, loader, validator } = build();
      loader.getByPlatform.mockReturnValue(fakeConfig());
      const issues = [
        'outbound.on_reorder_locked.block_merchant_orders must be true',
        'outbound.erp_webhook_url is required',
      ];
      validator.validate.mockReturnValue(issues);
      expect(controller.validate(PLATFORM_ID)).toEqual({
        platformId: PLATFORM_ID,
        valid: false,
        issues,
      });
    });
  });
});
