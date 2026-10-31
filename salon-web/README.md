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
| `/book`            | 3-step flow: services → artist/date/time → confirm (OTP gate + 5-min hold)    |
| `/appointments`    | Customer booking history, statuses, cancel, check-in PIN on confirmation      |
| `/admin`           | Partner overview: revenue, retention, reminder conversion, live queue, day book |
| `/admin/calendar`  | Day view bucketed into morning/afternoon/evening (Asia/Kolkata)              |
| `/admin/bookings`  | Day book with status transitions and POS collection (UPI / cash)             |
| `/admin/services`  | Add services, publish/hide, pricing in paise rendered as ₹                    |
| `/admin/staff`     | Add artists, view working days, apply a Mon–Sat schedule                     |

`/admin/*` is guarded by `components/partner-gate.tsx`; a customer session sees a
"switch account" prompt instead of the console.

## How it fits together

- `lib/api.ts` — typed fetch client, `ApiError`, `rupees()` paise formatter, and all
  React Query hooks (`useSalonSearch`, `useAvailability`, `useHold`, `useCreateBooking`,
  `usePartnerDashboard`, …). Attaches the bearer token and a generated `Idempotency-Key`
  for booking creation and invoicing.
- `lib/store.ts` — Zustand stores: persisted auth session (`gc_session`), persisted booking
  draft (`gc_booking`), and auth-modal state. Hydration is tracked so guards don't flash.
- `components/auth-modal.tsx` — OTP request/verify with the dev OTP surfaced inline.
- `components/partner-gate.tsx` — role gate for the owner console.
- `lib/images.ts` — stable Unsplash imagery keyed by category, since the API stores S3 keys
  that aren't wired to a bucket yet.

## Notes

- Money arrives as integer paise and is rendered with `rupees()`; never divide in components.
- Dates are displayed with `timeZone: 'Asia/Kolkata'`.
- The `X-Salon-Id` header is not sent: a single owner account owns all three demo salons and
  the API resolves the first one automatically.
