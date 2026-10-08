import { createHmac } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FloatraWebhookController } from './floatra-webhook.controller';
import { loadWebhookFixture } from '../contract/fixtures';
import { FloatraWebhookEvent } from '../config/config.types';

/**
 * P0-8 + P0-9 + P0-10 integration, driven by a core-rendered delivery
 * (headers + raw body exactly as core's partner-webhooks processor sends
 * them). Loader, translator, and dedup are mocked so the controller's
 * gate ordering and response codes are the focus.
 */
const f = loadWebhookFixture('webhook-order.credit_approved');
const H = f.headers;
const MS_PER_SECOND = 1000;
const sentAtMs = Number(H['X-Floatra-Timestamp']) * MS_PER_SECOND;
const BEYOND_REPLAY_WINDOW_MS = 6 * 60 * 1000;

describe('FloatraWebhookController', () => {
  beforeEach(() => jest.useFakeTimers({ now: sentAtMs }));
  afterEach(() => jest.useRealTimers());

  function makeController(
    opts: {
      isDuplicate?: boolean;
      translatorThrows?: boolean;
      apiKey?: string;
    } = {},
  ) {
    // The core fixtures are live deliveries (`livemode: true`), so the
    // default config holds a live key.
    const loader = {
      getByPlatform: jest.fn().mockReturnValue({
        webhook_secret: f.secret,
        api_key: opts.apiKey ?? 'live_pk_test',
      }),
    };
    const translator = {
      translateAndDeliver: jest.fn<
        Promise<void>,
        [FloatraWebhookEvent, unknown]
      >(
        opts.translatorThrows
          ? async () => {
              throw new Error('ERP refused');
            }
          : async () => undefined,
      ),
    };
    const dedup = {
      isDuplicate: jest.fn().mockResolvedValue(opts.isDuplicate ?? false),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new FloatraWebhookController(
      loader as never,
      translator as never,
      dedup as never,
    );
    return { controller, loader, translator, dedup };
  }

  const call = (
    controller: FloatraWebhookController,
    over: Partial<Record<'sig' | 'ts' | 'id', string>> = {},
    body = f.body,
  ) =>
    controller.handle(
      'plat-x',
      over.sig ?? H['X-Floatra-Signature'],
      over.ts ?? H['X-Floatra-Timestamp'],
      over.id ?? H['X-Floatra-Event-ID'],
      H['X-Floatra-Delivery-Attempt'],
      { rawBody: Buffer.from(body) } as never,
    );

  it('accepts a real core delivery and routes the flat payload', async () => {
    const { controller, translator, dedup } = makeController();
    await expect(call(controller)).resolves.toEqual({ accepted: true });
    const event = translator.translateAndDeliver.mock.calls[0][0];
    expect(event).toEqual(
      expect.objectContaining({
        event_id: H['X-Floatra-Event-ID'],
        event_type: 'order.credit_approved',
      }),
    );
    expect(event.data).toEqual(
      expect.objectContaining({
        externalOrderId: 'SO-1001',
        amount: '250000.00',
      }),
    );
    expect(dedup.isDuplicate).toHaveBeenCalledWith(H['X-Floatra-Event-ID']);
  });

  // Core treats non-2xx as failure (#1220): a duplicate must be a 200,
  // or core retries it to dead-letter.
  it('ignores (200) an event from the other realm and never routes it', async () => {
    // Staging pass 2026-10-08: a sandbox-keyed adapter forwarded a
    // livemode=true event to the ERP. Sandbox and live keys share the
    // destination and the signing secret, so the signature cannot tell.
    const { controller, translator, dedup } = makeController({
      apiKey: 'sbx_pk_test',
    });
    await expect(call(controller)).resolves.toEqual({
      accepted: true,
      ignored: true,
    });
    expect(translator.translateAndDeliver).not.toHaveBeenCalled();
    expect(dedup.isDuplicate).not.toHaveBeenCalled();
  });

  it('answers a duplicate with 200 and does not re-route it', async () => {
    const { controller, translator } = makeController({ isDuplicate: true });
    await expect(call(controller)).resolves.toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(translator.translateAndDeliver).not.toHaveBeenCalled();
  });

  it('rejects a tampered body (403)', async () => {
    const { controller } = makeController();
    await expect(
      call(controller, {}, f.body.replace('250000.00', '9.00')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a replay outside the window (403)', async () => {
    jest.setSystemTime(sentAtMs + BEYOND_REPLAY_WINDOW_MS);
    const { controller } = makeController();
    await expect(call(controller)).rejects.toThrow(ForbiddenException);
  });

  it('rejects a missing timestamp header (403)', async () => {
    const { controller } = makeController();
    await expect(call(controller, { ts: '' })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('400s when the event id header is missing', async () => {
    const { controller } = makeController();
    await expect(call(controller, { id: '' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('400s when a validly-signed body has no `event` field', async () => {
    const { controller, translator } = makeController();
    const body = JSON.stringify({ loanId: 'loan_01' });
    const sig = createHmac('sha256', f.secret)
      .update(`${H['X-Floatra-Timestamp']}.${body}`)
      .digest('hex');
    await expect(call(controller, { sig }, body)).rejects.toThrow(
      BadRequestException,
    );
    expect(translator.translateAndDeliver).not.toHaveBeenCalled();
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"order.disbursed"'],
    ['a number', '42'],
  ])(
    '400s (not 500) when a validly-signed body parses to %s',
    async (_label, body) => {
      const { controller, translator } = makeController();
      const sig = createHmac('sha256', f.secret)
        .update(`${H['X-Floatra-Timestamp']}.${body}`)
        .digest('hex');
      await expect(call(controller, { sig }, body)).rejects.toThrow(
        BadRequestException,
      );
      expect(translator.translateAndDeliver).not.toHaveBeenCalled();
    },
  );

  it('returns 404 on an unknown platform_id', async () => {
    const { controller, loader } = makeController();
    loader.getByPlatform.mockReturnValue(null);
    await expect(call(controller)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('releases the dedup claim when the translator throws (so Floatra retry can succeed)', async () => {
    const { controller, dedup } = makeController({ translatorThrows: true });
    await expect(call(controller)).rejects.toThrow('ERP refused');
    expect(dedup.release).toHaveBeenCalledWith(H['X-Floatra-Event-ID']);
  });
});
