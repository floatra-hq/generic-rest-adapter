import { FloatraWebhookEvent } from '../config/config.types';

/**
 * Core sends a FLAT payload ({ event, loanId, amount, ..., timestamp }), and
 * the event id travels in X-Floatra-Event-ID (= core's delivery id). Wrap it
 * in the adapter's internal envelope; mappings address fields as
 * `$.data.<coreField>`.
 *
 * `fallbackEventType` is used when `payload.event` is not a non-empty
 * string — the undelivered poller passes the row's own `event_type`, so a
 * replayed row is never routed as '' (which the translator would drop and
 * the poller would then ACK, losing the event).
 */
export function toWebhookEvent(
  eventId: string,
  payload: Record<string, unknown>,
  fallbackEventType?: string,
): FloatraWebhookEvent {
  const payloadEvent =
    typeof payload.event === 'string' && payload.event !== ''
      ? payload.event
      : undefined;
  return {
    event_id: eventId,
    event_type: payloadEvent ?? fallbackEventType ?? '',
    occurred_at: typeof payload.timestamp === 'string' ? payload.timestamp : '',
    data: payload,
  };
}
