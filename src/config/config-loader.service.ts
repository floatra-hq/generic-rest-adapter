import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FloatraAdapterConfig } from './config.types';
import { ConfigValidatorService } from './config-validator.service';
import { loadConfigDirectory } from './config-directory';
import {
  FloatraApiClient,
  FloatraApiError,
} from '../floatra/floatra-api.client';

const BOOT_HEALTH_TIMEOUT_MS = 10_000;

/**
 * Loads every per-platform JSON config under CONFIG_DIR at startup,
 * validates each, and exposes them via getByPlatform(platformId).
 *
 * Multi-tenant adapters serve many platforms from one process; the
 * inbound controller routes on the URL path (`/adapter/:platformId/inbound`).
 *
 * Behaviour on startup:
 *   - Each file must validate; the first invalid config aborts boot
 *     with a clear error.
 *   - If ENABLED_PLATFORM_IDS is set in env, only those configs load.
 *
 * In-memory only — config edits require a restart. That's deliberate;
 * hot-reload introduces a window where invalid config can run.
 */
@Injectable()
export class ConfigLoaderService implements OnModuleInit {
  private readonly logger = new Logger(ConfigLoaderService.name);
  private configs = new Map<string, FloatraAdapterConfig>();

  constructor(
    private readonly env: ConfigService,
    private readonly validator: ConfigValidatorService,
    private readonly floatra: FloatraApiClient,
  ) {}

  async onModuleInit(): Promise<void> {
    this.configs = loadConfigDirectory(this.env, this.validator, this.logger);
    this.logger.log(
      `Adapter ready — ${this.configs.size} platform config(s) loaded`,
    );
    await this.checkGatewayReachability();
  }

  getByPlatform(platformId: string): FloatraAdapterConfig | undefined {
    return this.configs.get(platformId);
  }

  listPlatformIds(): string[] {
    return Array.from(this.configs.keys());
  }

  /**
   * Boot-time reachability gate against `<floatra_gateway_url>/platform/health`.
   *
   *   STRICT_GATEWAY_HEALTHCHECK=true   → fail startup on the first
   *                                       unreachable platform
   *   anything else (default)           → log a warning per failure
   *                                       and keep booting
   *
   * The check runs PER PLATFORM. Multi-tenant deployments that point
   * different platforms at different gateway URLs (sandbox vs prod)
   * surface a clear failure per config rather than a single rolled-up
   * one.
   *
   * 10s timeout per ping. If 5 platforms are configured the worst-case
   * boot wait is 50s — acceptable for a startup check (the alternative
   * is silently accepting an unreachable gateway and finding out at
   * first ERP request).
   */
  private async checkGatewayReachability(): Promise<void> {
    if (this.configs.size === 0) return;
    const strict =
      this.env.get<string>('STRICT_GATEWAY_HEALTHCHECK') === 'true';
    const failures: string[] = [];
    for (const [platformId, config] of this.configs.entries()) {
      try {
        const resp = await this.floatra.pingHealth(
          config,
          BOOT_HEALTH_TIMEOUT_MS,
        );
        if (resp.status >= 200 && resp.status < 300) {
          this.logger.log(
            `Gateway reachable for platform "${platformId}" (${resp.status})`,
          );
          continue;
        }
        failures.push(`${platformId}: gateway returned ${resp.status}`);
        this.logger.warn(
          `Gateway health check for "${platformId}" returned ${resp.status}`,
        );
      } catch (err) {
        const message =
          err instanceof FloatraApiError
            ? `${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        failures.push(`${platformId}: ${message}`);
        this.logger.warn(
          `Gateway health check failed for "${platformId}": ${message}`,
        );
      }
    }

    if (failures.length === 0) return;
    if (strict) {
      throw new Error(
        `STRICT_GATEWAY_HEALTHCHECK is on and ${failures.length} platform(s) failed reachability:\n  - ${failures.join('\n  - ')}`,
      );
    }
    this.logger.warn(
      `${failures.length} platform(s) failed reachability — continuing because STRICT_GATEWAY_HEALTHCHECK is not enabled`,
    );
  }
}
