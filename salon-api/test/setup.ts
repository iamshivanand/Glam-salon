/**
 * Test bootstrap. Imported first by every unit test so `env.ts` parses with
 * safe defaults even when no local `.env` exists (e.g. CI).
 *
 * These are placeholders for pure-function tests only. No connection is made.
 */
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://glam_app:glam_app_pw@127.0.0.1:5433/glamconnect';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6380';
process.env.JWT_SECRET ??= 'test-secret-that-is-long-enough';
process.env.PHONE_ENC_KEY ??= 'a'.repeat(64);
process.env.PHONE_PEPPER ??= 'test-pepper';
