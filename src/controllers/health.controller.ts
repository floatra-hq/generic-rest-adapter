import { Controller, Get, Logger, Param } from '@nestjs/common';
import { ConfigLoaderService } from '../config/config-loader.service';
import { ConfigValidatorService } from '../config/config-validator.service';
import { FloatraApiClient } from '../floatra/floatra-api.client';

/**
 * Health + diagnostic endpoints.
 *
 *   GET /adapter/health
 *     Process-level liveness — does the adapter have at least one
 *     valid config loaded? Returns 200 with summary.
 *
 *   GET /adapter/:platformId/health
 *     Per-platform health: config status + Floatra gateway round-trip.
 *
 *   GET /adapter/:platformId/config/validate
 *     Re-runs the validator (useful during setup). Returns the
 *     full issue list, never throws.
 */
@Controller('adapter')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly loader: ConfigLoaderService,
    private readonly validator: ConfigValidatorService,
    private readonly floatra: FloatraApiClient,
  ) {}

  @Get('health')
  global(): { status: string; platformIds: string[] } {
    const platformIds = this.loader.listPlatformIds();
    return {
      status: platformIds.length > 0 ? 'ready' : 'no-configs-loaded',
      platformIds,
    };
  }

  @Get(':platformId/health')
  async perPlatform(@Param('platformId') platformId: string): Promise<{
    platformId: string;
    configLoaded: boolean;
    floatraReachable: boolean;
    floatraStatus?: number;
  }> {
    const config = this.loader.getByPlatform(platformId);
    if (!config) {
      return {
        platformId,
        configLoaded: false,
        floatraReachable: false,
      };
    }
    try {
      const resp = await this.floatra.getHealth(config);
      return {
        platformId,
        configLoaded: true,
        floatraReachable: resp.status >= 200 && resp.status < 300,
        floatraStatus: resp.status,
      };
    } catch (err) {
      this.logger.warn(
        `Health check for platform ${platformId} failed: ${err instanceof Error ? err.message : err}`,
      );
      return {
        platformId,
        configLoaded: true,
        floatraReachable: false,
      };
    }
  }

  @Get(':platformId/config/validate')
  validate(@Param('platformId') platformId: string): {
    platformId: string;
    valid: boolean;
    issues: string[];
  } {
    const config = this.loader.getByPlatform(platformId);
    if (!config) {
      return {
        platformId,
        valid: false,
        issues: [`No config loaded for platform_id ${platformId}`],
      };
    }
    const issues = this.validator.validate(config);
    return { platformId, valid: issues.length === 0, issues };
  }
}
