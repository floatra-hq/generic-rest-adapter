import { toWebhookEvent } from './webhook-event';
import { loadWebhookFixture } from '../contract/fixtures';

describe('toWebhookEvent', () => {
  it('wraps a core-rendered flat payload: event → event_type, timestamp → occurred_at', () => {
    const f = loadWebhookFixture('webhook-order.disbursed');
    const payload = JSON.parse(f.body) as Record<string, unknown>;
    const event = toWebhookEvent(f.headers['X-Floatra-Event-ID'], payload);
    expect(event).toEqual({
      event_id: f.headers['X-Floatra-Event-ID'],
      event_type: 'order.disbursed',
      occurred_at: payload.timestamp,
      data: payload,
    });
  });

  it('falls back to empty strings when event / timestamp are absent or not strings', () => {
    expect(toWebhookEvent('dlv_x', { timestamp: 1790856000 })).toEqual({
      event_id: 'dlv_x',
      event_type: '',
      occurred_at: '',
      data: { timestamp: 1790856000 },
    });
  });

  it('uses the fallback event type when payload.event is absent or empty', () => {
    expect(
      toWebhookEvent('dlv_y', { loanId: 'l-1' }, 'order.disbursed').event_type,
    ).toBe('order.disbursed');
    expect(
      toWebhookEvent('dlv_y', { event: '' }, 'order.disbursed').event_type,
    ).toBe('order.disbursed');
  });

  it('prefers payload.event over the fallback when it is a non-empty string', () => {
    expect(
      toWebhookEvent(
        'dlv_z',
        { event: 'order.credit_approved' },
        'order.disbursed',
      ).event_type,
    ).toBe('order.credit_approved');
  });
});
