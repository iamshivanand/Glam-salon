# Glam Connect - Unwritten Fixes & Custom Enhancements Log

This document tracks **unexpected bug fixes, custom UI improvements, and architectural safeguards** that were identified and resolved during development which were **not** explicitly part of the baseline ticket specifications.

---

### 1. Custom Luxury Gender Dropdown
* **Observation:** The default profile form used an unstyled HTML text input and then a basic native OS `<select>`, looking out of place in a luxury salon booking app.
* **Fix & Enhancement:** Built a custom React dropdown matching Glam Connect's warm luxury palette (`#2D1B2E`, `#C9A86A`, `rounded-xl`, `border-line`), featuring an animated rotating chevron, option hover states, gold checkmark indicator, and automatic click-outside dismissal.

### 2. Profile Form Input Opacity Bug
* **Observation:** Wrapping inputs inside `<label className="text-xs opacity-60">` caused all child `<input>` elements (Full Name, Email, DOB) to inherit 60% opacity, making typed text look faint and low-contrast.
* **Fix & Enhancement:** Decoupled `<label>` text from input controls across `salon-web/app/account/page.tsx`, ensuring clear contrast and sharp typography.

### 3. Google OAuth Verified Email Lock (Orphan Account Prevention)
* **Observation:** Allowing users to freely edit their email address in the profile settings after signing in with Google meant that subsequent Google logins would fail to locate the existing user (`WHERE email = $1`), creating orphaned duplicate accounts. It also allowed entering unverified emails.
* **Fix & Enhancement:**
  * **Frontend:** The email field is marked `disabled` / `read-only` with a `Verified & locked 🔒` badge once set via Google OAuth.
  * **Backend:** In `PATCH /users/me`, attempting to overwrite an already verified email returns `400 Bad Request (EMAIL_LOCKED)`.

### 4. Database Constraint Protection for OAuth Registrations
* **Observation:** PostgreSQL `users` table requires `phone_e164_encrypted` and `phone_blind_index` to be `NOT NULL` and `UNIQUE`. Direct Google signups with no initial phone number would crash with a DB constraint violation.
* **Fix & Enhancement:** In `POST /auth/oauth/callback`, securely generates a unique placeholder index `oauth_${uuid()}`. In `GET /auth/me`, safely decrypts and exposes `phone_masked: 'Not linked'` instead of corrupt/raw placeholder strings.

### 5. Development OTP Rate-Limit Safety
* **Observation:** Production rate limit of 5 OTP requests per 10 minutes caused developers to get locked out while testing locally.
* **Fix & Enhancement:** Relaxed rate limit during development mode (`isDev ? 50 : 5`) in `salon-api/src/routes/auth.ts`, preserving strict production security while ensuring uninterrupted local QA.
