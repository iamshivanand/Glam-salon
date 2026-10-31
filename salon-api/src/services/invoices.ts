import { one, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../http.js';
import { randomToken } from '../crypto.js';
import { scheduleReminders } from './reminders.js';

const GST_RATE = 0.18;
const POINT_VALUE_PAISE = 100; // 1 loyalty point = ₹1
const POINTS_PER_RUPEE = 1 / 100; // earn 1 point per ₹100

export interface InvoiceInput {
  salonId: string;
  actor: { id: string; role: string };
  bookingId?: string;
  walkinTokenId?: string;
  discountPaise?: number;
  redeemLoyaltyPoints?: number;
  method: string;
  idempotencyKey: string;
}

export async function createInvoice(input: InvoiceInput) {
  const existing = await one(`SELECT * FROM invoices_and_payments WHERE idempotency_key = $1`, [input.idempotencyKey]);
  if (existing) return existing;

  try {
    return await tx(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.current_salon_id', input.salonId]);

      let customerId: string;
      let gross = 0;
      let serviceCategoryId: string | null = null;
      const bookingId = input.bookingId ?? null;
      const walkinTokenId = input.walkinTokenId ?? null;
      let booking: any = null;

      if (bookingId) {
        booking = (await client.query(`SELECT * FROM bookings WHERE id = $1 AND salon_id = $2`, [bookingId, input.salonId]))
          .rows[0];
        if (!booking) throw notFound('Booking not found');
        if (booking.status === 'COMPLETED') throw conflict('ALREADY_INVOICED', 'This booking is already completed');
        customerId = booking.customer_id;

        const items = await client.query(
          `SELECT b.*, s.category_id
             FROM booking_items b
             JOIN salon_services s ON s.id = b.salon_service_id
            WHERE b.booking_id = $1
              AND b.status NOT IN ('CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SALON')`,
          [bookingId],
        );
        gross = items.rows.reduce((sum: number, r: any) => sum + Number(r.unit_price_paise), 0);
        serviceCategoryId = items.rows[0]?.category_id ?? null;

        await client.query(`UPDATE bookings SET status = 'COMPLETED' WHERE id = $1`, [bookingId]);
        await client.query(`UPDATE booking_items SET status = 'COMPLETED' WHERE booking_id = $1`, [bookingId]);
      } else if (walkinTokenId) {
        const token = (
          await client.query(`SELECT * FROM walkin_queue_tokens WHERE id = $1 AND salon_id = $2`, [walkinTokenId, input.salonId])
        ).rows[0];
        if (!token) throw notFound('Queue token not found');
        if (!token.customer_id) throw badRequest('CUSTOMER_REQUIRED', 'Link the walk-in to a customer before invoicing');
        customerId = token.customer_id;

        const prices = await client.query(
          `SELECT COALESCE(discounted_price_paise, base_price_paise)::int AS price, category_id
             FROM salon_services WHERE id = ANY($1::uuid[])`,
          [token.selected_service_ids],
        );
        gross = prices.rows.reduce((sum: number, r: any) => sum + Number(r.price), 0);
        serviceCategoryId = prices.rows[0]?.category_id ?? null;

        await client.query(
          `UPDATE walkin_queue_tokens SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`,
          [walkinTokenId],
        );
      } else {
        throw badRequest('VALIDATION_ERROR', 'booking_id or walkin_token_id is required');
      }

      const discount = Math.max(0, input.discountPaise ?? 0);
      if (discount > gross) throw badRequest('INVALID_DISCOUNT', 'Discount cannot exceed the gross amount');

      const crm = (
        await client.query(`SELECT * FROM salon_customer_crm WHERE salon_id = $1 AND customer_id = $2`, [
          input.salonId,
          customerId,
        ])
      ).rows[0];

      const availablePoints = crm?.loyalty_points_balance ?? 0;
      const requestedPoints = Math.max(0, input.redeemLoyaltyPoints ?? 0);
      const maxRedeemable = Math.floor((gross - discount) / POINT_VALUE_PAISE);
      const redeemPoints = Math.min(requestedPoints, availablePoints, maxRedeemable);
      const loyaltyRedeemed = redeemPoints * POINT_VALUE_PAISE;

      const taxable = Math.max(0, gross - discount - loyaltyRedeemed);
      const tax = Math.round(taxable * GST_RATE);
      const net = taxable + tax;

      const config = (
        await client.query(`SELECT * FROM salon_commission_configs WHERE salon_id = $1`, [input.salonId])
      ).rows[0];
      const isRepeat = (crm?.total_visits ?? 0) >= 1;
      const bps = isRepeat ? (config?.repeat_crm_client_bps ?? 0) : (config?.marketplace_new_client_bps ?? 1500);
      const commission = Math.round((net * bps) / 10000);
      const partnerSettlement = net - commission;

      const invoiceNumber = `INV-${input.salonId.slice(0, 4).toUpperCase()}-${new Date().getUTCFullYear()}-${randomToken(3).toUpperCase()}`;
      const invoice = (
        await client.query(
          `INSERT INTO invoices_and_payments
             (invoice_number, idempotency_key, salon_id, customer_id, booking_id, walkin_token_id,
              gross_amount_paise, discount_paise, loyalty_redeemed_paise, wallet_redeemed_paise,
              tax_paise, net_collected_paise, platform_commission_paise, partner_net_settlement_paise,
              method, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14,'CAPTURED')
           RETURNING *`,
          [
            invoiceNumber,
            input.idempotencyKey,
            input.salonId,
            customerId,
            bookingId,
            walkinTokenId,
            gross,
            discount,
            loyaltyRedeemed,
            tax,
            net,
            commission,
            partnerSettlement,
            input.method,
          ],
        )
      ).rows[0];

      const intervalDays =
        (
          await client.query(
            `SELECT COALESCE(s.reminder_interval_days, c.default_reminder_interval_days, 25)::int AS days
               FROM salon_services s
               JOIN service_categories c ON c.id = s.category_id
              WHERE s.salon_id = $1 AND s.id = (
                SELECT salon_service_id FROM booking_items WHERE booking_id = $2 LIMIT 1
              )
              LIMIT 1`,
            [input.salonId, bookingId],
          )
        ).rows[0]?.days ?? 25;

      const earnedPoints = Math.floor(net * POINTS_PER_RUPEE / 100) || Math.floor(net / 10000);
      const nextExpected = new Date(Date.now() + intervalDays * 86_400_000).toISOString().slice(0, 10);

      await client.query(
        `INSERT INTO salon_customer_crm
           (salon_id, customer_id, custom_customer_code, first_visit_at, last_visit_at,
            next_expected_visit_date, total_visits, total_spend_paise, avg_bill_paise,
            computed_visit_interval_days, retention_segment, loyalty_points_balance)
         VALUES ($1,$2,$3,NOW(),NOW(),$4,1,$5::bigint,$5::int,$6,'NEW'::retention_segment_type,$7)
         ON CONFLICT (salon_id, customer_id) DO UPDATE SET
           last_visit_at = NOW(),
           next_expected_visit_date = $4,
           total_visits = salon_customer_crm.total_visits + 1,
           total_spend_paise = salon_customer_crm.total_spend_paise + $5::bigint,
           avg_bill_paise = ((salon_customer_crm.total_spend_paise + $5::bigint) / (salon_customer_crm.total_visits + 1))::int,
           computed_visit_interval_days = $6,
           retention_segment = CASE
             WHEN salon_customer_crm.total_visits + 1 >= 3 THEN 'REGULAR'::retention_segment_type
             ELSE 'NEW'::retention_segment_type END,
           loyalty_points_balance = salon_customer_crm.loyalty_points_balance - $8 + $7`,
        [
          input.salonId,
          customerId,
          `CUST-${customerId.slice(0, 6).toUpperCase()}`,
          nextExpected,
          net,
          intervalDays,
          earnedPoints,
          redeemPoints,
        ],
      );

      if (redeemPoints > 0) {
        await client.query(
          `INSERT INTO customer_value_ledger
             (idempotency_key, salon_id, customer_id, invoice_id, bucket, entry_type,
              amount_delta, balance_after, notes)
           VALUES ($1,$2,$3,$4,'LOYALTY_POINTS','REDEEM_CHECKOUT',$5,$6,'checkout redemption')`,
          [
            `${input.idempotencyKey}:redeem`,
            input.salonId,
            customerId,
            invoice.id,
            -redeemPoints,
            availablePoints - redeemPoints,
          ],
        );
      }
      if (earnedPoints > 0) {
        await client.query(
          `INSERT INTO customer_value_ledger
             (idempotency_key, salon_id, customer_id, invoice_id, bucket, entry_type,
              amount_delta, balance_after, notes)
           VALUES ($1,$2,$3,$4,'LOYALTY_POINTS','EARN_VISIT',$5,$6,'visit earned')`,
          [
            `${input.idempotencyKey}:earn`,
            input.salonId,
            customerId,
            invoice.id,
            earnedPoints,
            availablePoints - redeemPoints + earnedPoints,
          ],
        );
      }

      if (serviceCategoryId) {
        await scheduleReminders(client, {
          salonId: input.salonId,
          customerId,
          bookingId,
          serviceCategoryId,
          completedAt: new Date(),
          intervalDays,
        });
      }

      if (bookingId && booking) {
        await client.query(
          `INSERT INTO booking_audit_logs
             (booking_id, actor_user_id, actor_role, previous_status, new_status, change_reason, metadata_json)
           VALUES ($1,$2,$3,$4,'COMPLETED','invoice_created',$5)`,
          [
            bookingId,
            input.actor.id,
            input.actor.role,
            booking.status,
            JSON.stringify({ invoice_id: invoice.id, net_collected_paise: net }),
          ],
        );
      }

      return { ...invoice, earned_points: earnedPoints, redeemed_points: redeemPoints };
    });
  } catch (err: any) {
    if (err?.code === '23505' && String(err.constraint ?? '').includes('idempotency')) {
      const again = await one(`SELECT * FROM invoices_and_payments WHERE idempotency_key = $1`, [input.idempotencyKey]);
      if (again) return again;
    }
    throw err;
  }
}
