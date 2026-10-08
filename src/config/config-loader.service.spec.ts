import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigLoaderService } from './config-loader.service';
import { ConfigValidatorService } from './config-validator.service';
import { FloatraAdapterConfig } from './config.types';
import { FloatraApiError } from '../floatra/floatra-api.client';

/**
 * Boot-time reachability gate tests for ConfigLoaderService.
 *
 * The loader's primary job (load + validate JSON configs from disk)
 * is covered by integration tests of the controllers. This spec
 * focuses on the new `checkGatewayReachability` behaviour added by
 * #42 — env-flag-gated boot fail when the gateway is unreachable.
 */

function baseConfig(
  overrides: Partial<FloatraAdapterConfig> = {},
): FloatraAdapterConfig {
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
    ...overrides,
  };
}

function makeConfigDir(configs: FloatraAdapterConfig[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floatra-adapter-'));
  for (const c of configs) {
    const full = path.join(dir, `${c.platform_id}.json`);
    fs.writeFileSync(full, JSON.stringify(c));
    // P1-21: loader rejects group/world-readable files. Match the
    // production posture in tests rather than disabling the check.
    if (process.platform !== 'win32') {
      fs.chmodSync(full, 0o600);
    }
  }
  return dir;
}

describe('ConfigLoaderService.checkGatewayReachability', () => {
  let tempDir: string;
  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeLoader(env: Record<string, string>, pingHealth: jest.Mock) {
    const configService = new ConfigService(env);
    const validator = new ConfigValidatorService();
    return new ConfigLoaderService(configService, validator, {
      pingHealth,
    } as never);
  }

  it('passes when every platform pings 2xx', async () => {
    tempDir = makeConfigDir([baseConfig({ platform_id: 'p_a' })]);
    const ping = jest.fn().mockResolvedValueOnce({ status: 200, body: {} });
    const loader = makeLoader({ CONFIG_DIR: tempDir }, ping);
    await expect(loader.onModuleInit()).resolves.toBeUndefined();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('logs a warning but does NOT throw when default mode + ping fails', async () => {
    tempDir = makeConfigDir([baseConfig({ platform_id: 'p_a' })]);
    const ping = jest
      .fn()
      .mockRejectedValueOnce(new FloatraApiError(0, null, 'ECONNREFUSED'));
    const loader = makeLoader({ CONFIG_DIR: tempDir }, ping);
    await expect(loader.onModuleInit()).resolves.toBeUndefined();
  });

  it('throws when STRICT_GATEWAY_HEALTHCHECK=true + ping fails', async () => {
    tempDir = makeConfigDir([baseConfig({ platform_id: 'p_a' })]);
    const ping = jest
      .fn()
      .mockRejectedValueOnce(new FloatraApiError(0, null, 'ECONNREFUSED'));
    const loader = makeLoader(
      { CONFIG_DIR: tempDir, STRICT_GATEWAY_HEALTHCHECK: 'true' },
      ping,
    );
    await expect(loader.onModuleInit()).rejects.toThrow(
      /STRICT_GATEWAY_HEALTHCHECK is on/,
    );
  });

  it('throws when strict + gateway returns non-2xx (not just connection refused)', async () => {
    tempDir = makeConfigDir([baseConfig({ platform_id: 'p_a' })]);
    const ping = jest.fn().mockResolvedValueOnce({ status: 500, body: {} });
    const loader = makeLoader(
      { CONFIG_DIR: tempDir, STRICT_GATEWAY_HEALTHCHECK: 'true' },
      ping,
    );
    await expect(loader.onModuleInit()).rejects.toThrow(
      /platform\(s\) failed reachability/,
    );
  });

  it('checks every platform — multi-tenant deployments', async () => {
    tempDir = makeConfigDir([
      baseConfig({ platform_id: 'p_a' }),
      baseConfig({ platform_id: 'p_b' }),
      baseConfig({ platform_id: 'p_c' }),
    ]);
    const ping = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: {} })
      .mockResolvedValueOnce({ status: 200, body: {} })
      .mockResolvedValueOnce({ status: 200, body: {} });
    const loader = makeLoader({ CONFIG_DIR: tempDir }, ping);
    await loader.onModuleInit();
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it('reports all failing platforms in the strict-mode error', async () => {
    tempDir = makeConfigDir([
      baseConfig({ platform_id: 'p_a' }),
      baseConfig({ platform_id: 'p_b' }),
    ]);
    const ping = jest
      .fn()
      .mockResolvedValueOnce({ status: 503, body: {} })
      .mockRejectedValueOnce(new FloatraApiError(0, null, 'timeout'));
    const loader = makeLoader(
      { CONFIG_DIR: tempDir, STRICT_GATEWAY_HEALTHCHECK: 'true' },
      ping,
    );
    let caught: Error | null = null;
    try {
      await loader.onModuleInit();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toMatch(/p_a/);
    expect(caught!.message).toMatch(/p_b/);
  });

  it('rejects a config file that is not valid JSON, keeping the parse error as cause', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floatra-adapter-'));
    const full = path.join(tempDir, 'broken.json');
    fs.writeFileSync(full, '{ not json');
    if (process.platform !== 'win32') {
      fs.chmodSync(full, 0o600);
    }
    const loader = makeLoader({ CONFIG_DIR: tempDir }, jest.fn());

    const err: unknown = await loader.onModuleInit().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/broken\.json is not valid JSON/);
    expect((err as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it('skips reachability when no configs were loaded', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floatra-adapter-'));
    const ping = jest.fn();
    const loader = makeLoader(
      { CONFIG_DIR: tempDir, STRICT_GATEWAY_HEALTHCHECK: 'true' },
      ping,
    );
    // Empty config dir → loader logs a warning + returns; reachability
    // check should NOT fire (no platforms to test).
    await expect(loader.onModuleInit()).resolves.toBeUndefined();
    expect(ping).not.toHaveBeenCalled();
  });
});
