import { one, query, withIntegration, withTenant } from '../db.js';
import { env } from '../env.js';
import { badRequest, conflict, notFound } from '../http.js';
import { incrementMetric } from '../metrics.js';
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

  const existing = await one<PaymentOrder>(
    `SELECT * FROM payment_orders WHERE customer_id = $1 AND idempotency_key = $2`,
    [opts.customerId, opts.idempotencyKey],
  );
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
  return {
    payment_id: order.id,
    provider: order.provider,
    status: order.status,
    amount_paise: Number(order.amount_paise),
    currency: order.currency,
    booking_id: order.booking_id,
    invoice_id: order.invoice_id,
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
  const order = await one<PaymentOrder>(
    `SELECT * FROM payment_orders WHERE id = $1 AND customer_id = $2`,
    [opts.paymentId, opts.customerId],
  );
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

export async function refundPayment(opts: {
  salonId: string;
  paymentId: string;
  amountPaise?: number;
  reason?: string;
  actorId: string;
}): Promise<Record<string, unknown>> {
  const order = await withTenant(opts.salonId, async (client) => {
    const res = await client.query<PaymentOrder>(
      `SELECT * FROM payment_orders WHERE id = $1 AND salon_id = $2 FOR UPDATE`,
      [opts.paymentId, opts.salonId],
    );
    return res.rows[0];
  });
  if (!order) throw notFound('Payment not found');
  if (order.status !== 'PAID') throw conflict('PAYMENT_NOT_REFUNDABLE', `Cannot refund a ${order.status} payment`);

  const amount = Math.min(opts.amountPaise ?? Number(order.amount_paise), Number(order.amount_paise));
  if (amount <= 0) throw badRequest('INVALID_AMOUNT', 'Refund amount must be greater than zero');

  let providerRefundId: string | null = null;
  if (order.provider === 'razorpay') {
    if (!order.provider_payment_id) throw conflict('PAYMENT_NOT_REFUNDABLE', 'No Razorpay payment id on file');
    const refund = await razorpayRequest<{ id: string; status: string }>(
      `/payments/${order.provider_payment_id}/refund`,
      'POST',
      { amount, notes: { reason: opts.reason ?? '', actor_id: opts.actorId }, speed: 'normal' },
    );
    providerRefundId = refund.id;
  }

  const full = amount >= Number(order.amount_paise);
  const updated = await withTenant(opts.salonId, async (client) => {
    const res = await client.query<PaymentOrder>(
      `UPDATE payment_orders
          SET status = $2,
              refunded_at = NOW(),
              raw_response = raw_response || $3::jsonb
        WHERE id = $1
        RETURNING *`,
      [
        order.id,
        full ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        JSON.stringify({ refund: { amount_paise: amount, provider_refund_id: providerRefundId, reason: opts.reason ?? null } }),
      ],
    );
    if (order.invoice_id) {
      await client.query(
        `UPDATE invoices_and_payments
            SET status = $2
          WHERE id = $1 AND salon_id = $3`,
        [order.invoice_id, full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', order.salon_id],
      );
    }
    return res.rows[0];
  });

  incrementMetric('glamconnect_payments_refunded_total');
  return {
    payment_id: updated.id,
    status: updated.status,
    refunded_paise: amount,
    provider_refund_id: providerRefundId,
    simulated: order.provider === 'manual',
  };
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

  if (event.event === 'payment.captured' && payment?.order_id && payment?.id) {
    const order = await one<PaymentOrder>(
      `SELECT * FROM payment_orders WHERE provider = 'razorpay' AND provider_order_id = $1`,
      [payment.order_id],
    );
    if (order && order.status !== 'PAID') {
      await markPaid(order, payment.id, { source: 'webhook', event: event.event });
      incrementMetric('glamconnect_payments_captured_total');
    }
    return { handled: true, event: event.event };
  }

  if ((event.event === 'payment.failed' || event.event === 'payment.authorized') && payment?.order_id) {
    const order = await one<PaymentOrder>(
      `SELECT * FROM payment_orders WHERE provider = 'razorpay' AND provider_order_id = $1`,
      [payment.order_id],
    );
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

  if (event.event === 'refund.processed' && refund?.payment_id) {
    const order = await one<PaymentOrder>(
      `SELECT * FROM payment_orders WHERE provider = 'razorpay' AND provider_payment_id = $1`,
      [refund.payment_id],
    );
    if (order) {
      const refunded = Number(refund.amount ?? 0);
      const full = refunded >= Number(order.amount_paise);
      await withTenant(order.salon_id, async (client) => {
        await client.query(
          `UPDATE payment_orders
              SET status = $2, refunded_at = NOW(), raw_response = raw_response || $3::jsonb
            WHERE id = $1`,
          [order.id, full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', JSON.stringify({ source: 'webhook', refund })],
        );
      });
      incrementMetric('glamconnect_payments_refunded_total');
    }
    return { handled: Boolean(order), event: event.event };
  }

  return { handled: false, event: event.event };
}
