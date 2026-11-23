import { one, query, withIntegration, withTenant } from '../db.js';
import { env } from '../env.js';
import { badRequest, conflict, notFound } from '../http.js';
import { incrementMetric } from '../metrics.js';
import { uuid } from '../crypto.js';
import { recordAudit } from './audit.js';
import { verifyRazorpayPaymentSignature, verifyRazorpayWebhook } from './signatures.js';

export interface PaymentOrder {
  id: string;
  salon_id: string;
  booking_id: string | null;
  invoice_id: string | null;
  customer_id: string;
  provider: string;
  provider_order_id: string | null;
  provider_payment_id: string | null;
  amount_paise: number;
  currency: string;
  status: string;
  idempotency_key: string | null;
  created_at: string;
  paid_at: string | null;
  refunded_at: string | null;
}

function providerName(): string {
  return env.PAYMENT_PROVIDER;
}

function razorpayConfigured(): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

async function razorpayRequest<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  if (!razorpayConfigured()) {
    throw conflict('PAYMENT_NOT_CONFIGURED', 'Razorpay credentials are not configured');
  }
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  let res: Response;
  try {
    res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw conflict('PAYMENT_PROVIDER_UNREACHABLE', `Razorpay request failed: ${String(err)}`);
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw conflict(
      'PAYMENT_PROVIDER_ERROR',
      json?.error?.description ?? `Razorpay responded ${res.status}`,
      json?.error,
    );
  }
  return json as T;
}

export function paymentCapabilities(): {
  provider: string;
  online: boolean;
  manual: boolean;
  configured: boolean;
} {
  const provider = providerName();
  return {
    provider,
    online: provider === 'razorpay',
    manual: provider === 'manual',
    configured: provider === 'razorpay' ? razorpayConfigured() : provider === 'manual',
  };
}

export async function createPaymentIntent(opts: {
  salonId?: string;
  customerId: string;
  bookingId?: string;
  invoiceId?: string;
  amountPaise?: number;
  idempotencyKey: string;
}): Promise<Record<string, unknown>> {
  const provider = providerName();
  if (provider === 'none') {
    throw conflict('PAYMENTS_DISABLED', 'Online payments are not enabled');
  }

  let amount = opts.amountPaise ?? 0;
  let bookingId = opts.bookingId ?? null;
  let invoiceId = opts.invoiceId ?? null;
  let salonId = opts.salonId ?? '';

  if (bookingId) {
    const booking = await one(
      `SELECT id, salon_id, customer_id, total_payable_paise, status
         FROM bookings WHERE id = $1`,
      [bookingId],
    );
    if (!booking) throw notFound('Booking not found');
    if (opts.salonId && booking.salon_id !== opts.salonId) {
      throw badRequest('SALON_MISMATCH', 'Booking belongs to another salon');
    }
    if (booking.customer_id !== opts.customerId) throw badRequest('CUSTOMER_MISMATCH', 'Booking belongs to another customer');
    salonId = booking.salon_id;
    amount = amount || Number(booking.total_payable_paise);
  } else if (invoiceId) {
    const invoice = await one(
      `SELECT id, salon_id, customer_id, net_collected_paise FROM invoices_and_payments WHERE id = $1`,
      [invoiceId],
    );
    if (!invoice) throw notFound('Invoice not found');
    if (opts.salonId && invoice.salon_id !== opts.salonId) {
      throw badRequest('SALON_MISMATCH', 'Invoice belongs to another salon');
    }
    if (invoice.customer_id !== opts.customerId) throw badRequest('CUSTOMER_MISMATCH', 'Invoice belongs to another customer');
    salonId = invoice.salon_id;
    amount = amount || Number(invoice.net_collected_paise);
  } else {
    throw badRequest('VALIDATION_ERROR', 'booking_id or invoice_id is required');
  }

  if (amount <= 0) throw badRequest('INVALID_AMOUNT', 'Payment amount must be greater than zero');

  // Payment tables are FORCE RLS, so even a customer-scoped lookup needs the
  // trusted-integration GUC. Without it, a retried intent looks new and the
  // unique idempotency index turns the retry into a 409.
  const existing = await withIntegration(async (client) => {
    const res = await client.query<PaymentOrder>(
      `SELECT * FROM payment_orders WHERE customer_id = $1 AND idempotency_key = $2`,
      [opts.customerId, opts.idempotencyKey],
    );
    return res.rows[0] ?? null;
  });
  if (existing) return intentResponse(existing);

  if (provider === 'manual') {
    const order = await withTenant(salonId, async (client) => {
      const res = await client.query<PaymentOrder>(
        `INSERT INTO payment_orders
           (salon_id, booking_id, invoice_id, customer_id, provider, amount_paise, status, idempotency_key, raw_response)
         VALUES ($1,$2,$3,$4,'manual',$5,'PENDING',$6,'{"mode":"pay_at_salon"}')
         RETURNING *`,
        [salonId, bookingId, invoiceId, opts.customerId, amount, opts.idempotencyKey],
      );
      return res.rows[0];
    });
    incrementMetric('glamconnect_payment_intents_total');
    return intentResponse(order);
  }

  if (!razorpayConfigured()) {
    throw conflict('PAYMENT_NOT_CONFIGURED', 'Razorpay credentials are not configured');
  }

  const receipt = `gc-${opts.idempotencyKey}`.slice(0, 40);
  const order = await razorpayRequest<{ id: string; amount: number; currency: string; status: string }>('/orders', 'POST', {
    amount,
    currency: 'INR',
    receipt,
    notes: {
      salon_id: opts.salonId,
      customer_id: opts.customerId,
      booking_id: bookingId ?? '',
      invoice_id: invoiceId ?? '',
    },
  });

  const stored = await withTenant(salonId, async (client) => {
    const res = await client.query<PaymentOrder>(
      `INSERT INTO payment_orders
         (salon_id, booking_id, invoice_id, customer_id, provider, provider_order_id,
          amount_paise, currency, status, idempotency_key, raw_response)
       VALUES ($1,$2,$3,$4,'razorpay',$5,$6,$7,$8,$9,$10::jsonb)
       RETURNING *`,
      [
        salonId,
        bookingId,
        invoiceId,
        opts.customerId,
        order.id,
        amount,
        order.currency ?? 'INR',
        order.status?.toUpperCase() ?? 'CREATED',
        opts.idempotencyKey,
        JSON.stringify(order),
      ],
    );
    return res.rows[0];
  });

  incrementMetric('glamconnect_payment_intents_total');
  return {
    ...intentResponse(stored),
    key_id: env.RAZORPAY_KEY_ID,
    order_id: order.id,
    checkout: {
      provider: 'razorpay',
      key: env.RAZORPAY_KEY_ID,
      order_id: order.id,
      amount,
      currency: order.currency ?? 'INR',
    },
  };
}

function intentResponse(order: PaymentOrder): Record<string, unknown> {
  // Retried intents (same Idempotency-Key) must be able to reopen checkout for
  // an order that is still open; paid/refunded orders return status only.
  const checkoutOpen =
    order.provider === 'razorpay' &&
    !!order.provider_order_id &&
    ['CREATED', 'PENDING', 'AUTHORIZED'].includes(order.status);
  return {
    payment_id: order.id,
    provider: order.provider,
    status: order.status,
    amount_paise: Number(order.amount_paise),
    currency: order.currency,
    booking_id: order.booking_id,
    invoice_id: order.invoice_id,
    key_id: order.provider === 'razorpay' ? env.RAZORPAY_KEY_ID : undefined,
    order_id: order.provider_order_id ?? undefined,
    checkout:
      checkoutOpen && order.provider_order_id
        ? {
            provider: 'razorpay',
            key: env.RAZORPAY_KEY_ID,
            order_id: order.provider_order_id,
            amount: Number(order.amount_paise),
            currency: order.currency,
          }
        : undefined,
    instructions:
      order.provider === 'manual'
        ? 'Pay at the salon. This records your intent but does not capture money online.'
        : undefined,
  };
}

export async function verifyPayment(opts: {
  paymentId: string;
  customerId: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
}): Promise<Record<string, unknown>> {
  // Same RLS rule as the intent lookup: read under the integration GUC, then
  // write under the salon's tenant context.
  const order = await withIntegration(async (client) => {
    const res = await client.query<PaymentOrder>(
      `SELECT * FROM payment_orders WHERE id = $1 AND customer_id = $2`,
      [opts.paymentId, opts.customerId],
    );
    return res.rows[0] ?? null;
  });
  if (!order) throw notFound('Payment not found');
  if (order.status === 'PAID') return { ...intentResponse(order), already_paid: true };

  if (order.provider === 'manual') {
    throw badRequest('MANUAL_PAYMENT', 'This payment is collected at the salon and cannot be verified online');
  }

  if (!opts.razorpayOrderId || !opts.razorpayPaymentId || !opts.razorpaySignature) {
    throw badRequest('VALIDATION_ERROR', 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required');
  }
  if (opts.razorpayOrderId !== order.provider_order_id) {
    throw badRequest('ORDER_MISMATCH', 'The Razorpay order does not match this payment');
  }
  if (
    !verifyRazorpayPaymentSignature(
      opts.razorpayOrderId,
      opts.razorpayPaymentId,
      opts.razorpaySignature,
      env.RAZORPAY_KEY_SECRET,
    )
  ) {
    throw badRequest('INVALID_SIGNATURE', 'Payment signature verification failed');
  }

  const paid = await markPaid(order, opts.razorpayPaymentId, { source: 'checkout_verify' });
  incrementMetric('glamconnect_payments_captured_total');
  return { ...intentResponse(paid), verified: true };
}

async function markPaid(order: PaymentOrder, providerPaymentId: string, raw: Record<string, unknown>) {
  return withTenant(order.salon_id, async (client) => {
    const res = await client.query<PaymentOrder>(
      `UPDATE payment_orders
          SET status = 'PAID',
              provider_payment_id = $2,
              paid_at = COALESCE(paid_at, NOW()),
              raw_response = raw_response || $3::jsonb
        WHERE id = $1
        RETURNING *`,
      [order.id, providerPaymentId, JSON.stringify(raw)],
    );
    if (order.invoice_id) {
      await client.query(
        `UPDATE invoices_and_payments
            SET gateway_payment_id = COALESCE(gateway_payment_id, $2)
          WHERE id = $1 AND salon_id = $3`,
        [order.invoice_id, providerPaymentId, order.salon_id],
      );
    }
    return res.rows[0];
  });
}

export async function listPaymentsForCustomer(customerId: string): Promise<PaymentOrder[]> {
  return withIntegration(async (client) => {
    const res = await client.query<PaymentOrder>(
      `SELECT * FROM payment_orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [customerId],
    );
    return res.rows;
  });
}

export async function listPaymentsForSalon(salonId: string, limit = 100): Promise<PaymentOrder[]> {
  return withTenant(salonId, async (client) => {
    const res = await client.query<PaymentOrder>(
      `SELECT * FROM payment_orders WHERE salon_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [salonId, Math.min(Math.max(limit, 1), 200)],
    );
    return res.rows;
  });
}

interface RefundRow {
  id: string;
  salon_id: string;
  payment_order_id: string;
  amount_paise: number;
  reason: string | null;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  provider_refund_id: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

/**
 * Refund a captured payment.
 *
 * Money movement and bookkeeping are deliberately split:
 *   1. claim the Idempotency-Key and reserve the amount in `payment_refunds`,
 *   2. call the gateway outside the transaction,
 *   3. finalise the order and the refund row together.
 * A retried request returns the recorded outcome instead of refunding twice.
 */
export async function refundPayment(opts: {
  salonId: string;
  paymentId: string;
  amountPaise?: number;
  reason?: string;
  actorId: string;
  actorRole?: string;
  idempotencyKey?: string;
  ip?: string;
}): Promise<Record<string, unknown>> {
  const key = (opts.idempotencyKey ?? uuid()).slice(0, 64);

  const claim = await withTenant(opts.salonId, async (client) => {
    const orderRes = await client.query<PaymentOrder>(
      `SELECT * FROM payment_orders WHERE id = $1 AND salon_id = $2 FOR UPDATE`,
      [opts.paymentId, opts.salonId],
    );
    const order = orderRes.rows[0];
    if (!order) throw notFound('Payment not found');

    const existingRes = await client.query<RefundRow>(
      `SELECT * FROM payment_refunds WHERE salon_id = $1 AND idempotency_key = $2`,
      [opts.salonId, key],
    );
    const existing = existingRes.rows[0];
    if (existing) return { order, refund: existing, amount: Number(existing.amount_paise), replayed: true };

    if (!['PAID', 'PARTIALLY_REFUNDED'].includes(order.status)) {
      throw conflict('PAYMENT_NOT_REFUNDABLE', `Cannot refund a ${order.status} payment`);
    }

    const refundedRes = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total
         FROM payment_refunds
        WHERE payment_order_id = $1 AND status IN ('PENDING', 'SUCCEEDED')`,
      [order.id],
    );
    const alreadyRefunded = Number(refundedRes.rows[0]?.total ?? 0);
    const remaining = Number(order.amount_paise) - alreadyRefunded;
    if (remaining <= 0) throw conflict('PAYMENT_FULLY_REFUNDED', 'This payment has already been refunded');

    const amount = Math.min(opts.amountPaise ?? remaining, remaining);
    if (amount <= 0) throw badRequest('INVALID_AMOUNT', 'Refund amount must be greater than zero');

    const inserted = await client.query<RefundRow>(
      `INSERT INTO payment_refunds
         (salon_id, payment_order_id, amount_paise, reason, status, idempotency_key, requested_by)
       VALUES ($1,$2,$3,$4,'PENDING',$5,$6)
       RETURNING *`,
      [opts.salonId, order.id, amount, opts.reason ?? null, key, opts.actorId],
    );
    return {
      order,
      refund: inserted.rows[0],
      amount,
      alreadyRefunded,
      replayed: false,
    };
  });

  let refund = claim.refund;

  if (refund.status === 'SUCCEEDED') {
    return {
      payment_id: claim.order.id,
      status: claim.order.status,
      refunded_paise: Number(refund.amount_paise),
      provider_refund_id: refund.provider_refund_id,
      refund_id: refund.id,
      simulated: claim.order.provider === 'manual',
      replayed: true,
    };
  }

  // A replayed key whose refund is still PENDING means the outcome is unknown
  // (the process may have died mid-call). Retrying could move money twice, so
  // ask the operator to reconcile instead.
  if (refund.status === 'PENDING' && claim.replayed) {
    throw conflict('REFUND_IN_PROGRESS', 'A refund with this Idempotency-Key is already in progress');
  }

  if (refund.status === 'FAILED') {
    const retried = await withTenant(opts.salonId, async (client) => {
      const res = await client.query<RefundRow>(
        `UPDATE payment_refunds SET status = 'PENDING', error = NULL, updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [refund.id],
      );
      return res.rows[0];
    });
    refund = retried;
  }

  let providerRefundId: string | null = null;
  try {
    if (claim.order.provider === 'razorpay') {
      if (!claim.order.provider_payment_id) {
        throw conflict('PAYMENT_NOT_REFUNDABLE', 'No Razorpay payment id on file');
      }
      const response = await razorpayRequest<{ id: string; status: string }>(
        `/payments/${claim.order.provider_payment_id}/refund`,
        'POST',
        {
          amount: claim.amount,
          notes: { reason: opts.reason ?? '', actor_id: opts.actorId, refund_id: refund.id },
          speed: 'normal',
        },
      );
      providerRefundId = response.id;
    }
  } catch (err) {
    await withTenant(opts.salonId, async (client) => {
      await client.query(
        `UPDATE payment_refunds SET status = 'FAILED', error = $2, updated_at = NOW() WHERE id = $1`,
        [refund.id, (err instanceof Error ? err.message : String(err)).slice(0, 500)],
      );
    }).catch(() => undefined);
    incrementMetric('glamconnect_payments_refund_failed_total');
    throw err;
  }

  // Decide REFUNDED vs PARTIALLY_REFUNDED from the ledger, not just this call,
  // so a sequence of partial refunds closes the order correctly.
  const updated = await withTenant(opts.salonId, async (client) => {
    await client.query(
      `UPDATE payment_refunds
          SET status = 'SUCCEEDED', provider_refund_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [refund.id, providerRefundId],
    );
    const totalRes = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total
         FROM payment_refunds
        WHERE payment_order_id = $1 AND status = 'SUCCEEDED'`,
      [claim.order.id],
    );
    const totalRefunded = Number(totalRes.rows[0]?.total ?? 0);
    const full = totalRefunded >= Number(claim.order.amount_paise);

    const res = await client.query<PaymentOrder>(
      `UPDATE payment_orders
          SET status = $2,
              refunded_at = NOW(),
              raw_response = raw_response || $3::jsonb
        WHERE id = $1
        RETURNING *`,
      [
        claim.order.id,
        full ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        JSON.stringify({
          refund: {
            refund_id: refund.id,
            amount_paise: claim.amount,
            provider_refund_id: providerRefundId,
            reason: opts.reason ?? null,
          },
        }),
      ],
    );
    if (claim.order.invoice_id) {
      await client.query(
        `UPDATE invoices_and_payments
            SET status = $2
          WHERE id = $1 AND salon_id = $3`,
        [claim.order.invoice_id, full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', claim.order.salon_id],
      );
    }
    return res.rows[0];
  });

  await recordAudit({
    actorId: opts.actorId,
    actorRole: opts.actorRole ?? null,
    salonId: opts.salonId,
    action: 'payment.refunded',
    entityType: 'payment_order',
    entityId: claim.order.id,
    metadata: {
      refund_id: refund.id,
      amount_paise: claim.amount,
      provider_refund_id: providerRefundId,
      simulated: claim.order.provider === 'manual',
    },
    ip: opts.ip,
  });

  incrementMetric('glamconnect_payments_refunded_total');
  return {
    payment_id: updated.id,
    status: updated.status,
    refunded_paise: claim.amount,
    provider_refund_id: providerRefundId,
    refund_id: refund.id,
    simulated: claim.order.provider === 'manual',
    replayed: false,
  };
}

export interface SettlementPayoutRow {
  id: string;
  salon_id: string;
  period_start: string;
  period_end: string;
  amount_paise: number;
  reference: string | null;
  notes: string | null;
  recorded_by: string | null;
  created_at: string;
}

export async function payoutsForSalon(salonId: string, limit = 24): Promise<SettlementPayoutRow[]> {
  return withTenant(salonId, async (client) => {
    const res = await client.query<SettlementPayoutRow>(
      `SELECT * FROM settlement_payouts WHERE salon_id = $1 ORDER BY period_end DESC LIMIT $2`,
      [salonId, Math.min(Math.max(limit, 1), 100)],
    );
    return res.rows;
  });
}

export async function recordPayout(opts: {
  salonId: string;
  periodStart: string;
  periodEnd: string;
  amountPaise: number;
  reference?: string;
  notes?: string;
  recordedBy: string;
  actorRole?: string;
  ip?: string;
}): Promise<SettlementPayoutRow> {
  const row = await withTenant(opts.salonId, async (client) => {
    const res = await client.query<SettlementPayoutRow>(
      `INSERT INTO settlement_payouts
         (salon_id, period_start, period_end, amount_paise, reference, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (salon_id, period_start, period_end) DO UPDATE SET
         amount_paise = EXCLUDED.amount_paise,
         reference = EXCLUDED.reference,
         notes = EXCLUDED.notes,
         recorded_by = EXCLUDED.recorded_by
       RETURNING *`,
      [
        opts.salonId,
        opts.periodStart,
        opts.periodEnd,
        opts.amountPaise,
        opts.reference ?? null,
        opts.notes ?? null,
        opts.recordedBy,
      ],
    );
    return res.rows[0];
  });

  await recordAudit({
    actorId: opts.recordedBy,
    actorRole: opts.actorRole ?? null,
    salonId: opts.salonId,
    action: 'settlement.payout_recorded',
    entityType: 'settlement_payout',
    entityId: row.id,
    metadata: {
      period_start: opts.periodStart,
      period_end: opts.periodEnd,
      amount_paise: opts.amountPaise,
      reference: opts.reference ?? null,
    },
    ip: opts.ip,
  });

  return row;
}

export async function settlementsForSalon(
  salonId: string,
  opts: { from?: string; to?: string } = {},
): Promise<Record<string, unknown>> {
  const rows = await query<{
    settlement_date: string;
    invoices: string;
    gross_paise: string;
    commission_paise: string;
    partner_paise: string;
  }>(
    `SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS settlement_date,
            COUNT(*)::int AS invoices,
            COALESCE(SUM(gross_amount_paise),0)::bigint AS gross_paise,
            COALESCE(SUM(platform_commission_paise),0)::bigint AS commission_paise,
            COALESCE(SUM(partner_net_settlement_paise),0)::bigint AS partner_paise
       FROM invoices_and_payments
      WHERE salon_id = $1
        AND status IN ('CAPTURED','PARTIALLY_REFUNDED')
        AND ($2::date IS NULL OR created_at >= $2::date)
        AND ($3::date IS NULL OR created_at < ($3::date + INTERVAL '1 day'))
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 90`,
    [salonId, opts.from ?? null, opts.to ?? null],
  );

  const totals = rows.reduce(
    (acc, row) => ({
      gross_paise: acc.gross_paise + Number(row.gross_paise),
      commission_paise: acc.commission_paise + Number(row.commission_paise),
      partner_paise: acc.partner_paise + Number(row.partner_paise),
      invoices: acc.invoices + Number(row.invoices),
    }),
    { gross_paise: 0, commission_paise: 0, partner_paise: 0, invoices: 0 },
  );

  return {
    days: rows,
    totals,
    note: 'Settlements are computed from captured invoices. Payout execution depends on the configured payment provider.',
  };
}

export async function applyRazorpayWebhook(rawBody: string, signature: string | undefined): Promise<{
  handled: boolean;
  event?: string;
}> {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !verifyRazorpayWebhook(rawBody, signature, env.RAZORPAY_WEBHOOK_SECRET)) {
    throw badRequest('INVALID_SIGNATURE', 'Invalid Razorpay webhook signature');
  }
  const event = JSON.parse(rawBody) as {
    event?: string;
    payload?: { payment?: { entity?: any }; refund?: { entity?: any } };
  };
  const payment = event.payload?.payment?.entity;
  const refund = event.payload?.refund?.entity;

  // Webhooks have no salon context and every payment table is FORCE RLS, so
  // lookups must run under the trusted-integration GUC. Updates still run
  // inside the owning salon's tenant transaction.
  const orderForWebhook = (column: 'provider_order_id' | 'provider_payment_id', value: string) =>
    withIntegration(async (client) => {
      const res = await client.query<PaymentOrder>(
        `SELECT * FROM payment_orders WHERE provider = 'razorpay' AND ${column} = $1`,
        [value],
      );
      return res.rows[0] ?? null;
    });

  if (event.event === 'payment.captured' && payment?.order_id && payment?.id) {
    const order = await orderForWebhook('provider_order_id', payment.order_id);
    if (order && order.status !== 'PAID') {
      await markPaid(order, payment.id, { source: 'webhook', event: event.event });
      incrementMetric('glamconnect_payments_captured_total');
    }
    return { handled: Boolean(order), event: event.event };
  }

  if ((event.event === 'payment.failed' || event.event === 'payment.authorized') && payment?.order_id) {
    const order = await orderForWebhook('provider_order_id', payment.order_id);
    if (order && event.event === 'payment.failed') {
      await withTenant(order.salon_id, async (client) => {
        await client.query(
          `UPDATE payment_orders
              SET status = 'FAILED', raw_response = raw_response || $2::jsonb
            WHERE id = $1`,
          [order.id, JSON.stringify({ source: 'webhook', event: event.event, payment })],
        );
      });
      incrementMetric('glamconnect_payments_failed_total');
    }
    return { handled: Boolean(order), event: event.event };
  }

  if ((event.event === 'refund.processed' || event.event === 'refund.failed') && refund?.payment_id) {
    const order = await orderForWebhook('provider_payment_id', refund.payment_id);
    if (!order) return { handled: false, event: event.event };

    const succeeded = event.event === 'refund.processed';
    const providerRefundId: string | null = refund.id ?? null;
    const amountPaise = Number(refund.amount ?? 0);

    await withTenant(order.salon_id, async (client) => {
      // Prefer the ledger row our own refund call created (its id travels in the
      // gateway notes), then the provider refund id. Anything else is a refund
      // issued outside the API and gets recorded as an external row.
      let row: RefundRow | undefined;
      const ledgerId: string | undefined = refund.notes?.refund_id;
      if (ledgerId) {
        const res = await client.query<RefundRow>(
          `SELECT * FROM payment_refunds WHERE id = $1 AND salon_id = $2`,
          [ledgerId, order.salon_id],
        );
        row = res.rows[0];
      }
      if (!row && providerRefundId) {
        const res = await client.query<RefundRow>(
          `SELECT * FROM payment_refunds WHERE salon_id = $1 AND provider_refund_id = $2`,
          [order.salon_id, providerRefundId],
        );
        row = res.rows[0];
      }

      if (row) {
        await client.query(
          `UPDATE payment_refunds
              SET status = $2,
                  provider_refund_id = COALESCE($3, provider_refund_id),
                  error = $4,
                  updated_at = NOW()
            WHERE id = $1`,
          [
            row.id,
            succeeded ? 'SUCCEEDED' : 'FAILED',
            providerRefundId,
            succeeded ? null : 'Refund failed at the gateway',
          ],
        );
      } else if (amountPaise > 0) {
        const key = `razorpay:${providerRefundId ?? `${refund.payment_id}:${amountPaise}`}`.slice(0, 64);
        await client.query(
          `INSERT INTO payment_refunds
             (salon_id, payment_order_id, amount_paise, reason, status, provider_refund_id, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (salon_id, idempotency_key) DO UPDATE SET
             status = EXCLUDED.status,
             provider_refund_id = COALESCE(EXCLUDED.provider_refund_id, payment_refunds.provider_refund_id),
             updated_at = NOW()`,
          [
            order.salon_id,
            order.id,
            amountPaise,
            refund.notes?.reason ?? null,
            succeeded ? 'SUCCEEDED' : 'FAILED',
            providerRefundId,
            key,
          ],
        );
      }

      if (!succeeded) return;

      const totalRes = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total
           FROM payment_refunds
          WHERE payment_order_id = $1 AND status = 'SUCCEEDED'`,
        [order.id],
      );
      const totalRefunded = Number(totalRes.rows[0]?.total ?? 0);
      const full = totalRefunded >= Number(order.amount_paise);
      await client.query(
        `UPDATE payment_orders
            SET status = $2,
                refunded_at = NOW(),
                raw_response = raw_response || $3::jsonb
          WHERE id = $1`,
        [order.id, full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', JSON.stringify({ source: 'webhook', refund })],
      );
      if (order.invoice_id) {
        await client.query(
          `UPDATE invoices_and_payments SET status = $2 WHERE id = $1 AND salon_id = $3`,
          [order.invoice_id, full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', order.salon_id],
        );
      }
    });

    if (succeeded) incrementMetric('glamconnect_payments_refunded_total');
    return { handled: true, event: event.event };
  }

  return { handled: false, event: event.event };
}
