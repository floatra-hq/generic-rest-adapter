import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loadConfigDirectory } from './config/config-directory';
import { ConfigValidatorService } from './config/config-validator.service';

export const VALIDATE_ONLY_FLAG = '--validate-only';

/** Process exit codes for `node dist/main.js --validate-only`. */
export const VALIDATE_OK = 0;
export const VALIDATE_FAILED = 1;

/**
 * `--validate-only`: load and validate every config under CONFIG_DIR
 * with the same checks the adapter runs at boot, then exit. No HTTP
 * server, no Redis, no gateway ping — safe to run before a deploy.
 * Zero loaded configs is a failure here (it means a wrong mount).
 */
export function runValidateOnly(
  env: ConfigService = new ConfigService(),
): number {
  const logger = new Logger('ValidateOnly');
  try {
    const configs = loadConfigDirectory(
      env,
      new ConfigValidatorService(),
      logger,
    );
    if (configs.size === 0) {
      // Booting with no configs is allowed (the adapter rejects every
      // request); asking to validate none is almost always a wrong mount.
      logger.error('Config validation failed: no platform configs loaded');
      return VALIDATE_FAILED;
    }
    logger.log(
      `OK: ${configs.size} platform config(s) valid (${Array.from(
        configs.keys(),
      ).join(', ')})`,
    );
    return VALIDATE_OK;
  } catch (err) {
    logger.error(
      `Config validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return VALIDATE_FAILED;
  }
}
