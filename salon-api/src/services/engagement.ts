import type pg from 'pg';
import { query, withIntegration } from '../db.js';
import { blindIndex } from '../crypto.js';
import { incrementMetric } from '../metrics.js';

export type ReminderStatus =
  | 'SCHEDULED'
  | 'SENT'
  | 'DELIVERED'
  | 'OPENED'
  | 'CLICKED'
  | 'CONVERTED_TO_BOOKING'
  | 'SUPPRESSED_OPT_OUT'
  | 'SUPPRESSED_ALREADY_BOOKED'
  | 'FAILED';

export interface ReminderByToken {
  id: string;
  salon_id: string;
  customer_id: string;
  status: ReminderStatus;
  template_code: string;
  deep_link_token: string;
}

function statusRank(status: string): number {
  switch (status) {
    case 'SENT':
      return 1;
    case 'DELIVERED':
      return 2;
    case 'OPENED':
      return 3;
    case 'CLICKED':
      return 4;
    case 'CONVERTED_TO_BOOKING':
      return 5;
    default:
      return 0;
  }
}

/** A public click can only move engagement forward; it never un-converts a booking. */
function advanceStatus(current: string, next: ReminderStatus): ReminderStatus {
  if (current === 'CONVERTED_TO_BOOKING') return current as ReminderStatus;
  return statusRank(next) >= statusRank(current) ? next : (current as ReminderStatus);
}

export async function reminderByToken(token: string): Promise<ReminderByToken | null> {
  const rows = await query<ReminderByToken>(
    `SELECT id, salon_id, customer_id, status, template_code, deep_link_token
       FROM retention_reminders
      WHERE deep_link_token = $1
      LIMIT 1`,
    [token],
  );
  return rows[0] ?? null;
}

/**
 * Record a link click from the public redirect. Runs under the trusted
 * integration GUC because the request has no salon session.
 */
export async function recordReminderClick(
  token: string,
): Promise<{ reminder: ReminderByToken; status: ReminderStatus } | null> {
  return withIntegration(async (client) => {
    const found = await client.query<ReminderByToken>(
      `SELECT id, salon_id, customer_id, status, template_code, deep_link_token
         FROM retention_reminders
        WHERE deep_link_token = $1
        FOR UPDATE`,
      [token],
    );
    const reminder = found.rows[0];
    if (!reminder) return null;

    const next = advanceStatus(reminder.status, 'CLICKED');
    await client.query(
      `UPDATE retention_reminders
          SET status = $2,
              clicked_at = COALESCE(clicked_at, NOW())
        WHERE id = $1`,
      [reminder.id, next],
    );
    await insertEvent(client, reminder.id, null, 'CLICKED', { token });
    incrementMetric('glamconnect_reminder_clicks_total');
    return { reminder: { ...reminder, status: next }, status: next };
  });
}

/** Attribute a booking that started from a reminder link. */
export async function attributeReminderBooking(
  client: pg.PoolClient,
  opts: { token: string; salonId: string; bookingId: string },
): Promise<void> {
  const updated = await client.query<{ id: string }>(
    `UPDATE retention_reminders
        SET status = 'CONVERTED_TO_BOOKING',
            converted_at = NOW(),
            clicked_at = COALESCE(clicked_at, NOW())
      WHERE deep_link_token = $1
        AND salon_id = $2
      RETURNING id`,
    [opts.token, opts.salonId],
  );
  const reminder = updated.rows[0];
  if (!reminder) return;
  await insertEvent(client, reminder.id, null, 'CONVERTED_TO_BOOKING', { booking_id: opts.bookingId });
  incrementMetric('glamconnect_reminder_conversions_total');
}

export async function insertEvent(
  client: pg.PoolClient,
  reminderId: string,
  provider: string | null,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO reminder_events (reminder_id, provider, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [reminderId, provider, eventType, JSON.stringify(payload)],
  );
}

/**
 * Apply a provider delivery receipt by provider message id.
 * Events are monotonic: a late "sent" callback cannot downgrade "clicked".
 */
export async function applyDeliveryEvent(opts: {
  provider: string;
  messageId: string;
  eventType: string;
  providerStatus?: string;
  payload?: Record<string, unknown>;
}): Promise<boolean> {
  const eventType = opts.eventType.toUpperCase();
  const statusMap: Record<string, ReminderStatus> = {
    DELIVERED: 'DELIVERED',
    READ: 'OPENED',
    OPENED: 'OPENED',
    FAILED: 'FAILED',
    UNDELIVERED: 'FAILED',
  };
  const next = statusMap[eventType];
  if (!next) return false;

  return withIntegration(async (client) => {
    const found = await client.query<{ id: string; status: ReminderStatus }>(
      `SELECT id, status FROM retention_reminders
        WHERE provider = $1 AND provider_message_id = $2
        FOR UPDATE`,
      [opts.provider, opts.messageId],
    );
    const reminder = found.rows[0];
    if (!reminder) return false;

    const newStatus = advanceStatus(reminder.status, next);
    await client.query(
      `UPDATE retention_reminders
          SET status = $2,
              delivered_at = CASE WHEN $2 = 'DELIVERED' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
              opened_at = CASE WHEN $2 = 'OPENED' THEN COALESCE(opened_at, NOW()) ELSE opened_at END,
              last_error = CASE WHEN $2 = 'FAILED' THEN $3 ELSE last_error END
        WHERE id = $1`,
      [reminder.id, newStatus, opts.providerStatus ?? null],
    );
    await insertEvent(client, reminder.id, opts.provider, eventType, {
      ...(opts.payload ?? {}),
      provider_status: opts.providerStatus ?? null,
    });
    incrementMetric(`glamconnect_reminder_delivery_${eventType.toLowerCase()}_total`);
    return true;
  });
}

export { isOptOutMessage } from './opt-out.js';

/**
 * Honour an inbound STOP. Consent is revoked for retention reminders across
 * every salon, and pending reminders are suppressed immediately.
 */
export async function recordOptOut(opts: {
  phone: string;
  channel: 'SMS' | 'WHATSAPP';
  provider: string;
  reason?: string;
}): Promise<{ userId: string | null; suppressed: number }> {
  const user = await query<{ id: string }>(`SELECT id FROM users WHERE phone_blind_index = $1 LIMIT 1`, [
    blindIndex(opts.phone),
  ]);
  const userId = user[0]?.id ?? null;
  if (!userId) return { userId: null, suppressed: 0 };

  await query(
    `INSERT INTO customer_consents (user_id, salon_id, channel, purpose, is_granted)
     VALUES ($1, NULL, $2, 'RETENTION_REMINDER', FALSE)
     ON CONFLICT (user_id, salon_id, channel, purpose)
     DO UPDATE SET is_granted = FALSE, updated_at = NOW()`,
    [userId, opts.channel],
  );

  const suppressed = await withIntegration(async (client) => {
    const rows = await client.query<{ id: string }>(
      `UPDATE retention_reminders
          SET status = 'SUPPRESSED_OPT_OUT', next_attempt_at = NULL
        WHERE customer_id = $1
          AND channel = $2
          AND status IN ('SCHEDULED', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED')
        RETURNING id`,
      [userId, opts.channel],
    );
    for (const row of rows.rows) {
      await insertEvent(client, row.id, opts.provider, 'OPT_OUT', { reason: opts.reason ?? 'inbound STOP' });
    }
    return rows.rowCount ?? 0;
  });

  incrementMetric('glamconnect_reminder_opt_outs_total');
  return { userId, suppressed };
}

/** Engagement counters for the partner reminders dashboard. */
export async function reminderFunnel(salonId: string): Promise<Record<string, number>> {
  const rows = await query<{ status: string; n: string }>(
    `SELECT status::text AS status, COUNT(*)::int AS n
       FROM retention_reminders
      WHERE salon_id = $1
      GROUP BY status`,
    [salonId],
  );
  const base: Record<string, number> = {
    scheduled: 0,
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    converted: 0,
    suppressed: 0,
    failed: 0,
  };
  for (const row of rows) {
    const n = Number(row.n);
    if (row.status === 'SCHEDULED') base.scheduled += n;
    else if (row.status === 'SENT') base.sent += n;
    else if (row.status === 'DELIVERED') base.delivered += n;
    else if (row.status === 'OPENED') base.opened += n;
    else if (row.status === 'CLICKED') base.clicked += n;
    else if (row.status === 'CONVERTED_TO_BOOKING') base.converted += n;
    else if (row.status.startsWith('SUPPRESSED')) base.suppressed += n;
    else if (row.status === 'FAILED') base.failed += n;
  }
  return base;
}
