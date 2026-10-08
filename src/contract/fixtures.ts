import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Core-rendered contract fixtures (see core partner-contract-fixtures.spec.ts). */
const DIR = join(__dirname, 'fixtures');

export interface WebhookFixture {
  secret: string;
  headers: Record<string, string>;
  body: string;
}

export function loadWebhookFixture(name: string): WebhookFixture {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
}

export function loadResponseFixture(name: string): {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
} {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
}

export function loadJsonFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
}
