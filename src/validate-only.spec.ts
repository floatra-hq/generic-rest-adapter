import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runValidateOnly, VALIDATE_FAILED, VALIDATE_OK } from './validate-only';

const EXAMPLE_CONFIG = path.resolve(__dirname, '..', 'configs', 'example.json');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-validate-'));
}

function writeConfig(dir: string, name: string, body: string): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o600);
}

function env(dir: string, extra: Record<string, string> = {}): ConfigService {
  return new ConfigService({ CONFIG_DIR: dir, ...extra });
}

describe('runValidateOnly (--validate-only)', () => {
  it('passes the shipped example config', () => {
    const dir = tempDir();
    writeConfig(dir, 'example.json', fs.readFileSync(EXAMPLE_CONFIG, 'utf-8'));
    expect(runValidateOnly(env(dir))).toBe(VALIDATE_OK);
  });

  it('fails a config the validator rejects', () => {
    const dir = tempDir();
    const config = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf-8')) as {
      outbound: { on_reorder_locked: { block_merchant_orders: boolean } };
    };
    config.outbound.on_reorder_locked.block_merchant_orders = false;
    writeConfig(dir, 'bad.json', JSON.stringify(config));
    expect(runValidateOnly(env(dir))).toBe(VALIDATE_FAILED);
  });

  it('fails a file that is not JSON', () => {
    const dir = tempDir();
    writeConfig(dir, 'broken.json', '{ not json');
    expect(runValidateOnly(env(dir))).toBe(VALIDATE_FAILED);
  });

  it('fails a group/world-readable config unless STRICT_FILE_PERMS=false', () => {
    const dir = tempDir();
    writeConfig(dir, 'example.json', fs.readFileSync(EXAMPLE_CONFIG, 'utf-8'));
    fs.chmodSync(path.join(dir, 'example.json'), 0o644);
    expect(runValidateOnly(env(dir))).toBe(VALIDATE_FAILED);
    expect(runValidateOnly(env(dir, { STRICT_FILE_PERMS: 'false' }))).toBe(
      VALIDATE_OK,
    );
  });

  it('fails when the directory holds no configs (a wrong mount)', () => {
    expect(runValidateOnly(env(tempDir()))).toBe(VALIDATE_FAILED);
  });

  it('fails when the directory does not exist', () => {
    const missing = path.join(tempDir(), 'nope');
    expect(runValidateOnly(env(missing))).toBe(VALIDATE_FAILED);
  });
});
