# Glam Connect - Additional Implementations & Enhancements Log

This document tracks all extra features, UI/UX polish, bug fixes, and architectural enhancements implemented beyond the baseline ticket descriptions. It serves as an audit trail for the team and senior reviewers.

---

## Ticket 1: F1.01 – Customer Authentication, Profile & Privacy Management

### 1. Custom Luxury Gender Dropdown
* **Original Spec:** Ticket accepts `gender: string` in profile payload.
* **Problem:** Scaffold used an unstyled HTML text input and then a native `<select>` which rendered with browser default styling, clashing with the luxury design of the app.
* **Enhancement:** Built a custom React dropdown matching Glam Connect's design language:
  * Styled with warm palette (`#2D1B2E`, `#C9A86A`, `rounded-xl`, `border-line`).
  * Smooth animated rotating chevron.
  * Floating popover with option hover highlights and active gold checkmark (`✓`).
  * Automatic click-outside dismissal (`useEffect` with `mousedown` listener).

### 2. Profile Form Input Opacity Bug Fix
* **Problem:** Wrapping inputs inside `<label className="text-xs opacity-60">` caused all child `<input>` elements (Full Name, Email, DOB) to inherit 60% opacity, making typed text look faint and washed out.
* **Enhancement:** Decoupled `<label>` text from input controls across `salon-web/app/account/page.tsx`, restoring full readability and sharp typography.

### 3. Google Identity Services (GSI) Frontend Client Integration
* **Original Spec:** Blueprint specified backend `POST /api/v1/auth/oauth/callback` (API-03).
* **Enhancement:** Implemented the full client-side integration in `salon-web/components/auth-modal.tsx`:
  * Dynamically loads Google's official GSI client SDK (`accounts.google.com/gsi/client`).
  * Mounts responsive Google Sign-In button and One-Tap prompt.
  * Integrated `loginWithOAuth()` into the Zustand auth store (`salon-web/lib/store.ts`) to handle session token exchange and query revalidation seamlessly.

### 4. Verified Email Protection & Account Orphan Prevention
* **Problem:** If a user signed in via Google and then edited their email to an arbitrary or typo string in the profile form:
  * Subsequent Google logins would fail to locate the existing user (`WHERE email = $1`), resulting in duplicate orphaned accounts.
  * An unverified email could be attached to an account without ownership proof.
* **Enhancement:**
  * **Frontend:** The email field is marked `disabled` / `read-only` with a `Verified & locked 🔒` badge once populated via Google OAuth.
  * **Backend:** In `PATCH /users/me`, attempting to overwrite an existing verified email returns `400 Bad Request (EMAIL_LOCKED)`. *(Unset emails from phone-only signups can still be set once).*

### 5. Database Constraint Safety for OAuth Registrations
* **Problem:** PostgreSQL `users` table requires `phone_e164_encrypted` and `phone_blind_index` to be `NOT NULL` and `UNIQUE`. Direct Google signups with no initial phone number would crash on insert.
* **Enhancement:** In `POST /auth/oauth/callback`, generates a secure placeholder index `oauth_${uuid()}`. In `GET /auth/me`, safely decrypts and exposes `phone_masked: 'Not linked'` instead of corrupt/raw placeholder strings.

### 6. Development OTP Rate-Limit Safety
* **Problem:** Production rate limit of 5 OTP requests per 10 minutes caused local developers to get locked out while testing.
* **Enhancement:** Relaxed rate limit during development mode (`isDev ? 50 : 5`) in `salon-api/src/routes/auth.ts`, preserving strict production security while ensuring uninterrupted local QA.

### 7. Saved Address Editing (`PATCH /users/me/addresses/:id`)
* **Original Spec:** Only create and delete addresses were present.
* **Enhancement:** Added `PATCH /users/me/addresses/:id` in backend, `useUpdateAddress` React Query mutation hook in `lib/api.ts`, and an "Edit" button in `salon-web/app/account/page.tsx` allowing customers to update existing addresses without deleting and recreating them.

### 8. API Backward-Compatibility Route Aliases
* **Enhancement:** Maintained compatibility aliases so older client calls or mobile app versions do not break:
  * `POST /auth/otp/send` ➔ `POST /auth/otp/request`
  * `GET /users/me` ➔ `GET /auth/me`

---

## Ticket 2: F1.02 – Hyperlocal Salon Discovery & Marketplace Search

### 1. API-09 Blueprint Route Alias
* **Original Spec:** Blueprint defines `API-09 – GET /api/v1/discovery/salons`, whereas the original route was mounted at `/discovery/search`.
* **Enhancement:** Registered `GET /discovery/salons` alongside `/discovery/search` in `salon-api/src/routes/discovery.ts`. Both routes share the same handler, fulfilling API-09 while keeping existing frontend queries intact.

### 2. Sponsored Salon Prioritization
* **Original Spec:** "Include sponsored salon listing support for future extensibility."
* **Enhancement:** Updated the query ordering in `salon-api/src/services/discovery.ts` to include `s.is_sponsored DESC`, ensuring sponsored salons naturally rank at the top while respecting sub-sorting by distance, rating, or price.

### 3. OpenSearch & PostGIS Architecture Rationale
* **Decision:** Leveraged PostgreSQL 16 + PostGIS (`ST_DWithin`, `ST_Distance`) and relational multi-table text search (`salons`, `salon_services`, `staff_members`) directly.
* **Benefit:** Provides sub-millisecond query performance for Phase 1 without requiring the maintenance, memory overhead, or Docker orchestration of a separate OpenSearch cluster.

---

*(Will be updated continuously as we implement F1.03 through F1.15)*
