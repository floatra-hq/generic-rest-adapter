import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FallbackAuditService } from './fallback-audit.service';

function makeConfigService(opts: {
  configDir?: string;
  explicitPath?: string;
}): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: string) => {
      if (key === 'FALLBACK_AUDIT_LOG_PATH') return opts.explicitPath;
      if (key === 'CONFIG_DIR') return opts.configDir ?? fallback;
      return fallback;
    }),
  } as unknown as ConfigService;
}

describe('FallbackAuditService (P1-20)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-audit-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends a JSONL line per record() call', () => {
    const logPath = path.join(tmpDir, 'audit.jsonl');
    const svc = new FallbackAuditService(
      makeConfigService({ explicitPath: logPath }),
    );

    svc.record({
      platformId: 'plat-1',
      externalOrderId: 'ORD-001',
      fallbackDecision: 'ALLOWED_ON_DISTRIBUTOR_CREDIT',
      floatraStatus: 503,
      envOverrideEnabled: true,
      timestamp: '2026-06-01T13:00:00Z',
    });
    svc.record({
      platformId: 'plat-1',
      externalOrderId: 'ORD-002',
      fallbackDecision: 'BLOCKED',
      floatraStatus: 503,
      envOverrideEnabled: false,
      timestamp: '2026-06-01T13:01:00Z',
    });

    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({
      externalOrderId: 'ORD-001',
      fallbackDecision: 'ALLOWED_ON_DISTRIBUTOR_CREDIT',
    });
    expect(JSON.parse(lines[1])).toMatchObject({
      externalOrderId: 'ORD-002',
      fallbackDecision: 'BLOCKED',
    });
  });

  it('falls back to a path relative to CONFIG_DIR', () => {
    const configDir = path.join(tmpDir, 'configs');
    fs.mkdirSync(configDir);
    const svc = new FallbackAuditService(makeConfigService({ configDir }));
    expect(svc.getLogPath()).toBe(path.join(tmpDir, 'fallback-audit.jsonl'));
  });

  it('logs at error level (no throw) when the path is unwritable', () => {
    const svc = new FallbackAuditService(
      makeConfigService({
        explicitPath: '/this/path/does/not/exist/audit.jsonl',
      }),
    );
    // Must not throw.
    expect(() =>
      svc.record({
        platformId: 'plat-1',
        externalOrderId: 'ORD-003',
        fallbackDecision: 'BLOCKED',
        floatraStatus: 503,
        envOverrideEnabled: false,
        timestamp: '2026-06-01T13:00:00Z',
      }),
    ).not.toThrow();
  });
});
