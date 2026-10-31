# Glam Connect — Mobile (Expo + NativeBase)

Same theme tokens + mock data shapes as web (`../salon-contracts`).

## Run
```powershell
npm install
npx expo start
# scan QR with Expo Go, or press a/i
```

Tabs: Home · Book (4-step wizard) · Visits · Admin (owner-gated, Victory charts: revenue line, category pie, staff bars).

Toggle Customer/Owner top-right. Mock API in `store.ts` (`mockApi`) — swap for `EXPO_PUBLIC_API_URL` fetch calls keeping the same return types.
