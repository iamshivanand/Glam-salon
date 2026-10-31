# Glam Connect — Mobile (Expo + NativeBase)

Customer booking app and owner console for the live `salon-api`. No mock data: every screen
reads and writes through `/api/v1` with a bearer token.

## Run

Start the API first (see `../salon-api/README.md`), then:

```powershell
cd salon-mobile
npm install
Copy-Item .env.example .env
npx expo start
# scan the QR with Expo Go, or press a / i
```

`EXPO_PUBLIC_API_URL` must point at the API from the device's point of view:

| Where the app runs | URL                                    |
| ------------------ | -------------------------------------- |
| Android emulator   | `http://10.0.2.2:4000/api/v1`          |
| iOS simulator      | `http://localhost:4000/api/v1`         |
| Physical phone     | `http://<your-lan-ip>:4000/api/v1`     |

The default in `api.ts` is `http://localhost:4000/api/v1`. This app is verified with
`npm run typecheck` and an Android Metro export; use the Next.js app in `salon-web` for the
browser.

## Signing in

There are no passwords. The header button opens an OTP sheet; in development the API returns
the code and the sheet fills it in.

| Role           | Phone           |
| -------------- | --------------- |
| Customer       | `+919800000002` |
| Salon owner    | `+919800000001` |

The sheet also has one-tap chips for these demo accounts.

## Tabs

| Tab     | What it does                                                                 |
| ------- | ---------------------------------------------------------------------------- |
| Home    | Live salons near Indiranagar, ratings, walk-in queue, popular services, artists |
| Book    | Salon → services → artist/date/time → confirm. 5-minute hold, OTP gate, booking code + check-in PIN |
| Visits  | Customer booking history, statuses, check-in PIN, cancel                     |
| Admin   | Owner-gated: 30-day revenue, retention, reminder conversion, revenue by artist, live queue, day book with check-in and POS billing (UPI / cash) |

Booking works while signed out: choosing a slot and tapping **Sign in & confirm** opens the
OTP sheet and, once verified, automatically completes the hold and booking.

## Notes

- Money arrives as integer **paise** and is formatted with `rupees()` (Indian grouping, no Intl
  dependency). Timestamps are rendered in **Asia/Kolkata** by `istTime` / `istDateTime`.
- Sessions live in memory only (`store.ts`). Closing the app signs you out; persisting the
  token would need `expo-secure-store`, which is not installed.
- `api.ts` is the whole network layer: OTP, discovery, availability, hold/create/cancel,
  partner dashboard, day book, queue, status transitions and invoicing.
- Charts are plain progress bars rather than Victory, so there is no extra native dependency.
