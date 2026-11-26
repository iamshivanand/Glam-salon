import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { one, query, tx, withUser } from '../db.js';
import { redis, rateLimit } from '../redis.js';
import { blindIndex, encrypt, decrypt, maskPhone, otpCode, hashOtp, uuid, sha256 } from '../crypto.js';
import { AppError, parse, badRequest, unauthorized, notFound, conflict, forbidden } from '../http.js';
import { authenticate, issueTokens, rotateRefresh, revokeAllRefreshForUser, revokeRefresh, salonIdForUser } from '../auth.js';
import { env, devReturnOtp, isDev } from '../env.js';
import { sendOtpCode } from '../services/notifications.js';

import { isValidPhone, normalizePhone } from '../phone.js';
import { presignGet, publicUrlFor } from '../services/storage.js';

export { normalizePhone } from '../phone.js';
const PHONE_RE = /^\+[1-9]\d{9,14}$/;

const OtpRequest = z.object({ phone: z.string().min(8).max(20) });
const OtpVerify = z.object({
  challenge_id: z.string().min(8),
  otp: z.string().regex(/^\d{6}$/),
  full_name: z.string().min(1).max(120).optional(),
  device_fingerprint: z.string().max(255).optional(),
});

const ProfileUpdate = z.object({
  full_name: z.string().min(1).max(120).optional(),
  email: z.string().email().max(255).optional(),
  gender: z.string().max(32).optional(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  emergency_contacts: z.array(z.object({ name: z.string(), phone: z.string() })).max(5).optional(),
});

const ConsentUpdate = z.object({
  channel: z.enum(['WHATSAPP', 'SMS', 'PUSH', 'EMAIL']),
  purpose: z.enum(['BOOKING_TRANSACTIONAL', 'RETENTION_REMINDER', 'PROMOTIONAL_OFFERS', 'STYLE_PHOTO_STORAGE']),
  is_granted: z.boolean(),
  salon_id: z.string().uuid().nullish(),
});

const AddressInput = z.object({
  label: z.string().min(1).max(50),
  address_line: z.string().min(3).max(500),
  locality: z.string().min(1).max(120),
  city: z.string().min(1).max(100),
  postal_code: z.string().min(4).max(20),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  is_default: z.boolean().optional(),
});

function setRefreshCookie(reply: any, token: string) {
  reply.setCookie('gc_refresh', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/api/v1/auth',
    maxAge: env.REFRESH_TTL_DAYS * 24 * 60 * 60,
  });
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  const handleOtpRequest = async (req: any, reply: any) => {
    const body = parse(OtpRequest, req.body);
    const phone = normalizePhone(body.phone);
    if (!PHONE_RE.test(phone)) throw badRequest('INVALID_PHONE', 'Enter a valid phone number with country code');

    const ipLimit = await rateLimit(`otp:ip:${req.ip}`, isDev ? 100 : 20, 600);

    if (!ipLimit.allowed) throw new (await import('../http.js')).AppError(429, 'RATE_LIMITED', 'Too many OTP requests. Try again in a few minutes.');
    const phoneLimit = await rateLimit(`otp:phone:${blindIndex(phone)}`, isDev ? 50 : 5, 600);
    if (!phoneLimit.allowed) throw new (await import('../http.js')).AppError(429, 'RATE_LIMITED', 'Too many OTP requests for this number.');

    const challengeId = uuid();
    const code = otpCode();
    await redis.set(
      `otp:${challengeId}`,
      JSON.stringify({ phone, phone_blind_index: blindIndex(phone), hash: hashOtp(challengeId, code), attempts: 0 }),
      'EX',
      300,
    );

    try {
      await sendOtpCode(phone, code);
    } catch (err) {
      await redis.del(`otp:${challengeId}`);
      req.log.error({ err, phone: maskPhone(phone) }, 'otp delivery failed');
      throw new AppError(502, 'OTP_DELIVERY_FAILED', 'Could not send the code right now. Please try again.');
    }

    req.log.info({ phone: maskPhone(phone), channel: env.OTP_CHANNEL }, 'otp issued');
    return {
      challenge_id: challengeId,
      expires_in: 300,
      channel: env.OTP_CHANNEL,
      ...(devReturnOtp ? { dev_otp: code } : {}),
    };
  };

  app.post('/auth/otp/request', handleOtpRequest);
  app.post('/auth/otp/send', handleOtpRequest); // route alias

  app.post('/auth/otp/verify', async (req, reply) => {
    const body = parse(OtpVerify, req.body);
    const raw = await redis.get(`otp:${body.challenge_id}`);
    if (!raw) throw badRequest('OTP_EXPIRED', 'This OTP has expired. Request a new one.');

    const challenge = JSON.parse(raw) as { phone: string; phone_blind_index: string; hash: string; attempts: number };
    if (challenge.attempts >= 5) {
      await redis.del(`otp:${body.challenge_id}`);
      throw badRequest('OTP_LOCKED', 'Too many incorrect attempts. Request a new OTP.');
    }
    if (challenge.hash !== hashOtp(body.challenge_id, body.otp)) {
      challenge.attempts += 1;
      await redis.set(`otp:${body.challenge_id}`, JSON.stringify(challenge), 'EX', 300);
      throw badRequest('INVALID_OTP', 'That code is not correct');
    }
    await redis.del(`otp:${body.challenge_id}`);

    let user = await one(
      `SELECT id, full_name, role, status FROM users WHERE phone_blind_index = $1`,
      [challenge.phone_blind_index],
    );

    if (!user) {
      user = await one(
        `INSERT INTO users (phone_e164_encrypted, phone_blind_index, full_name, role, status, last_login_at)
         VALUES ($1, $2, $3, 'CUSTOMER', 'ACTIVE', NOW())
         RETURNING id, full_name, role, status`,
        [encrypt(challenge.phone), challenge.phone_blind_index, body.full_name ?? 'Glam Guest'],
      );
    } else {
      if (user.status !== 'ACTIVE') throw forbidden('This account is not active. Contact support.');
      await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
    }

    const salonId = await salonIdForUser(user!.id);

    const tokens = await issueTokens(
      { id: user!.id, role: user!.role, salonId },
      { ip: req.ip, deviceFingerprint: body.device_fingerprint },
    );
    setRefreshCookie(reply, tokens.refresh_token);

    return {
      ...tokens,
      user: {
        id: user!.id,
        full_name: user!.full_name,
        role: user!.role,
        salon_id: salonId,
        phone: challenge.phone,
      },
    };
  });

  app.post('/auth/refresh', async (req, reply) => {
    const body = (req.body ?? {}) as { refresh_token?: string };
    const token = body.refresh_token ?? (req.cookies as any)?.gc_refresh;
    if (!token) throw unauthorized('Refresh token missing');
    const tokens = await rotateRefresh(token, req.ip);
    setRefreshCookie(reply, tokens.refresh_token);
    return tokens;
  });

  app.post('/auth/logout', async (req, reply) => {
    const body = (req.body ?? {}) as { refresh_token?: string };
    const token = body.refresh_token ?? (req.cookies as any)?.gc_refresh;
    if (token) await revokeRefresh(token);
    reply.clearCookie('gc_refresh', { path: '/api/v1/auth' });
    return { ok: true };
  });

  // ---- OAuth2 social login (Google / Apple ID-token verification)
  const OAuthCallback = z.object({
    provider: z.enum(['google', 'apple']),
    id_token: z.string().min(1),
    full_name: z.string().min(1).max(120).optional(),
  });

  const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
  const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

  app.post('/auth/oauth/callback', async (req, reply) => {
    const body = parse(OAuthCallback, req.body);

    let email: string | undefined;
    let name: string | undefined;

    if (body.provider === 'google') {
      const clientId = (process.env.GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID)?.trim();
      if (!clientId) throw badRequest('OAUTH_NOT_CONFIGURED', 'Google login is not configured');
      try {
        const { payload } = await jwtVerify(body.id_token, googleJwks, {
          audience: clientId,
          issuer: ['https://accounts.google.com', 'accounts.google.com'],
        });
        email = payload.email as string | undefined;
        name = (payload.name as string | undefined) ?? body.full_name;
      } catch (err: any) {
        throw badRequest('OAUTH_INVALID_TOKEN', `Google token verification failed: ${err.message}`);
      }
    } else {
      const clientId = (process.env.APPLE_CLIENT_ID ?? env.APPLE_CLIENT_ID)?.trim();
      if (!clientId) throw badRequest('OAUTH_NOT_CONFIGURED', 'Apple login is not configured');
      try {
        const { payload } = await jwtVerify(body.id_token, appleJwks, {
          audience: clientId,
          issuer: 'https://appleid.apple.com',
        });
        email = payload.email as string | undefined;
        name = body.full_name;
      } catch (err: any) {
        throw badRequest('OAUTH_INVALID_TOKEN', `Apple token verification failed: ${err.message}`);
      }
    }

    if (!email) throw badRequest('OAUTH_NO_EMAIL', 'The ID token did not include an email address');
    email = email.toLowerCase();

    let user = await one(`SELECT id, full_name, role, status FROM users WHERE email = $1`, [email]);
    if (!user) {
      const placeholderPhone = `oauth_${uuid()}`;
      user = await one(
        `INSERT INTO users (phone_e164_encrypted, phone_blind_index, email, full_name, role, status, last_login_at)
         VALUES ($1, $2, $3, $4, 'CUSTOMER', 'ACTIVE', NOW())
         RETURNING id, full_name, role, status`,
        [encrypt(placeholderPhone), sha256(placeholderPhone), email, name ?? 'Glam Guest'],
      );
    } else {
      if (user.status !== 'ACTIVE') throw forbidden('This account is not active. Contact support.');
      await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
    }

    const salon = await one<{ id: string }>(`SELECT id FROM salons WHERE owner_id = $1 ORDER BY created_at LIMIT 1`, [user!.id]);
    const tokens = await issueTokens({ id: user!.id, role: user!.role, salonId: salon?.id ?? null }, { ip: req.ip });
    setRefreshCookie(reply, tokens.refresh_token);
    return { ...tokens, user: { id: user!.id, full_name: user!.full_name, role: user!.role, salon_id: salon?.id ?? null } };
  });

  const handleGetMe = async (req: any) => {
    const user = await one(
      `SELECT id, full_name, email, role, status, gender, date_of_birth, avatar_s3_key,
              emergency_contacts_json, created_at, phone_e164_encrypted
         FROM users WHERE id = $1`,
      [req.auth!.id],
    );
    if (!user) throw notFound('User not found');
    const rawPhone = decrypt(user.phone_e164_encrypted);
    delete user.phone_e164_encrypted;
    const isPlaceholder = rawPhone.startsWith('oauth_') || rawPhone === 'deleted';
    const phone = isPlaceholder ? '' : rawPhone;
    const phone_masked = isPlaceholder ? 'Not linked' : maskPhone(rawPhone);
    return { ...user, phone_masked, phone };
  };

  app.get('/auth/me', { preHandler: [authenticate] }, handleGetMe);
  app.get('/users/me', { preHandler: [authenticate] }, handleGetMe); // route alias

  app.patch('/users/me', { preHandler: [authenticate] }, async (req) => {
    const body = parse(ProfileUpdate, req.body);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.full_name !== undefined) push('full_name', body.full_name);
    if (body.email !== undefined) {
      const current = await one<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [req.auth!.id]);
      if (current?.email && current.email.toLowerCase() !== body.email.toLowerCase()) {
        throw badRequest('EMAIL_LOCKED', 'Primary email address is verified and locked to your account');
      }
      push('email', body.email.toLowerCase());
    }
    if (body.gender !== undefined) push('gender', body.gender);
    if (body.date_of_birth !== undefined) push('date_of_birth', body.date_of_birth);
    if (body.emergency_contacts !== undefined) push('emergency_contacts_json', JSON.stringify(body.emergency_contacts));
    if (!sets.length) throw badRequest('VALIDATION_ERROR', 'No fields to update');

    params.push(req.auth!.id);
    const user = await one(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, full_name, email, role, status, gender, date_of_birth, emergency_contacts_json`,
      params,
    );
    return user;
  });

  app.get('/users/me/consents', { preHandler: [authenticate] }, async (req) => {
    const rows = await query(
      `SELECT id, salon_id, channel, purpose, is_granted, updated_at
         FROM customer_consents WHERE user_id = $1 ORDER BY purpose, channel`,
      [req.auth!.id],
    );
    return { consents: rows };
  });

  app.post('/users/me/consents', { preHandler: [authenticate] }, async (req) => {
    const body = parse(ConsentUpdate, req.body);
    const row = await one(
      `INSERT INTO customer_consents (user_id, salon_id, channel, purpose, is_granted, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, salon_id, channel, purpose)
       DO UPDATE SET is_granted = EXCLUDED.is_granted, ip_address = EXCLUDED.ip_address
       RETURNING *`,
      [req.auth!.id, body.salon_id ?? null, body.channel, body.purpose, body.is_granted, req.ip],
    );
    await query(
      `INSERT INTO customer_consent_events
         (user_id, salon_id, channel, purpose, is_granted, source, ip_address)
       VALUES ($1,$2,$3,$4,$5,'ACCOUNT',$6)`,
      [req.auth!.id, body.salon_id ?? null, body.channel, body.purpose, body.is_granted, req.ip],
    );
    return row;
  });

  app.get('/users/me/style-vault', { preHandler: [authenticate] }, async (req) => {
    const rows = await withUser(req.auth!.id, (client) =>
      client.query(
        `SELECT c.salon_id, s.name AS salon_name, s.locality,
                c.preferred_staff_id, sm.display_name AS preferred_staff_name,
                c.style_preferences_json, c.reference_photo_s3_keys,
                c.last_visit_at, c.total_visits
           FROM salon_customer_crm c
           JOIN salons s ON s.id = c.salon_id
           LEFT JOIN staff_members sm ON sm.id = c.preferred_staff_id
          WHERE c.customer_id = $1
          ORDER BY c.last_visit_at DESC`,
        [req.auth!.id],
      ),
    ).then((r) => r.rows);

    const consent = await one<{ is_granted: boolean }>(
      `SELECT is_granted FROM customer_consents
        WHERE user_id = $1 AND purpose = 'STYLE_PHOTO_STORAGE'
        ORDER BY salon_id NULLS LAST LIMIT 1`,
      [req.auth!.id],
    );
    const photoConsentGranted = Boolean(consent?.is_granted);

    const vaults = rows.map((r) => {
      const photos: { key: string; url: string }[] = [];
      if (photoConsentGranted && Array.isArray(r.reference_photo_s3_keys)) {
        for (const k of r.reference_photo_s3_keys) {
          try {
            photos.push({ key: k, url: presignGet({ key: k, expiresSec: 300 }).url });
          } catch {
            const pub = publicUrlFor(k);
            if (pub) photos.push({ key: k, url: pub });
          }
        }
      }
      return {
        ...r,
        reference_photos: photos,
        photo_consent_granted: photoConsentGranted,
      };
    });

    return { vaults, photo_consent_granted: photoConsentGranted };
  });

  // Ticket 14 (F1.14): Customer loyalty points passbook & ledger history
  app.get('/users/me/loyalty-ledger', { preHandler: [authenticate] }, async (req) => {
    const customerId = req.auth!.id;
    const q = req.query as { bucket?: string };
    const bucket = q.bucket ?? 'ALL';

    return withUser(customerId, async (client) => {
      // 1. Get total points and per-salon balances from CRM
      const balancesRes = await client.query<{
        salon_id: string;
        salon_name: string;
        locality: string;
        loyalty_points_balance: number;
        prepaid_purchased_balance_paise: number;
        prepaid_promo_balance_paise: number;
        total_visits: number;
        last_visit_at: string;
      }>(
        `SELECT c.salon_id, s.name AS salon_name, s.locality,
                c.loyalty_points_balance,
                c.prepaid_purchased_balance_paise,
                c.prepaid_promo_balance_paise,
                c.total_visits,
                c.last_visit_at
           FROM salon_customer_crm c
           JOIN salons s ON s.id = c.salon_id
          WHERE c.customer_id = $1
          ORDER BY c.last_visit_at DESC`,
        [customerId],
      );

      const balances = balancesRes.rows;
      const totalPoints = balances.reduce((sum, b) => sum + Number(b.loyalty_points_balance || 0), 0);
      const totalWalletPaise = balances.reduce((sum, b) => sum + Number(b.prepaid_purchased_balance_paise || 0), 0);
      const totalPromoPaise = balances.reduce((sum, b) => sum + Number(b.prepaid_promo_balance_paise || 0), 0);

      // 2. Query itemized transactions from immutable customer_value_ledger
      const entriesRes = await client.query<{
        id: string;
        salon_id: string;
        salon_name: string;
        locality: string;
        invoice_id: string | null;
        invoice_number: string | null;
        bucket: string;
        entry_type: string;
        amount_delta: number;
        balance_after: number;
        notes: string | null;
        created_at: string;
      }>(
        `SELECT cvl.id, cvl.salon_id, s.name AS salon_name, s.locality,
                cvl.invoice_id, inv.invoice_number,
                cvl.bucket, cvl.entry_type, cvl.amount_delta, cvl.balance_after,
                cvl.notes, cvl.created_at
           FROM customer_value_ledger cvl
           JOIN salons s ON s.id = cvl.salon_id
           LEFT JOIN invoices_and_payments inv ON inv.id = cvl.invoice_id
          WHERE cvl.customer_id = $1
            AND ($2::text IS NULL OR cvl.bucket::text = $2)
          ORDER BY cvl.created_at DESC
          LIMIT 100`,
        [customerId, bucket === 'ALL' ? null : bucket],
      );

      return {
        total_points: totalPoints,
        total_wallet_paise: totalWalletPaise,
        total_promo_paise: totalPromoPaise,
        balances,
        entries: entriesRes.rows,
      };
    });
  });

  app.get('/users/me/consents/history', { preHandler: [authenticate] }, async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
    const rows = await query(
      `SELECT id, salon_id, channel, purpose, is_granted, source, created_at
         FROM customer_consent_events
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [req.auth!.id, q.limit ?? 50],
    );
    return { events: rows };
  });

  app.get('/users/me/addresses', { preHandler: [authenticate] }, async (req) => {
    const rows = await query(
      `SELECT id, label, address_line_encrypted, locality, city, postal_code, is_default,
              ST_Y(geo_point::geometry) AS lat, ST_X(geo_point::geometry) AS lng
         FROM user_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
      [req.auth!.id],
    );
    return {
      addresses: rows.map((r) => {
        const line = decrypt(r.address_line_encrypted);
        delete r.address_line_encrypted;
        return { ...r, address_line: line };
      }),
    };
  });

  app.post('/users/me/addresses', { preHandler: [authenticate] }, async (req) => {
    const body = parse(AddressInput, req.body);
    if (body.is_default) {
      await query(`UPDATE user_addresses SET is_default = FALSE WHERE user_id = $1`, [req.auth!.id]);
    }
    const row = await one(
      `INSERT INTO user_addresses
         (user_id, label, address_line_encrypted, locality, city, postal_code, geo_point, is_default)
       VALUES ($1,$2,$3,$4,$5,$6, ST_SetSRID(ST_MakePoint($7,$8),4326)::geography, $9)
       RETURNING id, label, locality, city, postal_code, is_default,
                 ST_Y(geo_point::geometry) AS lat, ST_X(geo_point::geometry) AS lng`,
      [
        req.auth!.id,
        body.label,
        encrypt(body.address_line),
        body.locality,
        body.city,
        body.postal_code,
        body.lng,
        body.lat,
        body.is_default ?? false,
      ],
    );
    return { ...row, address_line: body.address_line };
  });

  // ---- Edit address
  const AddressUpdate = z.object({
    label: z.string().min(1).max(50).optional(),
    address_line: z.string().min(3).max(500).optional(),
    locality: z.string().min(1).max(120).optional(),
    city: z.string().min(1).max(100).optional(),
    postal_code: z.string().min(4).max(20).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    is_default: z.boolean().optional(),
  });

  app.patch('/users/me/addresses/:id', { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(AddressUpdate, req.body);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, value: unknown) => { params.push(value); sets.push(`${col} = $${params.length}`); };
    if (body.label !== undefined) push('label', body.label);
    if (body.address_line !== undefined) push('address_line_encrypted', encrypt(body.address_line));
    if (body.locality !== undefined) push('locality', body.locality);
    if (body.city !== undefined) push('city', body.city);
    if (body.postal_code !== undefined) push('postal_code', body.postal_code);
    if (body.is_default !== undefined) {
      if (body.is_default) await query(`UPDATE user_addresses SET is_default = FALSE WHERE user_id = $1`, [req.auth!.id]);
      push('is_default', body.is_default);
    }
    if (body.lat !== undefined && body.lng !== undefined) {
      params.push(body.lng, body.lat);
      sets.push(`geo_point = ST_SetSRID(ST_MakePoint($${params.length - 1},$${params.length}),4326)::geography`);
    }
    if (!sets.length) throw badRequest('VALIDATION_ERROR', 'No fields to update');
    params.push(id, req.auth!.id);
    const row = await one(
      `UPDATE user_addresses SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING id, label, locality, city, postal_code, is_default,
                 ST_Y(geo_point::geometry) AS lat, ST_X(geo_point::geometry) AS lng`,
      params,
    );
    if (!row) throw notFound('Address not found');
    return row;
  });

  app.delete('/users/me/addresses/:id', { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const deleted = await query(`DELETE FROM user_addresses WHERE id = $1 AND user_id = $2 RETURNING id`, [
      id,
      req.auth!.id,
    ]);
    if (!deleted.length) throw notFound('Address not found');
    return { ok: true };
  });

  // ---- DPDP Account Deletion & Anonymization
  const DeleteAccount = z.object({ confirmation: z.literal('DELETE_MY_ACCOUNT') });

  app.post('/users/me/privacy/delete', { preHandler: [authenticate] }, async (req) => {
    const body = parse(DeleteAccount, req.body);
    const userId = req.auth!.id;
    await tx(async (client) => {
      await client.query(
        `UPDATE users SET status = 'DELETED', full_name = 'Deleted User', email = NULL,
                phone_e164_encrypted = $1, phone_blind_index = $2,
                gender = NULL, date_of_birth = NULL, emergency_contacts_json = '[]'
         WHERE id = $3`,
        [encrypt('deleted'), sha256(`deleted_${userId}`), userId],
      );
      await client.query(`DELETE FROM user_addresses WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM customer_consents WHERE user_id = $1`, [userId]);
      await client.query(`UPDATE user_refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    });
    return { status: 'ANONYMIZATION_SCHEDULED', purge_eta_hrs: 24 };
  });

  app.get('/users/me/sessions', { preHandler: [authenticate] }, async (req) => {
    const rows = await query(
      `SELECT id, device_fingerprint, host(ip_address) AS ip_address, expires_at, created_at
         FROM user_refresh_tokens
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.auth!.id],
    );
    return { sessions: rows };
  });

  app.post('/users/me/sessions/revoke-all', { preHandler: [authenticate] }, async (req, reply) => {
    const revoked = await revokeAllRefreshForUser(req.auth!.id);
    reply.clearCookie('gc_refresh', { path: '/api/v1/auth' });
    return { revoked };
  });

  app.post('/users/me/sessions/:id/revoke', { preHandler: [authenticate] }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const rows = await query<{ id: string }>(
      `UPDATE user_refresh_tokens
          SET revoked_at = NOW()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [id, req.auth!.id],
    );
    if (!rows.length) throw notFound('Session not found');
    return { revoked: 1 };
  });

  /**
   * DPDP data portability: everything tied to this account in one JSON file.
   * Direct identifiers are included because the caller just authenticated as
   * the owner; internal blind indexes and token hashes never leave the API.
   */
  app.get('/users/me/export', { preHandler: [authenticate] }, async (req) => {
    const userId = req.auth!.id;
    const exportLimit = await rateLimit(`me:export:${userId}`, 5, 600);
    if (!exportLimit.allowed) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many data export requests. Try again later.');
    }

    const profile = await one<Record<string, unknown> & { phone_e164_encrypted: Buffer }>(
      `SELECT * FROM users WHERE id = $1`,
      [userId],
    );
    if (!profile) throw notFound('Account not found');
    const { phone_e164_encrypted, phone_blind_index: _blindIndex, ...rest } = profile;
    const phone = decrypt(phone_e164_encrypted);

    const [addresses, bookings, invoices, reviews, consents] = await Promise.all([
      query(
        `SELECT id, label, locality, city, postal_code, is_default, created_at
           FROM user_addresses WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      ),
      query(
        `SELECT b.booking_code, b.status, b.mode, b.channel,
                b.scheduled_start_at, b.scheduled_end_at,
                b.subtotal_paise, b.discount_paise, b.tax_paise, b.booking_fee_paise,
                b.total_payable_paise, b.customer_notes, b.cancellation_reason, b.created_at,
                s.name AS salon_name, s.locality, s.city,
                COALESCE((
                  SELECT json_agg(json_build_object(
                    'service', bi.service_name_snapshot,
                    'price_paise', bi.unit_price_paise,
                    'duration_mins', bi.duration_mins,
                    'status', bi.status::text
                  ) ORDER BY bi.time_range)
                  FROM booking_items bi WHERE bi.booking_id = b.id
                ), '[]'::json) AS items
           FROM bookings b
           JOIN salons s ON s.id = b.salon_id
          WHERE b.customer_id = $1
          ORDER BY b.created_at DESC`,
        [userId],
      ),
      query(
        `SELECT invoice_number, booking_id, gross_amount_paise, discount_paise,
                tax_paise, net_collected_paise, method, status, created_at
           FROM invoices_and_payments
          WHERE customer_id = $1
          ORDER BY created_at DESC`,
        [userId],
      ),
      query(
        `SELECT booking_id, overall_rating, hygiene_rating, review_text, owner_reply, created_at
           FROM reviews WHERE customer_id = $1 ORDER BY created_at DESC`,
        [userId],
      ),
      query(
        `SELECT salon_id, channel, purpose, is_granted, updated_at
           FROM customer_consents WHERE user_id = $1 ORDER BY updated_at DESC`,
        [userId],
      ),
    ]);

    return {
      exported_at: new Date().toISOString(),
      profile: { ...rest, phone },
      addresses,
      bookings,
      invoices,
      reviews,
      consents,
    };
  });

  /**
   * DPDP erasure request. The account is soft-deleted so bookings, invoices and
   * audit records keep their referential integrity; direct identifiers are
   * removed and every session is revoked.
   */
  app.delete('/users/me', { preHandler: [authenticate] }, async (req, reply) => {
    const id = req.auth!.id;
    if (req.auth!.role === 'PLATFORM_ADMIN') {
      throw forbidden('Platform admin accounts cannot be deleted from the app');
    }
    const activeBookings = await one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM bookings
        WHERE customer_id = $1 AND status IN ('REQUESTED', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE')`,
      [id],
    );
    if (Number(activeBookings?.count ?? 0) > 0) {
      throw conflict('ACTIVE_BOOKINGS', 'Cancel your upcoming bookings before deleting your account');
    }

    await query(
      `UPDATE users
          SET status = 'DELETED',
              deleted_at = NOW(),
              full_name = 'Deleted user',
              email = NULL,
              avatar_s3_key = NULL,
              emergency_contacts_json = NULL,
              phone_e164_encrypted = $2
        WHERE id = $1`,
      [id, encrypt('')],
    );
    await query(`DELETE FROM user_addresses WHERE user_id = $1`, [id]);
    await query(`DELETE FROM device_push_tokens WHERE user_id = $1`, [id]);
    await query(`UPDATE customer_consents SET is_granted = FALSE WHERE user_id = $1`, [id]);
    await revokeAllRefreshForUser(id);
    reply.clearCookie('gc_refresh', { path: '/api/v1/auth' });
    return { ok: true, deleted_at: new Date().toISOString() };
  });
};
