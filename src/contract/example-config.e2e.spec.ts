import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { FloatraAdapterConfig } from '../config/config.types';
import { ConfigValidatorService } from '../config/config-validator.service';
import { ConfigLoaderService } from '../config/config-loader.service';
import { FloatraWebhookController } from '../controllers/floatra-webhook.controller';
import { ErpDeliveryService } from '../erp/erp-delivery.service';
import { OutboundTranslatorService } from '../translators/outbound-translator.service';
import { EventDedupService } from '../webhook/event-dedup.service';
import { loadWebhookFixture } from './fixtures';

/**
 * End-to-end proof that the SHIPPED example config works against
 * core-rendered webhooks: core fixture -> real controller (HMAC +
 * freshness + toWebhookEvent) -> real outbound translator -> the body
 * the ERP would receive (ERP delivery is the only mock).
 */
const MS_PER_SECOND = 1000;

const example = JSON.parse(
  readFileSync(join(__dirname, '../../configs/example.json'), 'utf8'),
) as FloatraAdapterConfig;

async function deliver(
  name: string,
  apiKey = 'live_pk_contract_fixture',
): Promise<Record<string, unknown>> {
  const fixture = loadWebhookFixture(name);
  // Core renders the fixtures as live deliveries (`livemode: true`), so they
  // are delivered under a live key; a sandbox key must drop them.
  const config: FloatraAdapterConfig = {
    ...example,
    api_key: apiKey,
    webhook_secret: fixture.secret,
  };
  const delivered: Record<string, unknown>[] = [];
  const erp = {
    deliver: async (
      _config: FloatraAdapterConfig,
      body: Record<string, unknown>,
    ): Promise<void> => {
      delivered.push(body);
    },
  };
  const loader = { getByPlatform: () => config };
  const dedup = {
    isDuplicate: async () => false,
    release: async () => undefined,
  };
  const controller = new FloatraWebhookController(
    loader as unknown as ConfigLoaderService,
    new OutboundTranslatorService(erp as unknown as ErpDeliveryService),
    dedup as unknown as EventDedupService,
  );
  const headers = fixture.headers;
  jest.useFakeTimers({
    now: Number(headers['X-Floatra-Timestamp']) * MS_PER_SECOND,
  });
  try {
    await controller.handle(
      config.platform_id,
      headers['X-Floatra-Signature'],
      headers['X-Floatra-Timestamp'],
      headers['X-Floatra-Event-ID'],
      headers['X-Floatra-Delivery-Attempt'],
      { rawBody: Buffer.from(fixture.body) } as unknown as Request & {
        rawBody?: Buffer;
      },
    );
  } finally {
    jest.useRealTimers();
  }
  expect(delivered).toHaveLength(apiKey.startsWith('live_pk_') ? 1 : 0);
  return delivered[0];
}

function emptyValues(body: Record<string, unknown>): string[] {
  return Object.entries(body)
    .filter(([, v]) => v === null || v === undefined)
    .map(([k]) => k);
}

describe('configs/example.json against core-rendered webhooks', () => {
  it('is a valid config', () => {
    expect(new ConfigValidatorService().validate(example)).toEqual([]);
  });

  it('order.credit_approved reaches the ERP with every mapped field populated', async () => {
    const body = await deliver('webhook-order.credit_approved');
    expect(body).toEqual(
      expect.objectContaining({
        event_name: 'credit_approved',
        external_order_id: 'SO-1001',
        floatra_loan_id: 'loan_01',
        approved_amount: '250000.00',
        due_date: '2026-10-15T00:00:00.000Z',
        update_fields: { 'OrderHeader.PaymentTerms': 14 },
      }),
    );
    expect(emptyValues(body)).toEqual([]);
  });

  it('order.disbursed reaches the ERP with every mapped field populated', async () => {
    const body = await deliver('webhook-order.disbursed');
    expect(body).toEqual(
      expect.objectContaining({
        event_name: 'credit_disbursed',
        external_order_id: 'SO-1001',
        floatra_loan_id: 'loan_01',
        amount: '250000.00',
      }),
    );
    expect(emptyValues(body)).toEqual([]);
  });

  it('a sandbox key never forwards a live delivery to the ERP', async () => {
    await expect(
      deliver('webhook-order.credit_approved', 'sbx_pk_contract_fixture'),
    ).resolves.toBeUndefined();
  });

  it('merchant.reorder_locked tells the ERP WHICH customer to block', async () => {
    const body = await deliver('webhook-merchant.reorder_locked');
    expect(body).toEqual(
      expect.objectContaining({
        block_merchant_orders: true,
        merchant_external_id: 'CUST-77',
      }),
    );
  });

  it('merchant.reorder_unlocked tells the ERP WHICH customer to unblock', async () => {
    const body = await deliver('webhook-merchant.reorder_unlocked');
    expect(body).toEqual(
      expect.objectContaining({
        unblock_merchant_orders: true,
        merchant_external_id: 'CUST-77',
      }),
    );
  });
});
