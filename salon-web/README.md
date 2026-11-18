# Glam Connect — Web (Next.js 14)

Responsive customer booking flow and salon partner console, wired to the live
`salon-api` backend. No mock data, no Next.js API routes — the browser talks straight to
`/api/v1` with a bearer token.

## Run

The API must be running first (see `../salon-api/README.md`).

```powershell
cd salon-web
npm install
Copy-Item .env.local.example .env.local   # if you don't have one
npm run dev                               # http://localhost:3000
```

`.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
```

Production build:

```powershell
npm run build
npm start
```

## Signing in

There are no passwords. Every entry point opens an OTP modal; in dev the API returns the
code and the modal fills it in for you.

| Role           | Phone           |
| -------------- | --------------- |
| Customer       | `+919800000002` |
| Salon owner    | `+919800000001` |
| Platform admin | `+919800000009` |

## Pages

| Route              | What it does                                                                 |
| ------------------ | ---------------------------------------------------------------------------- |
| `/`                | Live discovery near Indiranagar, salon cards, popular services, artists, reviews |
| `/services`        | Full catalogue for the selected salon, grouped by category, add to booking    |
| `/book`            | 3-step flow: services → artist/date/time → pay mode → confirm (OTP gate + 5-min hold); `?salon=<id>&ref=<token>` deep links select the salon and credit the reminder |
| `/appointments`    | Customer booking history, statuses, cancel, check-in PIN, post-visit reviews  |
| `/account`         | Profile, avatar upload, consent history, saved addresses, sessions, payment history and account deletion |
| `/onboarding`      | Owner salon creation, store details, validated licence upload, KYC submission |
| `/admin`           | Partner overview: revenue, retention, reminder conversion, live queue, day book |
| `/admin/calendar`  | Day view bucketed into morning/afternoon/evening (Asia/Kolkata)              |
| `/admin/bookings`  | Day book with status transitions and POS collection (UPI / cash)             |
| `/admin/crm`       | Customer list with segment filters, visit history and loyalty ledger          |
| `/admin/reviews`   | Review inbox, low-score alerts and public owner replies                      |
| `/admin/reminders` | Retention funnel (scheduled/sent/delivered/opened/clicked/converted), consent-aware send, manual dispatch and per-row delivery status |
| `/admin/invoices`  | Collected bills with tax, commission and partner settlement totals           |
| `/admin/settlements` | Captured invoice days, commission, partner payout, recorded payouts, online payment attempts and refunds |
| `/admin/services`  | Add services, publish/hide, pricing in paise rendered as ₹                    |
| `/admin/staff`     | Add artists, view working days, apply a Mon–Sat schedule                     |
| `/admin/resources` | Rooms, chairs and stations that bookable services depend on                  |
| `/platform`        | Platform-admin KYC review queue + document view, salon pause/activate, user role/status controls, payout recording and audit log |

`/admin/*` is guarded by `components/partner-gate.tsx`; a customer session sees a
"switch account" prompt instead of the console. Owners with more than one salon get a
switcher in the admin sidebar; the choice is stored as `gc_active_salon` and sent as
`X-Salon-Id` on every request.

## How it fits together

- `lib/api.ts` — typed fetch client, `ApiError`, `rupees()` paise formatter, and all
  React Query hooks (`useSalonSearch`, `useAvailability`, `useHold`, `useCreateBooking`,
  `usePartnerDashboard`, …). Attaches the bearer token and a generated `Idempotency-Key`
  for booking creation and invoicing. A 401 triggers one single-flight refresh through the
  HttpOnly `gc_refresh` cookie and then retries the original request.
- `lib/store.ts` — Zustand stores: persisted auth session (`gc_session`), persisted booking
  draft (`gc_booking`), and auth-modal state. Hydration is tracked so guards don't flash.
- `components/auth-modal.tsx` — OTP request/verify with the dev OTP surfaced inline.
- `components/partner-gate.tsx` — role gate for the owner console.
- `lib/images.ts` — stable Unsplash imagery keyed by category, since the API stores S3 keys
  that aren't wired to a bucket yet.
- `uploadFile()` in `lib/api.ts` runs the two-step upload: presign with a declared type and
  size, `PUT` the bytes directly to storage, then confirm so the API can HEAD the object and
  verify what was actually stored. Without `S3_*` credentials the API returns `503` and the UI
  reports storage as unconfigured instead of pretending the upload worked.
- Refunds send a fresh `Idempotency-Key`, so retrying a failed request cannot refund twice.
- Payouts are recorded by the platform team; the settlements page shows the computed partner
  net and the transfers that were actually recorded.

## Notes

- Money arrives as integer paise and is rendered with `rupees()`; never divide in components.
- Dates are displayed with `timeZone: 'Asia/Kolkata'`.
- The active salon is sent as `X-Salon-Id`; the sidebar switcher invalidates queries on change.
- Reminder rows show the provider receipt or `last_error`. Unless Twilio/WhatsApp/Resend
  credentials are configured in `salon-api/.env`, the API uses its console provider; the UI
  is honest about receipts, not about carrier delivery.
- Online payment works only when `PAYMENT_PROVIDER=razorpay` and keys are set. With
  `manual`, `/book` records pay-at-salon intent and says so.
