import type pg from 'pg';
import { one, withTenant } from '../db.js';
import { randomToken } from '../crypto.js';
import { notFound } from '../http.js';
import { dispatchReminders } from './dispatcher.js';

export interface ReminderScheduleInput {
  salonId: string;
  customerId: string;
  bookingId: string | null;
  serviceCategoryId: string;
  completedAt: Date;
  intervalDays?: number;
}

/**
 * F1.12 closed loop: after a completed visit, schedule Day N-5 / N / N+10 reminders.
 * Runs inside the caller's transaction with app.current_salon_id already set.
 */
export async function scheduleReminders(client: pg.PoolClient, input: ReminderScheduleInput): Promise<void> {
  let interval = input.intervalDays;
  if (!interval) {
    const category = await one<{ default_reminder_interval_days: number }>(
      `SELECT default_reminder_interval_days FROM service_categories WHERE id = $1`,
      [input.serviceCategoryId],
    );
    interval = category?.default_reminder_interval_days ?? 25;
  }

  const stages: { stage: string; offset: number; template: string }[] = [
    { stage: 'DAY_20_GENTLE', offset: Math.max(1, interval - 5), template: 'WA_GENTLE_DUE_V1' },
    { stage: 'DAY_25_INVITE', offset: interval, template: 'WA_INVITE_BOOK_V1' },
    { stage: 'DAY_35_REENGAGE', offset: interval + 10, template: 'WA_REENGAGE_V1' },
  ];

  for (const s of stages) {
    const scheduledFor = new Date(input.completedAt.getTime() + s.offset * 86_400_000);
    await client.query(
      `INSERT INTO retention_reminders
         (salon_id, customer_id, source_booking_id, service_category_id, stage, channel,
          scheduled_for, status, template_code, deep_link_token)
       VALUES ($1, $2, $3, $4, $5, 'WHATSAPP', $6, 'SCHEDULED', $7, $8)`,
      [
        input.salonId,
        input.customerId,
        input.bookingId,
        input.serviceCategoryId,
        s.stage,
        scheduledFor,
        s.template,
        randomToken(16),
      ],
    );
  }
}

/** Instant suppression when a new booking is created (F1.12). */
export async function suppressReminders(client: pg.PoolClient, customerId: string, salonId: string): Promise<void> {
  await client.query(
    `UPDATE retention_reminders
        SET status = 'SUPPRESSED_ALREADY_BOOKED'
      WHERE customer_id = $1 AND salon_id = $2 AND status = 'SCHEDULED'`,
    [customerId, salonId],
  );
}

export async function listReminders(salonId: string, filters: { status?: string[]; from?: string }) {
  const statuses = filters.status?.length ? filters.status : null;

  return withTenant(salonId, async (client) => {
    const rows = await client.query(
      `SELECT r.*, u.full_name AS customer_name
         FROM retention_reminders r
         JOIN users u ON u.id = r.customer_id
        WHERE r.salon_id = $1
          AND ($2::text[] IS NULL OR r.status::text = ANY($2::text[]))
          AND ($3::date IS NULL OR r.created_at >= $3::date)
        ORDER BY r.scheduled_for DESC
        LIMIT 200`,
      [salonId, statuses, filters.from ?? null],
    );

    const summary = await client.query<{ sent: string; delivered: string; clicked: string; converted: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','OPENED','CLICKED','CONVERTED_TO_BOOKING')) AS sent,
         COUNT(*) FILTER (WHERE status IN ('DELIVERED','OPENED','CLICKED','CONVERTED_TO_BOOKING')) AS delivered,
         COUNT(*) FILTER (WHERE status IN ('CLICKED','CONVERTED_TO_BOOKING')) AS clicked,
         COUNT(*) FILTER (WHERE status = 'CONVERTED_TO_BOOKING') AS converted
       FROM retention_reminders WHERE salon_id = $1`,
      [salonId],
    );

    const sent = Number(summary.rows[0]?.sent ?? 0);
    const clicked = Number(summary.rows[0]?.clicked ?? 0);
    const converted = Number(summary.rows[0]?.converted ?? 0);
    return {
      summary: {
        sent,
        delivered: Number(summary.rows[0]?.delivered ?? 0),
        clicked,
        converted_bookings: converted,
        conversion_rate_pct: sent ? Number(((converted / sent) * 100).toFixed(1)) : 0,
      },
      reminders: rows.rows,
    };
  });
}

export async function triggerReminders(opts: {
  salonId: string;
  customerIds: string[];
  channel: 'WHATSAPP' | 'SMS' | 'PUSH' | 'EMAIL';
  templateCode: string;
  serviceCategoryId?: string;
}) {
  const category =
    opts.serviceCategoryId ??
    (await one<{ id: string }>(`SELECT id FROM service_categories ORDER BY display_order LIMIT 1`))?.id;
  if (!category) throw notFound('No service category configured');

  const queued = await withTenant(opts.salonId, async (client) => {
    let enqueued = 0;
    let skipped = 0;
    const reminderIds: string[] = [];
    for (const customerId of opts.customerIds) {
      const consent = await client.query<{ is_granted: boolean }>(
        `SELECT is_granted FROM customer_consents
          WHERE user_id = $1 AND salon_id = $2 AND channel = $3 AND purpose = 'RETENTION_REMINDER'
          LIMIT 1`,
        [customerId, opts.salonId, opts.channel],
      );
      if (!consent.rows[0]?.is_granted) {
        skipped += 1;
        continue;
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO retention_reminders
           (salon_id, customer_id, service_category_id, stage, channel, scheduled_for,
            status, template_code, deep_link_token)
         VALUES ($1, $2, $3, 'DAY_25_INVITE', $4, NOW(), 'SCHEDULED', $5, $6)
         RETURNING id`,
        [opts.salonId, customerId, category, opts.channel, opts.templateCode, randomToken(16)],
      );
      reminderIds.push(inserted.rows[0].id);
      enqueued += 1;
    }
    return { enqueued, skipped, reminderIds };
  });

  if (!queued.reminderIds.length) {
    return { enqueued: 0, skipped: queued.skipped, sent: 0, failed: 0 };
  }

  // "Send now" should actually attempt delivery. The interval dispatcher remains
  // responsible for scheduled journey reminders and retries.
  const delivery = await dispatchReminders({
    ids: queued.reminderIds,
    salonId: opts.salonId,
  });

  return {
    enqueued: queued.enqueued,
    skipped: queued.skipped,
    sent: delivery.sent,
    failed: delivery.failed,
  };
}
