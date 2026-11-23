import type pg from 'pg';
import { one, query, tx } from '../db.js';
import { redis } from '../redis.js';
import { bookingCode, checkinPin, randomToken } from '../crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../http.js';
import {
  assertSlotAvailable,
  fmtLocalDate,
  fmtLocalTime,
  getSalonOrThrow,
  loadServices,
  priceOf,
  totalDuration,
} from './availability.js';
import { suppressReminders } from './reminders.js';
import { attributeReminderBooking } from './engagement.js';
import { queueTransactional } from './transactional.js';

const HOLD_TTL_SEC = 300;
const SLOT_STEP_MS = 15 * 60_000;

interface HeldService {
  id: string;
  name: string;
  price_paise: number;
  duration_mins: number;
  buffer_after_mins: number;
  category_id: string;
}

export interface HoldPayload {
  hold_token: string;
  salon_id: string;
  customer_id: string;
  service_ids: string[];
  services: HeldService[];
  staff_id: string;
  resource_id: string | null;
  start_at: string;
  end_at: string;
  pricing: {
    subtotal_paise: number;
    discount_paise: number;
    tax_paise: number;
    total_payable_paise: number;
  };
  lock_keys: string[];
}

function lockKey(salonId: string, staffId: string, dateISO: string, minuteIndex: number) {
  return `lock:slot:${salonId}:${staffId}:${dateISO.replace(/-/g, '')}:${minuteIndex}`;
}

async function acquireSlotLocks(payload: Omit<HoldPayload, 'lock_keys' | 'hold_token'>): Promise<string[]> {  const dateISO = fmtLocalDate(new Date(payload.start_at));
  const dayStart = new Date(`${dateISO}T00:00:00+05:30`).getTime();
  const startMs = new Date(payload.start_at).getTime();
  const endMs = new Date(payload.end_at).getTime();
  const keys: string[] = [];
  for (let t = startMs; t < endMs; t += SLOT_STEP_MS) {
    const minuteIndex = Math.floor((t - dayStart) / SLOT_STEP_MS);
    const key = lockKey(payload.salon_id, payload.staff_id, dateISO, minuteIndex);
    const ok = await redis.set(key, payload.customer_id, 'PX', HOLD_TTL_SEC * 1000, 'NX');
    if (!ok) {
      if (keys.length) await redis.del(...keys);
      throw conflict('SLOT_TAKEN', 'Someone just grabbed this slot. Please pick another.');
    }
    keys.push(key);
  }
  return keys;
}

interface BookingNoticeContext {
  customerName: string;
  salonName: string;
  serviceName?: string;
  whenLocal: string;
  bookingCode?: string;
}

async function bookingNoticeContext(booking: any, serviceName?: string): Promise<BookingNoticeContext> {
  const salon = await one<{ name: string }>(`SELECT name FROM salons WHERE id = $1`, [booking.salon_id]);
  const customer = await one<{ full_name: string }>(`SELECT full_name FROM users WHERE id = $1`, [
    booking.customer_id,
  ]);
  const start = new Date(booking.scheduled_start_at);
  return {
    customerName: customer?.full_name ?? 'there',
    salonName: salon?.name ?? 'your salon',
    serviceName,
    whenLocal: `${fmtLocalDate(start)} ${fmtLocalTime(start)}`,
    bookingCode: booking.booking_code,
  };
}

async function firstServiceName(bookingId: string): Promise<string | undefined> {
  const row = await one<{ service_name_snapshot: string }>(
    `SELECT service_name_snapshot FROM booking_items WHERE booking_id = $1 ORDER BY time_range LIMIT 1`,
    [bookingId],
  );
  return row?.service_name_snapshot ?? undefined;
}

export async function holdBooking(opts: {
  salonId: string;
  customerId: string;
  serviceIds: string[];
  staffId?: string;
  startAt: string;
}): Promise<HoldPayload> {
  const salon = await getSalonOrThrow(opts.salonId);
  const services = await loadServices(opts.salonId, opts.serviceIds);
  const { match } = await assertSlotAvailable(opts.salonId, opts.serviceIds, opts.startAt, opts.staffId);

  const subtotal = services.reduce((sum, s) => sum + priceOf(s), 0);
  const GST_RATE = 0.18;
  const tax_paise = Math.round(subtotal * GST_RATE);
  const pricing = {
    subtotal_paise: subtotal,
    discount_paise: 0,
    tax_paise,
    total_payable_paise: subtotal + tax_paise,
  };

  const base: Omit<HoldPayload, 'lock_keys' | 'hold_token'> = {
    salon_id: opts.salonId,
    customer_id: opts.customerId,
    service_ids: opts.serviceIds,
    services: services.map((s) => ({
      id: s.id,
      name: s.custom_name,
      price_paise: priceOf(s),
      duration_mins: s.duration_mins,
      buffer_after_mins: s.buffer_after_mins,
      category_id: s.category_id,
    })),
    staff_id: match.staff_id,
    resource_id: match.resource_id,
    start_at: match.start_at,
    end_at: match.end_at,
    pricing,
  };

  const lock_keys = await acquireSlotLocks(base);
  const hold_token = `ht_${randomToken(12)}`;
  const payload: HoldPayload = { ...base, hold_token, lock_keys };
  await redis.set(`hold:${hold_token}`, JSON.stringify(payload), 'EX', HOLD_TTL_SEC);
  return payload;
}

export async function getHold(token: string): Promise<HoldPayload> {
  const raw = await redis.get(`hold:${token}`);
  if (!raw) throw conflict('HOLD_EXPIRED', 'Your slot hold expired. Please pick a time again.');
  return JSON.parse(raw) as HoldPayload;
}

async function releaseHold(payload: HoldPayload): Promise<void> {
  await redis.del(`hold:${payload.hold_token}`);
  if (payload.lock_keys.length) await redis.del(...payload.lock_keys);
}

export async function createBooking(opts: {
  customerId: string;
  holdToken: string;
  paymentMode?: string;
  customerNotes?: string;
  idempotencyKey: string;
  channel?: string;
  reminderToken?: string;
  attributionChannel?: string | null;
}): Promise<any> {
  const existing = await one<{
    id: string;
    booking_code: string;
    status: string;
    checkin_pin: string;
    scheduled_start_at: string;
    scheduled_end_at: string;
    total_payable_paise: number;
  }>(
    `SELECT id, booking_code, status, checkin_pin, scheduled_start_at, scheduled_end_at, total_payable_paise
       FROM bookings
      WHERE idempotency_key = $1 AND customer_id = $2`,
    [opts.idempotencyKey, opts.customerId],
  );
  if (existing) {
    return {
      id: existing.id,
      booking_code: existing.booking_code,
      status: existing.status,
      checkin_pin: existing.checkin_pin,
      scheduled_start_at: existing.scheduled_start_at,
      scheduled_end_at: existing.scheduled_end_at,
      total_payable_paise: existing.total_payable_paise,
    };
  }

  const hold = await getHold(opts.holdToken);
  if (hold.customer_id !== opts.customerId) throw forbidden('This hold belongs to another customer');

  const salon = await getSalonOrThrow(hold.salon_id);
  const instant = salon.accepts_instant_booking === true;
  const status = instant ? 'CONFIRMED' : 'REQUESTED';
  const pin = checkinPin();

  try {
    const booking = await tx(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.current_salon_id', hold.salon_id]);

      const inserted = await client.query(
        `INSERT INTO bookings
           (booking_code, idempotency_key, customer_id, salon_id, channel, status,
            scheduled_start_at, scheduled_end_at, approval_expires_at, checkin_pin,
            subtotal_paise, discount_paise, tax_paise, booking_fee_paise, total_payable_paise, customer_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$15)
         RETURNING *`,
        [
          bookingCode(),
          opts.idempotencyKey,
          opts.customerId,
          hold.salon_id,
          opts.channel ?? 'CUSTOMER_APP',
          status,
          hold.start_at,
          hold.end_at,
          instant ? null : new Date(Date.now() + 15 * 60_000),
          pin,
          hold.pricing.subtotal_paise,
          hold.pricing.discount_paise,
          hold.pricing.tax_paise,
          hold.pricing.total_payable_paise,
          opts.customerNotes ?? null,
        ],
      );
      const row = inserted.rows[0];

      let cursor = new Date(hold.start_at).getTime();
      for (const svc of hold.services) {
        const start = cursor;
        const end = start + svc.duration_mins * 60_000;
        await client.query(
          `INSERT INTO booking_items
             (booking_id, salon_service_id, staff_id, resource_id, service_name_snapshot,
              unit_price_paise, duration_mins, time_range, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7, tstzrange($8, $9, '[)'), 'CONFIRMED')`,
          [
            row.id,
            svc.id,
            hold.staff_id,
            hold.resource_id,
            svc.name,
            svc.price_paise,
            svc.duration_mins,
            new Date(start),
            new Date(end),
          ],
        );
        cursor = end + svc.buffer_after_mins * 60_000;
      }

      await client.query(
        `INSERT INTO booking_audit_logs
           (booking_id, actor_user_id, actor_role, previous_status, new_status, change_reason)
         VALUES ($1,$2,'CUSTOMER',NULL,$3,'booking_created')`,
        [row.id, opts.customerId, status],
      );

      if (opts.reminderToken) {
        await attributeReminderBooking(client, {
          token: opts.reminderToken,
          salonId: hold.salon_id,
          bookingId: row.id,
        });
      }

      await suppressReminders(client, opts.customerId, hold.salon_id, row.id);
      return row;
    });

    await releaseHold(hold);

    const notice = await bookingNoticeContext(booking, hold.services[0]?.name);
    queueTransactional({
      template: instant ? 'BOOKING_CONFIRMED' : 'BOOKING_REQUESTED',
      userId: opts.customerId,
      salonId: hold.salon_id,
      context: notice,
      data: { booking_id: booking.id, booking_code: booking.booking_code },
    });

    return {
      id: booking.id,
      booking_code: booking.booking_code,
      status: booking.status,
      checkin_pin: booking.checkin_pin,
      scheduled_start_at: booking.scheduled_start_at,
      scheduled_end_at: booking.scheduled_end_at,
      total_payable_paise: booking.total_payable_paise,
    };
  } catch (err: any) {
    if (err?.code === '23P01') {
      throw conflict('SLOT_TAKEN', 'That slot was just booked by someone else. Please pick another.');
    }
    if (err?.code === '23505') {
      throw conflict('DUPLICATE_BOOKING', 'This booking was already created');
    }
    throw err;
  }
}

export async function getBookingForActor(bookingId: string, auth: { id: string; role: string }) {
  const booking = await one(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
  if (!booking) throw notFound('Booking not found');
  if (auth.role === 'PLATFORM_ADMIN') return booking;
  if (booking.customer_id === auth.id) return booking;
  if (auth.role === 'SALON_OWNER' || auth.role === 'SALON_MANAGER') {
    const salon = await one(`SELECT id FROM salons WHERE id = $1 AND owner_id = $2`, [booking.salon_id, auth.id]);
    if (salon) return booking;
    const staff = await one(
      `SELECT 1 FROM staff_members WHERE salon_id = $1 AND user_id = $2 AND is_active`,
      [booking.salon_id, auth.id],
    );
    if (staff) return booking;
  }
  // Staff may only touch bookings they are actually assigned to, not every
  // booking in the salon they happen to work at.
  if (auth.role === 'STAFF') {
    const assigned = await one(
      `SELECT 1
         FROM staff_members sm
         JOIN booking_items bi ON bi.staff_id = sm.id
        WHERE sm.user_id = $1 AND sm.is_active AND bi.booking_id = $2
        LIMIT 1`,
      [auth.id, bookingId],
    );
    if (assigned) return booking;
  }
  throw forbidden('You cannot access this booking');
}

async function bookingServiceIds(client: pg.PoolClient, bookingId: string): Promise<string[]> {
  const rows = await client.query<{ salon_service_id: string }>(
    `SELECT DISTINCT salon_service_id FROM booking_items WHERE booking_id = $1`,
    [bookingId],
  );
  return rows.rows.map((r) => r.salon_service_id);
}

export async function rescheduleBooking(opts: {
  bookingId: string;
  auth: { id: string; role: string };
  newStartAt: string;
  staffId?: string;
}) {
  const booking = await getBookingForActor(opts.bookingId, opts.auth);
  if (['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SALON', 'COMPLETED', 'NO_SHOW', 'EXPIRED'].includes(booking.status)) {
    throw badRequest('BOOKING_NOT_RESCHEDULABLE', `Cannot reschedule a ${booking.status} booking`);
  }

  const serviceIds = await tx((client) => bookingServiceIds(client, opts.bookingId));

  const { match } = await assertSlotAvailable(booking.salon_id, serviceIds, opts.newStartAt, opts.staffId);
  const services = await loadServices(booking.salon_id, serviceIds);

  try {
    const updated = await tx(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.current_salon_id', booking.salon_id]);
      await client.query(
        `UPDATE bookings
            SET scheduled_start_at = $2, scheduled_end_at = $3, status = 'CONFIRMED',
                approval_expires_at = NULL
          WHERE id = $1`,
        [opts.bookingId, match.start_at, match.end_at],
      );
      await client.query(`DELETE FROM booking_items WHERE booking_id = $1`, [opts.bookingId]);

      let cursor = new Date(match.start_at).getTime();
      for (const svc of services) {
        const start = cursor;
        const end = start + svc.duration_mins * 60_000;
        await client.query(
          `INSERT INTO booking_items
             (booking_id, salon_service_id, staff_id, resource_id, service_name_snapshot,
              unit_price_paise, duration_mins, time_range, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7, tstzrange($8,$9,'[)'), 'CONFIRMED')`,
          [
            opts.bookingId,
            svc.id,
            opts.staffId ?? match.staff_id,
            match.resource_id,
            svc.custom_name,
            priceOf(svc),
            svc.duration_mins,
            new Date(start),
            new Date(end),
          ],
        );
        cursor = end + svc.buffer_after_mins * 60_000;
      }

      await client.query(
        `INSERT INTO booking_audit_logs
           (booking_id, actor_user_id, actor_role, previous_status, new_status, change_reason, metadata_json)
         VALUES ($1,$2,$3,$4,'CONFIRMED','rescheduled',$5)`,
        [
          opts.bookingId,
          opts.auth.id,
          opts.auth.role,
          booking.status,
          JSON.stringify({ old_start: booking.scheduled_start_at, new_start: match.start_at }),
        ],
      );

      const res = await client.query(`SELECT * FROM bookings WHERE id = $1`, [opts.bookingId]);
      return res.rows[0] ?? null;
    });

    if (updated) {
      const notice = await bookingNoticeContext(updated, services[0]?.custom_name);
      queueTransactional({
        template: 'BOOKING_RESCHEDULED',
        userId: booking.customer_id,
        salonId: booking.salon_id,
        context: notice,
        data: { booking_id: opts.bookingId },
      });
    }
    return updated;
  } catch (err: any) {
    if (err?.code === '23P01') throw conflict('SLOT_TAKEN', 'The new slot is no longer available');
    throw err;
  }
}

export async function cancelBooking(opts: {
  bookingId: string;
  auth: { id: string; role: string };
  reason?: string;
  cancelItemIds?: string[];
}) {
  const booking = await getBookingForActor(opts.bookingId, opts.auth);
  if (['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SALON', 'COMPLETED', 'NO_SHOW', 'EXPIRED'].includes(booking.status)) {
    throw badRequest('BOOKING_NOT_CANCELLABLE', `Cannot cancel a ${booking.status} booking`);
  }
  const partial = Array.isArray(opts.cancelItemIds) && opts.cancelItemIds.length > 0;

  // Policy calculation
  const now = Date.now();
  const scheduledStart = new Date(booking.scheduled_start_at).getTime();
  const diffHours = (scheduledStart - now) / (3600 * 1000);

  // Cancellation policy: Free if > 2 hours prior; 50% fee if within 2 hours.
  // Salons cancelling on customer receive 0% fee / full refund.
  let feeRate = 0;
  if (opts.auth.role === 'CUSTOMER') {
    feeRate = diffHours >= 2 ? 0 : 0.50;
  }

  const result = await tx(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_salon_id', booking.salon_id]);

    let targetAmountPaise = Number(booking.total_payable_paise);

    if (partial) {
      const cancelledItems = await client.query<{ unit_price_paise: number }>(
        `SELECT unit_price_paise FROM booking_items
          WHERE booking_id = $1 AND id = ANY($2::uuid[]) AND status NOT IN ('CANCELLED_BY_CUSTOMER','CANCELLED_BY_SALON')`,
        [opts.bookingId, opts.cancelItemIds],
      );
      const cancelledSubtotal = cancelledItems.rows.reduce((sum, r) => sum + Number(r.unit_price_paise), 0);
      const cancelledTax = Math.round(cancelledSubtotal * 0.18);
      targetAmountPaise = cancelledSubtotal + cancelledTax;

      await client.query(
        `UPDATE booking_items SET status = 'CANCELLED_BY_CUSTOMER'
          WHERE booking_id = $1 AND id = ANY($2::uuid[])`,
        [opts.bookingId, opts.cancelItemIds],
      );
      const remaining = await client.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(unit_price_paise),0)::int AS total
           FROM booking_items WHERE booking_id = $1 AND status NOT IN ('CANCELLED_BY_CUSTOMER','CANCELLED_BY_SALON')`,
        [opts.bookingId],
      );
      if (remaining.rows[0].n === 0) {
        await client.query(`UPDATE bookings SET status = 'CANCELLED_BY_CUSTOMER', cancellation_reason = $2 WHERE id = $1`, [
          opts.bookingId,
          opts.reason ?? null,
        ]);
      } else {
        const remainingSubtotal = Number(remaining.rows[0].total);
        const remainingTax = Math.round(remainingSubtotal * 0.18);
        const remainingTotal = remainingSubtotal + remainingTax;
        await client.query(
          `UPDATE bookings SET subtotal_paise = $2, tax_paise = $3, total_payable_paise = $4 WHERE id = $1`,
          [opts.bookingId, remainingSubtotal, remainingTax, remainingTotal],
        );
      }
    } else {
      await client.query(`UPDATE booking_items SET status = 'CANCELLED_BY_CUSTOMER' WHERE booking_id = $1`, [opts.bookingId]);
      await client.query(
        `UPDATE bookings SET status = 'CANCELLED_BY_CUSTOMER', cancellation_reason = $2 WHERE id = $1`,
        [opts.bookingId, opts.reason ?? null],
      );
    }

    const cancellationFeePaise = Math.round(targetAmountPaise * feeRate);
    const refundDuePaise = targetAmountPaise - cancellationFeePaise;

    // Check for paid online orders and auto-refund
    let refundedPaise = 0;
    const paidOrder = (
      await client.query<{ id: string; amount_paise: number }>(
        `SELECT id, amount_paise FROM payment_orders WHERE booking_id = $1 AND status = 'PAID' ORDER BY created_at DESC LIMIT 1`,
        [opts.bookingId],
      )
    ).rows[0];

    if (paidOrder && refundDuePaise > 0) {
      const refundAmount = Math.min(refundDuePaise, Number(paidOrder.amount_paise));
      try {
        const { refundPayment } = await import('./payments.js');
        await refundPayment({
          salonId: booking.salon_id,
          paymentId: paidOrder.id,
          amountPaise: refundAmount,
          reason: opts.reason ?? (feeRate > 0 ? 'Late cancellation partial refund' : 'Booking cancellation full refund'),
          actorId: opts.auth.id,
        });
        refundedPaise = refundAmount;
      } catch {
        // Payment provider may not be configured in mock/offline mode, still record refund due
      }
    }

    await client.query(
      `INSERT INTO booking_audit_logs
         (booking_id, actor_user_id, actor_role, previous_status, new_status, change_reason, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        opts.bookingId,
        opts.auth.id,
        opts.auth.role,
        booking.status,
        partial ? booking.status : 'CANCELLED_BY_CUSTOMER',
        opts.reason ?? 'cancelled',
        JSON.stringify({
          partial,
          cancelled_item_ids: opts.cancelItemIds ?? [],
          cancellation_fee_paise: cancellationFeePaise,
          refund_due_paise: refundDuePaise,
          refunded_paise: refundedPaise,
          hours_prior: Math.max(0, Number(diffHours.toFixed(2))),
        }),
      ],
    );

    return {
      status: partial ? booking.status : 'CANCELLED_BY_CUSTOMER',
      cancellation_fee_paise: cancellationFeePaise,
      refund_due_paise: refundDuePaise,
      refunded_paise: refundedPaise,
      cancelled_item_ids: opts.cancelItemIds ?? [],
    };
  });

  if (!partial) {
    const notice = await bookingNoticeContext(booking, await firstServiceName(opts.bookingId));
    queueTransactional({
      template: 'BOOKING_CANCELLED',
      userId: booking.customer_id,
      salonId: booking.salon_id,
      context: { ...notice, reason: opts.reason },
      data: { booking_id: opts.bookingId },
    });
  }
  return result;
}

const TRANSITIONS: Record<string, string[]> = {
  REQUESTED: ['CONFIRMED', 'DECLINED', 'CANCELLED_BY_SALON', 'EXPIRED'],
  CONFIRMED: ['ARRIVED', 'NO_SHOW', 'CANCELLED_BY_SALON'],
  ARRIVED: ['IN_SERVICE', 'NO_SHOW'],
  IN_SERVICE: ['COMPLETED'],
};

export async function updateBookingStatus(opts: {
  bookingId: string;
  auth: { id: string; role: string };
  status: string;
  checkinPin?: string;
}) {
  const booking = await getBookingForActor(opts.bookingId, opts.auth);
  const allowed = TRANSITIONS[booking.status] ?? [];
  if (!allowed.includes(opts.status)) {
    throw badRequest('INVALID_TRANSITION', `Cannot move ${booking.status} -> ${opts.status}`);
  }
  if (opts.status === 'ARRIVED') {
    if (!opts.checkinPin || opts.checkinPin !== booking.checkin_pin) {
      throw badRequest('INVALID_CHECKIN_PIN', 'A valid 4-digit check-in PIN is required for arrival check-in');
    }
  }

  const updated = await tx(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_salon_id', booking.salon_id]);
    await client.query(`UPDATE bookings SET status = $2 WHERE id = $1`, [opts.bookingId, opts.status]);
    if (['ARRIVED', 'IN_SERVICE', 'COMPLETED', 'NO_SHOW'].includes(opts.status)) {
      await client.query(`UPDATE booking_items SET status = $2 WHERE booking_id = $1`, [opts.bookingId, opts.status]);
    }
    await client.query(
      `INSERT INTO booking_audit_logs
         (booking_id, actor_user_id, actor_role, previous_status, new_status, change_reason)
       VALUES ($1,$2,$3,$4,$5,'status_update')`,
      [opts.bookingId, opts.auth.id, opts.auth.role, booking.status, opts.status],
    );
    const res = await client.query(`SELECT * FROM bookings WHERE id = $1`, [opts.bookingId]);
    return res.rows[0] ?? null;
  });

  const template =
    opts.status === 'CONFIRMED'
      ? 'BOOKING_CONFIRMED'
      : opts.status === 'COMPLETED'
        ? 'BOOKING_COMPLETED'
        : opts.status === 'CANCELLED_BY_SALON'
          ? 'BOOKING_CANCELLED'
          : null;
  if (template && updated) {
    const notice = await bookingNoticeContext(updated, await firstServiceName(opts.bookingId));
    queueTransactional({
      template,
      userId: updated.customer_id,
      salonId: updated.salon_id,
      context: notice,
      data: { booking_id: opts.bookingId },
    });
  }
  return updated;
}

export function extractComplaintTags(
  reviewText?: string | null,
  ratings?: { overall?: number; hygiene?: number },
): string[] {
  const tags = new Set<string>();
  const text = (reviewText ?? '').toLowerCase();

  // 1. Cleanliness & Hygiene (negative keywords or low hygiene rating <= 2)
  if (
    (ratings?.hygiene !== undefined && ratings.hygiene <= 2) ||
    /\b(dirty|unhygienic|smell(y|ed)?|stink(ing)?|filthy|stains?|dusty|gross|unclean|hair on chair|insects?)\b/i.test(text) ||
    /\b(bad|poor|terrible|lack of)\s+(hygiene|cleanliness)\b/i.test(text) ||
    /\bnot\s+clean\b/i.test(text)
  ) {
    tags.add('CLEANLINESS');
  }

  // 2. Wait time & Queue delay (skip if negated: e.g. "no wait", "zero waiting")
  const hasNegatedWait = /\b(no|zero|without|never|didn't|did not)\s+(wait|waiting|delay|delays)\b/i.test(text);
  if (
    !hasNegatedWait &&
    (/\b(waited|too slow|delayed?|running late|huge queue|queue delay|took too long|took forever)\b/i.test(text) ||
      /\b(long|excessive)\s+wait(ing)?\b/i.test(text) ||
      /\bwait(ed|ing)?\s+(\d+|too|past)\b/i.test(text))
  ) {
    tags.add('WAIT_TIME');
  }

  // 3. Pricing & Billing issues
  if (
    /\b(expensive|overpriced|overcharged?|charged extra|cheat(ed)?|hidden fees?|rip off|ripoff|loot)\b/i.test(text) ||
    /\b(high|unfair)\s+pric(e|ing)\b/i.test(text)
  ) {
    tags.add('PRICING');
  }

  // 4. Staff behaviour & Attitude
  if (
    /\b(rude|arrogant|attitude|unprofessional|disrespectful|misbehaved|harsh|screamed|shouted|careless)\b/i.test(text) ||
    /\bbad\s+behavio(u)?r\b/i.test(text)
  ) {
    tags.add('STAFF_BEHAVIOUR');
  }

  // 5. Service quality & Skill issues (keyword matches or low overall rating <= 2)
  if (
    (ratings?.overall !== undefined && ratings.overall <= 2) ||
    /\b(bad cut|ruined|uneven|worst|terrible|awful|horrible|pain|hurt|bleeding|burn|damaged|amateur)\b/i.test(text) ||
    /\bpoor\s+service\b/i.test(text)
  ) {
    tags.add('SERVICE_QUALITY');
  }

  return Array.from(tags);
}

export async function createReview(opts: {
  bookingId: string;
  customerId: string;
  overallRating: number;
  hygieneRating: number;
  reviewText?: string;
}) {
  const booking = await one(`SELECT * FROM bookings WHERE id = $1`, [opts.bookingId]);
  if (!booking) throw notFound('Booking not found');
  if (booking.customer_id !== opts.customerId) throw forbidden('You can only review your own visit');
  if (booking.status !== 'COMPLETED') throw badRequest('BOOKING_NOT_COMPLETED', 'Reviews are only allowed after a completed visit');

  const existing = await one(`SELECT id FROM reviews WHERE booking_id = $1`, [opts.bookingId]);
  if (existing) throw conflict('REVIEW_EXISTS', 'This visit has already been reviewed');

  const staff = await one<{ staff_id: string }>(
    `SELECT staff_id FROM booking_items WHERE booking_id = $1 LIMIT 1`,
    [opts.bookingId],
  );
  const alert = opts.overallRating <= 2;
  const tags = extractComplaintTags(opts.reviewText, {
    overall: opts.overallRating,
    hygiene: opts.hygieneRating,
  });

  const review = await one(
    `INSERT INTO reviews
       (booking_id, salon_id, customer_id, staff_id, overall_rating, hygiene_rating,
        review_text, ai_complaint_tags, resolution_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      opts.bookingId,
      booking.salon_id,
      opts.customerId,
      staff?.staff_id ?? null,
      opts.overallRating,
      opts.hygieneRating,
      opts.reviewText ?? null,
      tags,
      alert ? 'OPEN_ALERT' : 'NONE',
    ],
  );

  await query(
    `UPDATE salons s
        SET avg_rating = sub.avg_rating, review_count = sub.cnt
       FROM (SELECT ROUND(AVG(overall_rating)::numeric, 2) AS avg_rating, COUNT(*)::int AS cnt
               FROM reviews WHERE salon_id = $1 AND is_published = TRUE) sub
      WHERE s.id = $1`,
    [booking.salon_id],
  );
  if (staff?.staff_id) {
    await query(
      `UPDATE staff_members s
          SET avg_rating = sub.avg_rating, review_count = sub.cnt
         FROM (SELECT ROUND(AVG(overall_rating)::numeric, 2) AS avg_rating, COUNT(*)::int AS cnt
                 FROM reviews WHERE staff_id = $1 AND is_published = TRUE) sub
        WHERE s.id = $1`,
      [staff.staff_id],
    );
  }

  return review;
}

export async function expireStaleBookings(): Promise<number> {
  try {
    const expired = await tx(async (client) => {
      const rows = await client.query<{ id: string; customer_id: string }>(
        `UPDATE bookings
            SET status = 'EXPIRED'
          WHERE status = 'REQUESTED'
            AND approval_expires_at IS NOT NULL
            AND approval_expires_at < NOW()
          RETURNING id, customer_id`,
      );
      if (!rows.rows.length) return 0;
      const ids = rows.rows.map((r) => r.id);
      await client.query(
        `UPDATE booking_items
            SET status = 'EXPIRED'
          WHERE booking_id = ANY($1::uuid[])`,
        [ids],
      );
      for (const row of rows.rows) {
        await client.query(
          `INSERT INTO booking_audit_logs
             (booking_id, actor_user_id, actor_role, previous_status, new_status, change_reason, metadata_json)
           VALUES ($1, $2, 'PLATFORM_ADMIN', 'REQUESTED', 'EXPIRED', 'approval_timeout', '{"automated": true}'::jsonb)`,
          [row.id, row.customer_id],
        );
      }
      return rows.rows.length;
    });
    return expired;
  } catch (err: any) {
    console.error('[expireStaleBookings] error:', err?.message);
    return 0;
  }
}
