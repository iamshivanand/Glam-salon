import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db.js';
import { parse, badRequest, notFound, forbidden } from '../http.js';
import { authenticate } from '../auth.js';
import {
  cancelBooking,
  createBooking,
  createReview,
  getBookingForActor,
  holdBooking,
  rescheduleBooking,
  updateBookingStatus,
} from '../services/booking.js';

const HoldInput = z.object({
  salon_id: z.string().uuid(),
  service_ids: z.array(z.string().uuid()).min(1).max(10),
  staff_id: z.string().uuid().optional(),
  start_at: z.string().datetime({ offset: true }),
});

const CreateInput = z.object({
  hold_token: z.string().min(4),
  payment_mode: z.enum(['PAY_AT_SALON', 'PAY_ONLINE', 'WALLET']).optional(),
  customer_notes: z.string().max(1000).optional(),
  channel: z.enum(['CUSTOMER_APP', 'PARTNER_POS', 'WALKIN_CONVERTED', 'URGENT_SLOT']).optional(),
});

const RescheduleInput = z.object({
  new_start_at: z.string().datetime({ offset: true }),
  staff_id: z.string().uuid().optional(),
});

const CancelInput = z.object({
  reason: z.string().max(255).optional(),
  cancel_item_ids: z.array(z.string().uuid()).optional(),
});

const StatusInput = z.object({
  status: z.enum(['CONFIRMED', 'DECLINED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED', 'NO_SHOW', 'CANCELLED_BY_SALON', 'EXPIRED']),
  checkin_pin: z.string().regex(/^\d{4}$/).optional(),
});

const ReviewInput = z.object({
  overall_rating: z.number().int().min(1).max(5),
  hygiene_rating: z.number().int().min(1).max(5),
  review_text: z.string().max(2000).optional(),
});

function idempotencyKey(req: any): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 64) {
    throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key header (8-64 chars)');
  }
  return key;
}

async function bookingDetail(bookingId: string) {
  const booking = await one(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
  if (!booking) throw notFound('Booking not found');
  const items = await query(
    `SELECT bi.*, sm.display_name AS staff_name
       FROM booking_items bi
       LEFT JOIN staff_members sm ON sm.id = bi.staff_id
      WHERE bi.booking_id = $1 ORDER BY bi.time_range`,
    [bookingId],
  );
  const salon = await one(`SELECT id, name, slug, address_line, locality, city, geo_point FROM salons WHERE id = $1`, [
    booking.salon_id,
  ]);
  const review = await one(`SELECT * FROM reviews WHERE booking_id = $1`, [bookingId]);
  return { ...booking, items, salon, review: review ?? null };
}

export const bookingRoutes: FastifyPluginAsync = async (app) => {
  app.post('/bookings/hold', { preHandler: [authenticate] }, async (req) => {
    const body = parse(HoldInput, req.body);
    const hold = await holdBooking({
      salonId: body.salon_id,
      customerId: req.auth!.id,
      serviceIds: body.service_ids,
      staffId: body.staff_id,
      startAt: body.start_at,
    });
    return {
      hold_token: hold.hold_token,
      expires_in: 300,
      salon_id: hold.salon_id,
      staff_id: hold.staff_id,
      start_at: hold.start_at,
      end_at: hold.end_at,
      pricing: hold.pricing,
      services: hold.services,
    };
  });

  app.post('/bookings', { preHandler: [authenticate] }, async (req) => {
    const body = parse(CreateInput, req.body);
    return createBooking({
      customerId: req.auth!.id,
      holdToken: body.hold_token,
      paymentMode: body.payment_mode,
      customerNotes: body.customer_notes,
      channel: body.channel,
      idempotencyKey: idempotencyKey(req),
    });
  });

  app.get('/bookings', { preHandler: [authenticate] }, async (req) => {
    const q = req.query as Record<string, string>;
    const rows = await query(
      `SELECT b.*, s.name AS salon_name, s.locality, s.city
         FROM bookings b
         JOIN salons s ON s.id = b.salon_id
        WHERE b.customer_id = $1
          AND ($2::text IS NULL OR b.status::text = $2)
        ORDER BY b.scheduled_start_at DESC
        LIMIT 100`,
      [req.auth!.id, q.status ?? null],
    );
    return { bookings: rows };
  });

  app.get('/bookings/:id', { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    await getBookingForActor(id, req.auth!);
    return bookingDetail(id);
  });

  app.post('/bookings/:id/reschedule', { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(RescheduleInput, req.body);
    return rescheduleBooking({
      bookingId: id,
      auth: req.auth!,
      newStartAt: body.new_start_at,
      staffId: body.staff_id,
    });
  });

  app.post('/bookings/:id/cancel', { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(CancelInput, req.body ?? {});
    return cancelBooking({
      bookingId: id,
      auth: req.auth!,
      reason: body.reason,
      cancelItemIds: body.cancel_item_ids,
    });
  });

  app.patch('/bookings/:id/status', { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(StatusInput, req.body);
    return updateBookingStatus({
      bookingId: id,
      auth: req.auth!,
      status: body.status,
      checkinPin: body.checkin_pin,
    });
  });

  app.post('/bookings/:id/reviews', { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(ReviewInput, req.body);
    return createReview({
      bookingId: id,
      customerId: req.auth!.id,
      overallRating: body.overall_rating,
      hygieneRating: body.hygiene_rating,
      reviewText: body.review_text,
    });
  });

  app.get('/bookings/:id/checkin-code', { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const booking = await getBookingForActor(id, req.auth!);
    if (booking.customer_id !== req.auth!.id) throw forbidden('Only the booking customer can view the check-in code');
    return { checkin_pin: booking.checkin_pin, booking_code: booking.booking_code };
  });
};
