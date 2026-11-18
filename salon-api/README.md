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
| `npm test`          | Unit tests (signatures, storage presign, validation, rendering) |
| `npm run migrate`   | Apply pending migrations                                   |
| `npm run migrate:prod` | Apply migrations from the compiled build                |
| `npm run seed`      | Load the deterministic demo dataset                        |
| `npm run db:reset`  | Drop the `public` schema (destructive)                     |
| `npm run dispatch`  | One-shot reminder dispatch (cron-friendly, no HTTP)        |
| `npm run smoke`     | End-to-end test against a running API (43 checks with Razorpay test keys) |

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
consent guard, live queue, POS invoice, customer booking list, admin stats, admin audit log,
upload limits, presign refusal without storage, KYC format validation, refund rejection,
partner payouts, session listing, consent history, session revocation, account deletion and
two RBAC denials. With `RAZORPAY_WEBHOOK_SECRET` set it also posts signed capture/refund
webhooks and checks the refund ledger (this runs in CI with a dummy secret). With test API
keys it creates a real test-mode Razorpay order, replays the intent key and verifies a
checkout signature; those three checks are skipped when keys are absent.

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
    auth.ts           OTP, refresh/logout, profile, consents + history, sessions, account deletion
    discovery.ts      categories, search, urgent slots, compare, profile, availability
    bookings.ts       hold, create, list, detail, reschedule, cancel, status, review
    queue.ts          public walk-in join + live queue
    partner.ts        onboarding, KYC, catalog, staff, day book, billing, CRM, reminders, queue, reviews, payouts
    admin.ts          platform stats, KYC review + document, salon status, user role/status, payouts, audit
    uploads.ts        presign/confirm/read registry with size and content-type checks
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
    payments.ts       payment intents, Razorpay orders/verify/webhook, idempotent refunds, settlements, payouts
    storage.ts        S3 SigV4 presign PUT/GET/HEAD/DELETE without the AWS SDK
    audit.ts          append-only platform audit log
    signatures.ts     Twilio/Meta/Razorpay signature verification
    rendering.ts      pure reminder + transactional message copy
    opt-out.ts        STOP/unsubscribe detection
  validation.ts       PAN/GSTIN/IFSC formats shared by routes and tests
  metrics.ts          dependency-free Prometheus counters
  routes/public.ts    /r/:token click redirect and provider callbacks (no /api/v1 prefix)
db/migrations/        001_extensions … 013_hardening
test/                 unit tests (node:test via tsx)
scripts/              migrate, seed, reset, dispatch, smoke
```

## 7. Endpoints (prefix `/api/v1`)

**Auth** `POST /auth/otp/request` · `POST /auth/otp/verify` · `POST /auth/refresh` ·
`POST /auth/logout` · `GET /auth/me` · `PATCH /users/me` · `DELETE /users/me` ·
`GET /users/me/sessions` · `POST /users/me/sessions/revoke-all` ·
`GET /users/me/consents/history` · consents · addresses

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
`/partner/settlements` · `/partner/payouts` · `/partner/ledger/:customerId` · `/partner/crm` ·
`/partner/reminders` (+ `/trigger`, `/dispatch`, `/analytics`) · `/partner/queue` · `/partner/reviews`

**Payments** `GET /payments/capabilities` · `GET /payments` · `POST /payments/intents` ·
`POST /payments/:id/verify` (all customer-scoped; intents require `Idempotency-Key`)

**Uploads / devices** `GET /uploads/status` · `POST /uploads/presign` · `POST /uploads/confirm` ·
`GET /uploads/:id/url` · `PATCH /users/me/avatar` ·
`POST /users/me/devices` · `DELETE /users/me/devices/:token`

**Admin** `GET /admin/stats` · `GET /admin/kyc` · `POST /admin/kyc/:salonId/review` ·
`GET /admin/kyc/:salonId/document` · `PATCH /admin/salons/:id/status` ·
`PATCH /admin/salons/:id/commission` · `POST /admin/salons/:id/payouts` ·
`PATCH /admin/users/:id` · `GET /admin/audit` · `GET /admin/salons` · `GET /admin/users`

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
- Payment tables use `FORCE ROW LEVEL SECURITY`, so every webhook lookup runs under the
  trusted-integration GUC and every write under the owning salon's tenant transaction.
  `payment.captured` marks the order paid; `refund.processed`/`refund.failed` update the
  matching ledger row (by our `refund_id` note, then provider id, otherwise inserted as an
  external refund) and recompute `REFUNDED` vs `PARTIALLY_REFUNDED` from the cumulative
  ledger. The same fix covers idempotent intent lookup and checkout verification, which
  previously returned “not found” under RLS.
- Refunds go through the `payment_refunds` ledger. The partner route accepts an
  `Idempotency-Key`, reserves the amount inside a transaction, calls the gateway, then marks
  the ledger row and the order together. A retry with the same key returns the original
  outcome instead of moving money twice; partial refunds are accumulated, and every refund is
  written to the audit log.
- Partner settlement figures are computed from captured invoices in Asia/Kolkata days.
  Payout execution is **manual**: a platform admin records the bank transfer
  (`POST /admin/salons/:id/payouts`), and `GET /partner/payouts` shows what was paid for a
  period. The settlement report itself stays computed.

### Uploads

The upload flow is two-step and registry-backed:

1. `POST /uploads/presign` with `{ purpose, content_type, size_bytes, salon_id? }`. The API
   stores a `PRESIGNED` row in `uploads`, signs the content type into a 15-minute SigV4 `PUT`
   URL, and returns the `upload_id` plus the exact header to send.
2. The client `PUT`s the bytes directly to object storage.
3. `POST /uploads/confirm` HEADs the object, compares the stored content type and size with the
   declaration, and only then marks the row `UPLOADED`. A mismatch or oversize object is marked
   `REJECTED`, deleted, and the request fails.

Allowed types are JPEG, PNG, WebP (5 MB) and PDF (10 MB). KYC uploads require the salon owner
(or a platform admin) and a `salon_id`. Avatar and KYC keys are only accepted if they point at
a confirmed upload owned by the caller; admin KYC reads use an audited signed `GET` and never
expose the key. The API never proxies file bytes. Without `S3_BUCKET`/keys the endpoints return
`503 STORAGE_NOT_CONFIGURED` and the web UI says storage is not configured.

The presigned `PUT` cannot itself enforce a size limit (there is no POST policy), so the
server-side ceiling is applied at confirm time via HEAD. The signed `Content-Type` does prevent
type swapping at upload time.

### Platform governance and account controls

- KYC submissions validate PAN (`ABCDE1234F`), optional GSTIN (15 characters with the `Z`
  marker) and IFSC (`HDFC0001234`) before anything is stored. Re-submitting after a rejection
  moves the salon `REJECTED → SUBMITTED`; an already-approved salon keeps `APPROVED` while the
  KYC row returns to `SUBMITTED` for review of the bank-detail change.
- Platform admins can pause or activate a salon, change a user's role or status, record
  payouts, and read the audit log. Role changes apply on the next sign-in; suspending or
  deleting an account revokes every refresh token immediately, and the last active platform
  admin cannot be demoted.
- Customers can list their active sessions, revoke all of them, read the append-only consent
  history, and delete their account. Deletion is a soft delete: `status='DELETED'`,
  `deleted_at` set, direct identifiers cleared, addresses and push tokens removed, consents
  revoked and sessions killed. It is blocked while the customer has an active booking.
- Multi-salon resolution now includes active `staff_members.user_id` rows after owned salons,
  so manager/staff logins resolve to a salon and can use partner routes.

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
