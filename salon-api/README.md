# Glam Connect API

Fastify 5 + PostgreSQL (PostGIS) + Redis backend for the Glam Connect salon platform.
Implements Phase 1 of the product blueprint: OTP auth, discovery, availability, booking
holds, POS billing, GST/commission split, salon CRM, retention reminders, walk-in queue,
reviews and admin verification.

- All money is stored and returned as **integer paise**.
- All timestamps are stored **UTC** and rendered in **Asia/Kolkata** by clients.
- Every mutating booking/billing call requires an `Idempotency-Key` header.
- Tenant tables are protected by PostgreSQL **row-level security**; the API connects as the
  least-privilege `glam_app` role so RLS is always enforced.

## 1. Infrastructure

From the repository root:

```powershell
docker compose up -d
docker ps
```

| Service  | Container             | Host port |
| -------- | --------------------- | --------- |
| Postgres | `glamconnect-postgres` | `5433`    |
| Redis    | `glamconnect-redis`    | `6380`    |

Port 5433/6380 are used so the stack can coexist with an unrelated Postgres on 5432.

## 2. Configure

```powershell
cd salon-api
Copy-Item .env.example .env
```

`.env` holds two database URLs on purpose:

- `DATABASE_URL` — `glam_app` (runtime, RLS enforced)
- `MIGRATE_DATABASE_URL` — `glam` superuser (migrations + seed only)

`DEV_RETURN_OTP=true` returns the OTP in the `/auth/otp/request` response so you can log in
without an SMS provider. Turn it off for any real deployment.

Notification credentials live in the same file (see `.env.example`). `NOTIFICATION_PROVIDER`
accepts `auto` (default), `console`, `webhook`, `twilio`, `whatsapp_cloud` or `resend`:

- `auto` wires every provider whose credentials are present, then falls back to the console
  provider in development.
- Twilio covers `SMS` and/or `WHATSAPP` (`TWILIO_*`); Meta covers `WHATSAPP`
  (`WHATSAPP_*`); Resend covers `EMAIL`; the generic webhook covers all four channels.
- `OTP_CHANNEL=SMS|WHATSAPP` chooses how login codes are sent.
- Console delivery is refused in production unless `ALLOW_CONSOLE_NOTIFICATIONS=true`, so a
  misconfigured deployment fails loudly instead of silently pretending to send.
- Without any credentials, development and CI still exercise the real dispatch path through
  the console provider. That is the only mode this repository can demonstrate end to end.

## 3. Migrate, seed, run

```powershell
npm install
npm run migrate     # applies db/migrations/*.sql in order
npm run seed        # 3 Bengaluru salons, staff, catalog, bookings, CRM, reminders
npm run dev         # http://localhost:4000
```

Useful scripts:

| Script              | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `npm run dev`       | `tsx watch src/index.ts`                                   |
| `npm run build`     | TypeScript compile to `dist/` (`dist/src/index.js`)        |
| `npm start`         | Run the compiled server                                    |
| `npm run typecheck` | `tsc --noEmit` across src, scripts and tests               |
| `npm test`          | Unit tests (signatures, storage keys/presign, rendering)   |
| `npm run migrate`   | Apply pending migrations                                   |
| `npm run migrate:prod` | Apply migrations from the compiled build                |
| `npm run seed`      | Load the deterministic demo dataset                        |
| `npm run db:reset`  | Drop the `public` schema (destructive)                     |
| `npm run dispatch`  | One-shot reminder dispatch (cron-friendly, no HTTP)        |
| `npm run smoke`     | 26-check end-to-end test against a running API             |

A clean rebuild:

```powershell
npm run db:reset
npm run migrate
npm run seed
```

## 4. Verify

```powershell
npm run smoke
```

Covers health, notification provider routing, customer/owner/admin OTP login, discovery,
salon profile, availability, slot hold, booking creation, booking detail, partner dashboard,
day book, CRM (through RLS), reminders, reminder delivery with a provider receipt, the
consent guard, live queue, POS invoice, customer booking list, admin stats and two RBAC
denials.

Prove tenant isolation directly:

```powershell
docker exec -e PGPASSWORD=glam_app_pw glamconnect-postgres psql -U glam_app -d glamconnect `
  -c "SELECT count(*) FROM salon_customer_crm;" `
  -c "SELECT set_config('app.current_salon_id','33333333-3333-4333-8333-000000000001',false);" `
  -c "SELECT count(*) FROM salon_customer_crm;"
```

Expected: `0` rows with no tenant context, `3` rows with salon 1's context.

## 5. Demo accounts

OTP is auto-filled in dev responses.

| Role          | Phone           | Name           |
| ------------- | --------------- | -------------- |
| Salon owner   | `+919800000001` | Ananya Rao     |
| Customer      | `+919800000002` | Priya Sharma   |
| Customer      | `+919800000003` | Neha Verma     |
| Customer      | `+919800000004` | Kavya Iyer     |
| Platform admin| `+919800000009` | Platform Admin |

Seeded staff are **off on Sundays**; availability lookups should scan a few days ahead.

## 6. Layout

```
src/
  index.ts            Fastify bootstrap, CORS/cookies, error mapping, health, shutdown
  env.ts db.ts redis.ts http.ts auth.ts crypto.ts types.ts
  routes/
    auth.ts           OTP, refresh/logout, profile, consents, addresses
    discovery.ts      categories, search, urgent slots, compare, profile, availability
    bookings.ts       hold, create, list, detail, reschedule, cancel, status, review
    queue.ts          public walk-in join + live queue
    partner.ts        onboarding, KYC, catalog, staff, day book, billing, CRM, reminders, queue, reviews
    admin.ts          platform stats, KYC review, commissions, salon/user lists
  services/
    availability.ts   slot computation against schedules, breaks, resources, buffers
    booking.ts        holds, creation, reschedule, cancel, status transitions, reviews
    invoices.ts       GST, commission split, CRM upsert, loyalty ledger, reminder scheduling
    reminders.ts      Day 20/25/35 scheduling, suppression, listing, manual trigger
    analytics.ts      owner dashboard under the tenant GUC
    queue.ts          walk-in tokens and estimated waits
    discovery.ts      geo search, ranking, profile, compare
    notifications.ts  provider adapters (console, webhook, Twilio, Meta, Resend, Expo), routing, OTP copy
    dispatcher.ts     due-reminder delivery, Redis locks, retries, interval runner
    engagement.ts     click tracking, conversion attribution, delivery events, opt-out, funnel
    transactional.ts  booking/queue/invoice message dispatch through the provider layer
    payments.ts       payment intents, Razorpay orders/verify/webhook, refunds, settlements
    storage.ts        S3 SigV4 presigned PUTs without the AWS SDK
    signatures.ts     Twilio/Meta/Razorpay signature verification
    rendering.ts      pure reminder + transactional message copy
    opt-out.ts        STOP/unsubscribe detection
  metrics.ts          dependency-free Prometheus counters
  routes/public.ts    /r/:token click redirect and provider callbacks (no /api/v1 prefix)
db/migrations/        001_extensions … 012_engagement_payments_ops
test/                 unit tests (node:test via tsx)
scripts/              migrate, seed, reset, dispatch, smoke
```

## 7. Endpoints (prefix `/api/v1`)

**Auth** `POST /auth/otp/request` · `POST /auth/otp/verify` · `POST /auth/refresh` ·
`POST /auth/logout` · `GET /auth/me` · `PATCH /users/me` · consents · addresses

**Discovery** `GET /categories` · `GET /discovery/search` · `GET /discovery/urgent` ·
`GET /discovery/compare` · `GET /salons/:id` · `GET /salons/:id/availability` ·
`GET /salons/:id/availability/next` · `GET /salons/:id/reviews` · `GET /salons/:id/queue`

**Bookings** `POST /bookings/hold` · `POST /bookings` · `GET /bookings` · `GET /bookings/:id` ·
`POST /bookings/:id/reschedule` · `POST /bookings/:id/cancel` · `PATCH /bookings/:id/status` ·
`POST /bookings/:id/reviews` · `GET /bookings/:id/checkin-code`

**Queue** `POST /queue/join` · `GET /queue/:salonId/live` · `PATCH /queue/:salonId/tokens/:tokenId`

**Partner** `/partner/salons` · `/partner/salon` (+ `/submit`) · `/partner/kyc` · `/partner/hygiene` ·
`/partner/services` · `/partner/staff` (+ schedule, services) · `/partner/resources` ·
`/partner/bookings` · `/partner/dashboard` · `/partner/invoices` · `/partner/payments` (+ `/:id/refund`) ·
`/partner/settlements` · `/partner/ledger/:customerId` · `/partner/crm` ·
`/partner/reminders` (+ `/trigger`, `/dispatch`, `/analytics`) · `/partner/queue` · `/partner/reviews`

**Payments** `GET /payments/capabilities` · `GET /payments` · `POST /payments/intents` ·
`POST /payments/:id/verify` (all customer-scoped; intents require `Idempotency-Key`)

**Uploads / devices** `GET /uploads/status` · `POST /uploads/presign` · `PATCH /users/me/avatar` ·
`POST /users/me/devices` · `DELETE /users/me/devices/:token`

**Admin** `GET /admin/stats` · `GET /admin/kyc` · `POST /admin/kyc/:salonId/review` ·
`PATCH /admin/salons/:id/commission` · `GET /admin/salons` · `GET /admin/users`

**Public (no `/api/v1`, signature-verified)** `GET /r/:token` · `POST /webhooks/twilio/status` ·
`POST /webhooks/twilio/inbound` · `GET|POST /webhooks/whatsapp` · `POST /webhooks/razorpay` ·
`POST /webhooks/notifications` · `GET /health` · `GET /metrics`

Errors always use `{ "error": { "code", "message", "details?" } }`.

## 8. Notifications and reminder delivery

Login codes and retention reminders share one provider layer (`src/services/notifications.ts`)
with adapters for console, generic webhook, Twilio SMS/WhatsApp, Meta WhatsApp Cloud and
Resend email. `GET /health` reports the provider resolved for each channel, for example
`{"SMS":"console","WHATSAPP":"console","EMAIL":"console","PUSH":"expo"}`.

Reminder dispatch (`src/services/dispatcher.ts`) is at-least-once:

- Due rows are read per salon because `retention_reminders` is protected by `FORCE` RLS.
- A Redis lock per reminder prevents duplicate sends across API instances.
- Consent is re-checked immediately before sending; rows without
  `RETENTION_REMINDER` consent become `SUPPRESSED_OPT_OUT`.
- Success marks the row `SENT` and stores the provider message id.
- Failure records `last_error` and retries with a 5-minute × attempt backoff. After
  `REMINDER_MAX_ATTEMPTS` (default 3) the row becomes `FAILED`.
- Migration `011_reminder_delivery.sql` adds `delivery_attempts`, `last_error` and
  `next_attempt_at`.

Two ways to run it:

- In-process interval: enabled by default every `REMINDER_DISPATCH_INTERVAL_SEC` (30s). Set
  `REMINDER_DISPATCH_ENABLED=false` to disable.
- One-shot cron: `npm run dispatch [-- limit]`, or
  `POST /partner/reminders/dispatch` for a manual tenant-scoped sweep.

`POST /partner/reminders/trigger` inserts `SCHEDULED` rows for the selected customers and
then attempts immediate delivery, returning `enqueued`, `skipped`, `sent` and `failed`.

Real vendor delivery is implemented but **unverified in this repository** because no Twilio,
Meta, Resend or webhook credentials are configured. Local runs and CI therefore use the
console provider and prove routing, consent, receipts and retry state — not carrier delivery.

### Engagement loop

- Reminder links point at `GET /r/:token` on the API. The redirect records `CLICKED`
  (monotonic; it never downgrades a conversion), then sends the customer to
  `APP_PUBLIC_URL/book?salon=…&ref=<token>`.
- `POST /bookings` accepts `reminder_token`; a matching booking moves the reminder to
  `CONVERTED_TO_BOOKING` and writes a `reminder_events` row.
- Provider callbacks (`/webhooks/twilio/*`, `/webhooks/whatsapp`, `/webhooks/notifications`)
  apply `DELIVERED`/`OPENED`/`FAILED` by provider message id, again monotonically.
- Inbound `STOP`/`UNSUBSCRIBE` on SMS or WhatsApp writes a global (salon-less)
  `RETENTION_REMINDER` revocation and suppresses every pending reminder for that customer.
- `GET /partner/reminders/analytics` returns the funnel counters shown in the web console.

### WhatsApp compliance

Business-initiated messages need approved templates. Set `WHATSAPP_TEMPLATES_ENABLED=true`
and `WHATSAPP_TEMPLATE_MAP` (template code → Meta template name) before enabling production
WhatsApp reminders. Without them the adapter sends free-form text, which only works inside a
customer service window. Signature checks use `WHATSAPP_APP_SECRET`; webhook verification uses
`WHATSAPP_VERIFY_TOKEN`.

## 9. Payments, uploads and operations

### Payments

`PAYMENT_PROVIDER` accepts `none`, `manual` (default) or `razorpay`.

- `manual` records pay-at-salon **intent only**. It never captures money; `GET
  /payments/capabilities` says so and the UI labels it accordingly.
- `razorpay` creates real orders via the live API, verifies checkout signatures, and handles
  `payment.captured`, `payment.failed` and `refund.processed` webhooks. Refunds call
  `/payments/:id/refund` upstream.
- Partner settlement figures are computed from captured invoices in Asia/Kolkata days.
  Payout execution depends on the provider; the API reports commission and partner net.

### Uploads

`POST /uploads/presign` returns a 15-minute SigV4 `PUT` URL. Allowed types are JPEG, PNG, WebP
and PDF. KYC uploads require the salon owner (or a platform admin) and a `salon_id`. The API
never proxies file bytes. Without `S3_BUCKET`/keys the endpoint returns
`503 STORAGE_NOT_CONFIGURED` and the web UI says storage is not configured.

### Health, metrics and backups

- `GET /health` → database/Redis checks plus resolved providers and payment/storage capability.
- `GET /metrics` → Prometheus text counters (HTTP, webhooks, reminder delivery/opt-out/conversion,
  payment capture/refund). Disable with `METRICS_ENABLED=false`.
- Unit tests: `npm test` (signatures, storage key/presign shape, message rendering, opt-out).
- Docker, migrations, backups and the deployment checklist: [`../ops/README.md`](../ops/README.md).

## 10. Not implemented yet

OpenSearch, BullMQ/n8n workers and a durable reminder queue (dispatch is an in-process interval
or cron). `DEV_RETURN_OTP` remains the only way to log in locally without provider credentials.
Real carrier/payment/storage delivery is implemented but unverified here without credentials.
