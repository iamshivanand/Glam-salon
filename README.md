# Glam Connect

Salon discovery, booking and partner-operations platform. This repository is the Phase 1
build: a real PostgreSQL-backed API, a Next.js customer + partner web app wired to it, shared
contracts, and an Expo mobile prototype.

```
Salon/
├─ docker-compose.yml     Postgres 16 + PostGIS (5433) and Redis 7 (6380)
├─ salon-api/             Fastify 5 + pg + Redis API, SQL migrations, seed, smoke test
├─ salon-web/             Next.js 14 app — customer booking flow and owner console
├─ salon-contracts/       Shared TypeScript types (package: @glamconnect/contracts)
└─ salon-mobile/          Expo app wired to the same API (customer booking + owner console)
```

## Quick start

```powershell
docker compose up -d

cd salon-api
Copy-Item .env.example .env
npm install
npm run migrate
npm run seed
npm run dev            # http://localhost:4000

# in a second terminal
cd salon-web
Copy-Item .env.local.example .env.local
npm install
npm run dev            # http://localhost:3000

# optional: Expo app (needs the API above)
cd ..\salon-mobile
Copy-Item .env.example .env
npm install
npx expo start
```

Verify the backend:

```powershell
cd salon-api
npm run smoke          # 36 end-to-end checks
```

## Demo accounts

Sign-in is phone + OTP. In development the API returns the OTP and the web modal fills it in.

| Role           | Phone           |
| -------------- | --------------- |
| Salon owner    | `+919800000001` |
| Customer       | `+919800000002` |
| Customer       | `+919800000003` |
| Customer       | `+919800000004` |
| Platform admin | `+919800000009` |

## Conventions

- Money is integer **paise** end to end; the UI formats with `rupees()`.
- Timestamps are stored UTC and rendered in **Asia/Kolkata**.
- Booking creation and invoicing require an `Idempotency-Key`.
- The API connects as the least-privilege `glam_app` role; CRM and reminder tables are
  protected by `FORCE ROW LEVEL SECURITY` and a per-request `app.current_salon_id` GUC.
- Refund and payout records are tenant-isolated the same way, and refunds are idempotent on
  `Idempotency-Key`.
- All routes are versioned under `/api/v1` and errors use `{ error: { code, message } }`.
- Notifications go through one provider layer. `NOTIFICATION_PROVIDER=auto` wires Twilio
  SMS/WhatsApp, Meta WhatsApp Cloud, Resend email and/or a generic webhook from credentials
  in `salon-api/.env`. Development and CI fall back to the console provider, which is
  refused in production unless explicitly allowed.

## Status

Implemented and verified: OTP auth with single-flight token refresh on web and Expo,
discovery search, availability, 5-minute slot holds, booking lifecycle, POS invoicing with
GST and commission split, salon CRM, retention reminder scheduling and provider-backed
dispatch with click tracking, conversion attribution, delivery receipts, opt-outs and retries,
walk-in queue, customer reviews with trigger-maintained rating aggregates, owner review
replies, multi-salon switching, customer account settings, owner onboarding/KYC, platform
admin KYC/commission console, transactional booking/queue/invoice messages, and partner
settlements. The web app and the Expo app both run against the live API.

The hardening pass adds: validated PAN/GSTIN/IFSC with correct KYC resubmission state, a
registry-backed two-step upload flow (declared type/size signed into the URL, HEAD verification
at confirm), idempotent refunds with a ledger and audit trail, manually recorded settlement
payouts, platform admin salon/user controls with an append-only audit log, customer account
deletion plus consent history and session management, and Expo push registration on mobile.

Implemented but **not verified** here because no credentials are configured: real Twilio,
Meta WhatsApp Cloud and Resend delivery, Razorpay payments/refunds, and S3 uploads. Local and
CI runs use the console notification provider, `PAYMENT_PROVIDER=manual` (records intent
only) and report storage as unconfigured. Nothing in the UI claims a message or payment was
delivered when the provider was not configured.

GitHub Actions (`.github/workflows/ci.yml`) runs typechecks, API unit tests and the
production web build, then migrates, seeds and smoke-tests a PostGIS + Redis stack on every
push. `.github/workflows/release.yml` builds and pushes API/web images to GHCR on a `v*` tag.

Still not implemented: OpenSearch, BullMQ/n8n workers, a durable reminder queue (dispatch is
an in-process interval or `npm run dispatch`), and real vendor delivery/payment/storage
execution without credentials. The mobile app now requests push permission after login and
registers an Expo token, but it has not been exercised on a physical device or emulator here.

See `salon-api/README.md`, `salon-web/README.md` and `ops/README.md` for details.

## Production

Production images, migrations, health/metrics, backups and the deployment checklist live in
[`ops/README.md`](ops/README.md). Short version:

```bash
docker build -t glam-api ./salon-api
docker build -t glam-web --build-arg NEXT_PUBLIC_API_URL=https://api.example.com/api/v1 ./salon-web
docker run --rm --env-file .env glam-api node dist/scripts/migrate.js
docker compose -f docker-compose.prod.yml up -d
```

`GET /health` reports dependency and provider status; `GET /metrics` exposes Prometheus
counters. Nightly dumps: `./ops/backup.sh` (Linux) or `./ops/backup.ps1` (Windows).

