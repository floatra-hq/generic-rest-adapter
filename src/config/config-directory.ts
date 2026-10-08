import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FloatraAdapterConfig } from './config.types';
import { ConfigValidatorService } from './config-validator.service';

/**
 * Reads and validates every per-platform `*.json` config under
 * CONFIG_DIR. Shared by the running adapter (ConfigLoaderService) and
 * the `--validate-only` CLI mode, so both apply exactly the same
 * checks: directory exists, file permissions, JSON parse, the
 * ENABLED_PLATFORM_IDS filter, the validator, and duplicate
 * platform ids. Throws on the first problem; never touches the network.
 */
export function loadConfigDirectory(
  env: ConfigService,
  validator: ConfigValidatorService,
  logger: Logger,
): Map<string, FloatraAdapterConfig> {
  const configs = new Map<string, FloatraAdapterConfig>();
  const dir = path.resolve(env.get<string>('CONFIG_DIR', './configs'));
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Adapter config directory not found: ${dir}. Set CONFIG_DIR or create the directory.`,
    );
  }

  const enabledRaw = env.get<string>('ENABLED_PLATFORM_IDS', '');
  const enabled = new Set(
    enabledRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !f.startsWith('.'));
  if (files.length === 0) {
    logger.warn(
      `No *.json config files found in ${dir}. Adapter will start but reject all inbound requests.`,
    );
    return configs;
  }

  for (const file of files) {
    const full = path.join(dir, file);
    // P1-21: config files carry plaintext API keys + HMAC secrets.
    // README says "chmod 0600" but nothing enforced it; reject
    // group / world-readable files at boot so a misconfigured
    // deploy fails loudly instead of leaking secrets via a stray
    // 644. STRICT_FILE_PERMS=false escapes the check for non-POSIX
    // dev environments (Windows, mounted volumes that can't honour
    // chmod).
    assertSafeFilePerms(env, full, file);
    const raw = fs.readFileSync(full, 'utf-8');
    let parsed: FloatraAdapterConfig;
    try {
      parsed = JSON.parse(raw) as FloatraAdapterConfig;
    } catch (err) {
      throw new Error(
        `Config file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (enabled.size > 0 && !enabled.has(parsed.platform_id)) {
      logger.log(
        `Skipping config ${file} (platform_id=${parsed.platform_id}) — not in ENABLED_PLATFORM_IDS`,
      );
      continue;
    }

    validator.assertValid(parsed);

    if (configs.has(parsed.platform_id)) {
      throw new Error(
        `Duplicate platform_id "${parsed.platform_id}" in config files. Each platform must have exactly one config.`,
      );
    }
    configs.set(parsed.platform_id, parsed);
    logger.log(
      `Loaded config for platform "${parsed.platform_id}" (${parsed.erp_type}) from ${file}`,
    );
  }
  return configs;
}

/**
 * P1-21: refuse to load a config file the OS reports as readable by
 * group or world. The user bit isn't checked (most deploys run as
 * the file owner). On Windows the mode bits don't map cleanly to
 * POSIX, so we bail out of the check on win32 and rely on NTFS
 * ACLs. STRICT_FILE_PERMS=false is the explicit escape hatch.
 */
function assertSafeFilePerms(
  env: ConfigService,
  fullPath: string,
  file: string,
): void {
  if (process.platform === 'win32') return;
  const strict =
    (env.get<string>('STRICT_FILE_PERMS', 'true') ?? 'true').toLowerCase() !==
    'false';
  if (!strict) return;

  let mode: number;
  try {
    mode = fs.statSync(fullPath).mode;
  } catch (err) {
    throw new Error(
      `Config file ${file} cannot be stat'd for permission check: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  // 0o077 = group RWX + world RWX. Any bit here means the file is
  // accessible to anyone other than the owner.
  const overlyOpen = mode & 0o077;
  if (overlyOpen !== 0) {
    const octal = (mode & 0o777).toString(8).padStart(3, '0');
    throw new Error(
      `Config file ${file} has unsafe permissions (mode=0${octal}). ` +
        `Plaintext API keys + webhook secrets must not be readable by ` +
        `group or world. Run: chmod 600 ${fullPath}. ` +
        `Set STRICT_FILE_PERMS=false to bypass for non-POSIX envs.`,
    );
  }
}
