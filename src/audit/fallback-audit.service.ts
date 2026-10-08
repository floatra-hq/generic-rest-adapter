import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FallbackAuditEntry {
  platformId: string;
  externalOrderId: string;
  fallbackDecision:
    | 'BLOCKED'
    | 'ALLOWED_ON_DISTRIBUTOR_CREDIT'
    | 'BLOCKED_NO_OVERRIDE';
  floatraStatus: number | null;
  envOverrideEnabled: boolean;
  timestamp: string;
}

/**
 * P1-20: every time the Floatra gateway is unreachable, the inbound
 * controller picks a fallback per `unavailability_fallback`. Those
 * decisions affect real money + lender exposure, so we keep a
 * tamper-evident JSONL log on disk that ops can ship to centralised
 * storage (`tail -F` to syslog, or just `rsync`).
 *
 * Why JSONL on disk rather than a DB:
 *   - The Generic adapter is stateless by design (no Prisma)
 *   - JSONL appends are atomic on POSIX up to PIPE_BUF (4096 bytes)
 *   - Distributors with diverse deployment shapes (Docker, k8s,
 *     bare-metal) can tail the file with whatever they already use
 *
 * Path: `${CONFIG_DIR}/../fallback-audit.jsonl` unless
 * `FALLBACK_AUDIT_LOG_PATH` overrides. The directory must be
 * writable by the adapter user.
 */
@Injectable()
export class FallbackAuditService {
  private readonly logger = new Logger(FallbackAuditService.name);
  private readonly logPath: string;

  constructor(env: ConfigService) {
    const explicit = env.get<string>('FALLBACK_AUDIT_LOG_PATH');
    if (explicit) {
      this.logPath = explicit;
    } else {
      const configDir = path.resolve(
        env.get<string>('CONFIG_DIR', './configs'),
      );
      this.logPath = path.join(path.dirname(configDir), 'fallback-audit.jsonl');
    }
  }

  record(entry: FallbackAuditEntry): void {
    const line = JSON.stringify(entry) + '\n';
    // Append-and-fsync would be ideal but blocks the request thread.
    // appendFileSync is best-effort durability; OS page cache flush
    // is typically <100ms in practice. ops needing strict durability
    // can mount the log dir on a tmpfs and ship lines via fluent-bit
    // / vector / similar.
    try {
      fs.appendFileSync(this.logPath, line, { encoding: 'utf-8' });
    } catch (err) {
      this.logger.error(
        `FallbackAudit append failed (path=${this.logPath}): ${
          err instanceof Error ? err.message : String(err)
        }. Decision still applied; ops should investigate disk write access.`,
      );
    }
  }

  /** Internal: surface the resolved log path for diagnostics. */
  getLogPath(): string {
    return this.logPath;
  }
}
