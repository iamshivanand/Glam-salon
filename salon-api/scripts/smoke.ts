/**
 * End-to-end smoke test against a running API.
 *   npx tsx scripts/smoke.ts
 */
const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4000';
const API = `${BASE}/api/v1`;

let passed = 0;
let failed = 0;

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
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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

function istDate(offsetDays = 0) {
  return new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
  console.log(`\nGlam Connect API smoke test → ${BASE}\n`);

  // Health
  const health = (await fetch(`${BASE}/health`).then((r) => r.json())) as any;
  health.status === 'ok' ? ok('health', health.checks) : fail('health', health);
  health.notifications ? ok('notification providers', health.notifications) : fail('notification providers', health);

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

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nSmoke test aborted:', err instanceof Error ? err.message : err);
  process.exit(1);
});
