/**
 * End-to-end smoke test against a running API.
 *   npx tsx scripts/smoke.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { withIntegration } from '../src/db.js';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4000';
const API = `${BASE}/api/v1`;

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(label: string, detail?: unknown) {
  passed += 1;
  console.log(`  PASS  ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
function fail(label: string, err: unknown) {
  failed += 1;
  console.error(`  FAIL  ${label} — ${err instanceof Error ? err.message : JSON.stringify(err)}`);
}

async function call<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; key?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.key) headers['Idempotency-Key'] = opts.key;
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${res.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? text}`);
  }
  return json as T;
}

async function login(phone: string) {
  const challenge = await call<{ challenge_id: string; dev_otp?: string }>('/auth/otp/request', {
    method: 'POST',
    body: { phone },
  });
  if (!challenge.dev_otp) throw new Error('dev_otp missing (DEV_RETURN_OTP=false?)');
  const tokens = await call<{ access_token: string; refresh_token: string; user: any }>('/auth/otp/verify', {
    method: 'POST',
    body: { challenge_id: challenge.challenge_id, otp: challenge.dev_otp },
  });
  return tokens;
}

async function denied(label: string, path: string, token: string, method = 'GET', body?: unknown) {
  try {
    await call(path, { method, token, body });
    fail(label, 'request unexpectedly succeeded');
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.startsWith('403')) ok(label, '403 forbidden');
    else fail(label, message.slice(0, 70));
  }
}

function istDate(offsetDays = 0) {
  return new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
  console.log(`\nGlam Connect API smoke test → ${BASE}\n`);

  // Health
  const healthRes = await fetch(`${BASE}/health`);
  const health = (await healthRes.json()) as any;
  health.status === 'ok' ? ok('health', health.checks) : fail('health', health);
  health.notifications ? ok('notification providers', health.notifications) : fail('notification providers', health);
  healthRes.headers.get('x-content-type-options') === 'nosniff' &&
  healthRes.headers.get('x-frame-options') === 'DENY'
    ? ok('security headers', 'nosniff · DENY')
    : fail('security headers', Object.fromEntries(healthRes.headers));

  // Auth
  const customer = await login('+919800000002');
  ok('customer OTP login', customer.user.full_name);
  const me = await call('/auth/me', { token: customer.access_token });
  ok('GET /auth/me', me.phone_masked);

  const owner = await login('+919800000001');
  ok('owner OTP login', owner.user.role);

  // Discovery
  const search = await call<any>(
    `/discovery/search?lat=12.9719&lng=77.6412&radius_km=15&sort=distance&page_size=10`,
  );
  ok('discovery search', `${search.meta.total} salons`);
  if (!search.salons.length) throw new Error('no salons returned by discovery');

  const salonId = search.salons[0].id;
  const profile = await call<any>(`/salons/${salonId}`);
  ok('salon profile', `${profile.name} · ${profile.services.length} services · ${profile.staff.length} staff`);

  const serviceIds = [profile.services[0].id];
  let date = istDate(1);
  let availability: any = null;
  for (let i = 1; i <= 7; i++) {
    const candidate = istDate(i);
    const result = await call<any>(`/salons/${salonId}/availability?service_ids=${serviceIds.join(',')}&date=${candidate}`);
    if (result.slots.length) {
      availability = result;
      date = candidate;
      break;
    }
  }
  if (!availability) throw new Error('no availability slots in the next 7 days');
  ok('availability', `${availability.slots.length} slots on ${date}`);

  const slot = availability.slots[0];
  const hold = await call<any>('/bookings/hold', {
    method: 'POST',
    token: customer.access_token,
    body: { salon_id: salonId, service_ids: serviceIds, staff_id: slot.staff_id, start_at: slot.start_at },
  });
  ok('slot hold', `expires in ${hold.expires_in}s`);

  const booking = await call<any>('/bookings', {
    method: 'POST',
    token: customer.access_token,
    key: `smoke-booking-${Date.now()}`,
    body: { hold_token: hold.hold_token, customer_notes: 'Smoke test booking' },
  });
  ok('create booking', `${booking.booking_code} · ${booking.status} · PIN ${booking.checkin_pin}`);

  const detail = await call<any>(`/bookings/${booking.id}`, { token: customer.access_token });
  ok('booking detail', `${detail.items.length} items`);

  // Partner surfaces
  const dash = await call<any>('/partner/dashboard?period=MONTH', { token: owner.access_token });
  ok('partner dashboard', `revenue ₹${(dash.revenue_paise / 100).toFixed(0)} · ${dash.completed_visits} visits`);

  const todayBookings = await call<any>(`/partner/bookings?date=${istDate(0)}`, { token: owner.access_token });
  ok('partner day book', `${todayBookings.bookings.length} bookings today`);

  // Role scoping: managers run the full console, staff get only their own
  // shift and assigned bookings.
  const manager = await login('+919800000005');
  ok('manager OTP login', manager.user.role);
  const managerDash = await call<any>('/partner/dashboard?period=MONTH', { token: manager.access_token });
  ok('manager dashboard', `revenue ₹${(managerDash.revenue_paise / 100).toFixed(0)}`);

  const staff = await login('+919800000006');
  ok('staff OTP login', staff.user.role);

  const staffMe = await call<any>('/partner/me/staff', { token: staff.access_token });
  ok('staff self-service profile', `${staffMe.staff.display_name} @ ${staffMe.salon.name}`);

  const staffDay = await call<any>(`/partner/me/bookings?date=${istDate(0)}`, { token: staff.access_token });
  ok('staff own bookings', `${staffDay.bookings.length} assigned today`);
  if (!staffDay.bookings.length) throw new Error('demo staff user has no assigned booking today');

  // Staff may move a booking they are assigned to.
  const staffBookingId = '66666666-6666-4666-8666-000000000007';
  await withIntegration(async (client) => {
    await client.query(`UPDATE bookings SET status = 'REQUESTED' WHERE id = $1`, [staffBookingId]);
  });
  const accepted = await call<any>(`/partner/me/bookings/${staffBookingId}/status`, {
    method: 'PATCH',
    token: staff.access_token,
    body: { status: 'CONFIRMED' },
  });
  ok('staff status update', `${accepted.status} · ${accepted.booking_code}`);

  // ...and nothing else in the partner console.
  await denied('staff blocked from dashboard', '/partner/dashboard', staff.access_token);
  await denied('staff blocked from CRM', '/partner/crm', staff.access_token);
  await denied('staff blocked from invoices', '/partner/invoices', staff.access_token);
  await denied('staff blocked from staff list', '/partner/staff', staff.access_token);

  // A staff member cannot read a booking assigned to someone else.
  const otherDay = await call<any>(`/partner/bookings?date=${istDate(-12)}`, { token: owner.access_token });
  const otherBooking = otherDay.bookings.find((b: any) =>
    b.items.every((i: any) => i.staff_id !== staffMe.staff.id),
  );
  if (otherBooking) {
    await denied('staff blocked from unassigned booking', `/bookings/${otherBooking.id}`, staff.access_token);
  }

  // Managers keep the console but not owner-only actions.
  await denied('manager blocked from KYC submit', '/partner/kyc', manager.access_token, 'POST', {});

  const crm = await call<any>('/partner/crm', { token: owner.access_token });
  ok('partner CRM (RLS)', `${crm.customers.length} customers`);

  const reminders = await call<any>('/partner/reminders', { token: owner.access_token });
  ok('retention reminders', `${reminders.reminders.length} rows · ${reminders.summary.conversion_rate_pct}% conversion`);

  // Reminder delivery: consent is checked, the provider is called, and the row
  // carries a provider receipt. CI runs with the console provider.
  //
  // The background interval dispatcher may win the Redis lock between the insert
  // and the trigger's immediate dispatch, so poll for the new row instead of
  // requiring this request to be the one that sent it.
  const knownReminderIds = new Set(reminders.reminders.map((r: any) => r.id));
  const sentReminder = await call<any>('/partner/reminders/trigger', {
    method: 'POST',
    token: owner.access_token,
    body: {
      customer_ids: [customer.user.id],
      channel: 'WHATSAPP',
      template_code: 'DAY_25_INVITE',
    },
  });
  ok(
    'reminder delivery',
    `queued ${sentReminder.enqueued} · sent ${sentReminder.sent}${sentReminder.failed ? ` · failed ${sentReminder.failed}` : ''}`,
  );

  let delivered: any = null;
  for (let attempt = 0; attempt < 12 && !delivered; attempt += 1) {
    const afterReminders = await call<any>('/partner/reminders', { token: owner.access_token });
    delivered = afterReminders.reminders.find(
      (r: any) =>
        !knownReminderIds.has(r.id) &&
        r.customer_id === customer.user.id &&
        r.status === 'SENT' &&
        r.provider_message_id,
    );
    if (!delivered) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  ok('reminder provider receipt', delivered?.provider_message_id ?? 'missing');
  if (!delivered) throw new Error('reminder was not delivered through the provider');

  const consentBlocked = await call<any>('/partner/reminders/trigger', {
    method: 'POST',
    token: owner.access_token,
    body: {
      customer_ids: [customer.user.id],
      channel: 'EMAIL',
      template_code: 'DAY_25_INVITE',
    },
  });
  ok('reminder consent guard', `queued ${consentBlocked.enqueued} · skipped ${consentBlocked.skipped}`);
  if (consentBlocked.enqueued !== 0) throw new Error('reminder sent without EMAIL consent');

  const queue = await call<any>('/partner/queue', { token: owner.access_token });
  ok('live walk-in queue', `${queue.waiting_count} waiting · now serving ${queue.now_serving_token ?? '—'}`);

  // POS is self-contained: check in the booking this smoke run just created,
  // then bill it. It no longer depends on seed data being dated "today".
  await call(`/bookings/${booking.id}/status`, {
    method: 'PATCH',
    token: owner.access_token,
    body: { status: 'ARRIVED' },
  });
  const invoice = await call<any>('/partner/invoices', {
    method: 'POST',
    token: owner.access_token,
    key: `smoke-invoice-${Date.now()}`,
    body: { booking_id: booking.id, method: 'UPI_QR' },
  });
  ok('POS invoice', `${invoice.invoice_number} · net ₹${(invoice.net_collected_paise / 100).toFixed(0)}`);

  // A completed visit must be reviewable, and the salon aggregate must move.
  const past = await call<any>('/bookings', { token: customer.access_token });
  const completed = past.bookings.find((b: any) => b.id === booking.id && b.status === 'COMPLETED');
  if (!completed) throw new Error('invoice did not complete the booking');
  const review = await call<any>(`/bookings/${booking.id}/reviews`, {
    method: 'POST',
    token: customer.access_token,
    body: { overall_rating: 5, hygiene_rating: 5, review_text: 'Smoke test review' },
  });
  const ratedProfile = await call<any>(`/salons/${salonId}`);
  ok(
    'review + aggregate sync',
    `review ${review.id.slice(0, 8)} · salon now ★${ratedProfile.avg_rating} (${ratedProfile.review_count})`,
  );

  // Customer bookings list
  const mine = await call<any>('/bookings', { token: customer.access_token });
  ok('customer bookings list', `${mine.bookings.length} bookings`);

  // Refresh-token rotation
  const rotated = await call<any>('/auth/refresh', {
    method: 'POST',
    body: { refresh_token: customer.refresh_token },
  });
  if (!rotated.access_token || !rotated.refresh_token) throw new Error('refresh did not return new tokens');
  const meAfterRefresh = await call('/auth/me', { token: rotated.access_token });
  ok('refresh token rotation', meAfterRefresh.phone_masked);

  // Admin
  const admin = await login('+919800000009');
  const stats = await call<any>('/admin/stats', { token: admin.access_token });
  ok('admin stats', `${stats.salons.total} salons · ${stats.users.customers} customers`);

  const audit = await call<any>('/admin/audit?limit=5', { token: admin.access_token });
  ok('admin audit log', `${audit.events.length} recent events`);

  // Uploads are registered and size-checked even when no bucket is configured.
  const uploadStatus = await call<any>('/uploads/status');
  ok(
    'upload limits',
    `image ${Math.floor(uploadStatus.max_image_bytes / (1024 * 1024))} MB · pdf ${Math.floor(uploadStatus.max_pdf_bytes / (1024 * 1024))} MB`,
  );
  try {
    await call('/uploads/presign', {
      method: 'POST',
      token: customer.access_token,
      body: { purpose: 'avatar', content_type: 'image/png', size_bytes: 2048 },
    });
    fail('presign blocked without storage', 'expected 503');
  } catch (err) {
    ok('presign blocked without storage', err instanceof Error ? err.message.slice(0, 40) : '503');
  }

  // Business identifier formats are rejected before anything is stored.
  try {
    await call('/partner/kyc', {
      method: 'POST',
      token: owner.access_token,
      body: { pan_number: 'BADPAN', bank_account_number: '123456', bank_ifsc: 'HDFC0001234' },
    });
    fail('KYC format validation', 'invalid PAN was accepted');
  } catch (err) {
    ok('KYC format validation', err instanceof Error ? err.message.slice(0, 60) : '400');
  }

  const payouts = await call<any>('/partner/payouts', { token: owner.access_token });
  ok('partner payouts', `${payouts.payouts.length} recorded`);

  // Razorpay webhooks must find orders under FORCE RLS and keep the refund
  // ledger in sync. Seed an order directly (no gateway needed), then post
  // signed events exactly as Razorpay would.
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const webhookOrderId = crypto.randomUUID();
  const providerOrderId = `order_smoke_${Date.now()}`;
  const providerPaymentId = `pay_smoke_${Date.now()}`;
  if (!webhookSecret) {
    skipped += 1;
    console.log('  SKIP  razorpay webhook checks — RAZORPAY_WEBHOOK_SECRET is not set');
  } else {
    await withIntegration(async (client) => {
      await client.query(
        `INSERT INTO payment_orders
           (id, salon_id, customer_id, provider, provider_order_id, amount_paise, currency, status, idempotency_key)
         VALUES ($1,$2,$3,'razorpay',$4,100000,'INR','CREATED',$5)`,
        [webhookOrderId, salonId, customer.user.id, providerOrderId, `smoke-webhook-${Date.now()}`],
      );
    });

    const webhook = async (payload: unknown) => {
      const raw = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
      const res = await fetch(`${BASE}/webhooks/razorpay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
        body: raw,
      });
      if (!res.ok) throw new Error(`webhook ${res.status}: ${await res.text()}`);
      return res.json();
    };

    const orderState = () =>
      withIntegration(async (client) => {
        const res = await client.query<{ status: string; provider_payment_id: string | null }>(
          `SELECT status, provider_payment_id FROM payment_orders WHERE id = $1`,
          [webhookOrderId],
        );
        return res.rows[0];
      });

    await webhook({
      event: 'payment.captured',
      payload: { payment: { entity: { id: providerPaymentId, order_id: providerOrderId } } },
    });
    const paid = await orderState();
    ok('razorpay webhook capture', `${paid.status} · ${paid.provider_payment_id}`);

    await webhook({
      event: 'refund.processed',
      payload: { refund: { entity: { id: `rfnd_smoke_${Date.now()}`, payment_id: providerPaymentId, amount: 40000 } } },
    });
    const partial = await orderState();
    ok('razorpay webhook partial refund', partial.status);

    await webhook({
      event: 'refund.processed',
      payload: {
        refund: {
          entity: { id: `rfnd_smoke_${Date.now()}_b`, payment_id: providerPaymentId, amount: 60000 },
        },
      },
    });
    const full = await orderState();
    ok('razorpay webhook full refund', full.status);

    const ledger = await withIntegration(async (client) => {
      const res = await client.query<{ total: string; rows: string }>(
        `SELECT COALESCE(SUM(amount_paise), 0)::bigint::text AS total, COUNT(*)::text AS rows
           FROM payment_refunds
          WHERE payment_order_id = $1 AND status = 'SUCCEEDED'`,
        [webhookOrderId],
      );
      return res.rows[0];
    });
    ok('razorpay refund ledger', `${ledger.rows} rows · ₹${Number(ledger.total) / 100}`);

    await withIntegration(async (client) => {
      await client.query(`DELETE FROM payment_refunds WHERE payment_order_id = $1`, [webhookOrderId]);
      await client.query(`DELETE FROM payment_orders WHERE id = $1`, [webhookOrderId]);
    });
  }

  // With test keys configured, exercise the real Razorpay API and the
  // checkout-signature path. No money moves: test mode only.
  const razorpayReady =
    health.payments?.provider === 'razorpay' &&
    Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  if (!razorpayReady) {
    skipped += 1;
    console.log('  SKIP  razorpay order + verify — test keys are not configured');
  } else {
    const intentKey = `smoke-rzp-${Date.now()}`;
    const intent = await call<any>('/payments/intents', {
      method: 'POST',
      token: customer.access_token,
      key: intentKey,
      body: { booking_id: booking.id, amount_paise: 10000 },
    });
    ok('razorpay test order', `${intent.order_id} · ₹${intent.amount_paise / 100}`);

    const replay = await call<any>('/payments/intents', {
      method: 'POST',
      token: customer.access_token,
      key: intentKey,
      body: { booking_id: booking.id, amount_paise: 10000 },
    });
    ok(
      'razorpay intent idempotency',
      replay.payment_id === intent.payment_id ? 'same payment' : 'DUPLICATE CREATED',
    );

    // Razorpay checkout signature is HMAC-SHA256(order_id|payment_id, secret).
    const syntheticPaymentId = `pay_smoke_${Date.now()}`;
    const signature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(`${intent.order_id}|${syntheticPaymentId}`)
      .digest('hex');
    const verified = await call<any>(`/payments/${intent.payment_id}/verify`, {
      method: 'POST',
      token: customer.access_token,
      body: {
        razorpay_order_id: intent.order_id,
        razorpay_payment_id: syntheticPaymentId,
        razorpay_signature: signature,
      },
    });
    ok('razorpay checkout verify', `${verified.status} · verified=${verified.verified}`);

    await withIntegration(async (client) => {
      await client.query(`DELETE FROM payment_orders WHERE id = $1`, [intent.payment_id]);
    });
  }

  try {
    await call('/partner/payments/00000000-0000-0000-0000-000000000000/refund', {
      method: 'POST',
      token: owner.access_token,
      key: `smoke-refund-${Date.now()}`,
      body: {},
    });
    fail('refund rejects unknown payment', 'expected 404');
  } catch (err) {
    ok('refund rejects unknown payment', err instanceof Error ? err.message.slice(0, 40) : '404');
  }

  // Account controls run on a throwaway phone so demo data is untouched.
  const tempPhone = `+9199${String(Date.now()).slice(-8)}`;
  const temp = await login(tempPhone);
  const sessions = await call<any>('/users/me/sessions', { token: temp.access_token });
  ok('session list', `${sessions.sessions.length} active`);
  const revokedOne = await call<any>(`/users/me/sessions/${sessions.sessions[0].id}/revoke`, {
    method: 'POST',
    token: temp.access_token,
    body: {},
  });
  const afterRevoke = await call<any>('/users/me/sessions', { token: temp.access_token });
  ok(
    'single session revoke',
    `${revokedOne.revoked} revoked · ${sessions.sessions.length - afterRevoke.sessions.length} removed`,
  );
  const exported = await call<any>('/users/me/export', { token: temp.access_token });
  ok(
    'data export',
    `${exported.profile.full_name} · ${exported.bookings.length} bookings · ${exported.consents.length} consents`,
  );
  await call('/users/me/consents', {
    method: 'POST',
    token: temp.access_token,
    body: { channel: 'EMAIL', purpose: 'PROMOTIONAL_OFFERS', is_granted: true },
  });
  const consentHistory = await call<any>('/users/me/consents/history', { token: temp.access_token });
  ok('consent history', `${consentHistory.events.length} events`);
  const revoked = await call<any>('/users/me/sessions/revoke-all', {
    method: 'POST',
    token: temp.access_token,
    body: {},
  });
  ok('revoke all sessions', `${revoked.revoked} revoked`);
  const deletion = await call<any>('/users/me', { method: 'DELETE', token: temp.access_token });
  ok('account deletion', deletion.ok ? 'soft-deleted with identifiers removed' : 'unexpected response');

  // Authorization checks
  try {
    await call('/admin/stats', { token: customer.access_token });
    fail('RBAC blocks customer from admin', 'expected 403');
  } catch (err) {
    ok('RBAC blocks customer from admin');
  }
  try {
    await call('/partner/dashboard', { token: customer.access_token });
    fail('RBAC blocks customer from partner', 'expected 403');
  } catch (err) {
    ok('RBAC blocks customer from partner');
  }

  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nSmoke test aborted:', err instanceof Error ? err.message : err);
  process.exit(1);
});
