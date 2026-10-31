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
npm run smoke          # 20 end-to-end checks
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
- All routes are versioned under `/api/v1` and errors use `{ error: { code, message } }`.

## Status

Implemented and verified: OTP auth, discovery search, availability, 5-minute slot holds,
booking lifecycle, POS invoicing with GST and commission split, salon CRM, retention
reminder scheduling, walk-in queue, reviews, admin KYC/commission management. The web app
and the Expo app both run against the live API.

Not implemented (external integrations by design): OpenSearch, BullMQ/n8n workers, actual
WhatsApp/SMS delivery, S3 uploads and the payment gateway.

See `salon-api/README.md` and `salon-web/README.md` for details.
