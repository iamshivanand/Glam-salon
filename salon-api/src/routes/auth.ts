import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db.js';
import { redis, rateLimit } from '../redis.js';
import { blindIndex, encrypt, decrypt, maskPhone, otpCode, hashOtp, uuid } from '../crypto.js';
import { AppError, parse, badRequest, unauthorized, notFound, conflict, forbidden } from '../http.js';
import { authenticate, issueTokens, rotateRefresh, revokeAllRefreshForUser, revokeRefresh, salonIdForUser } from '../auth.js';
import { env, devReturnOtp } from '../env.js';
import { sendOtpCode } from '../services/notifications.js';

import { isValidPhone, normalizePhone } from '../phone.js';

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
  app.post('/auth/otp/request', async (req, reply) => {
    const body = parse(OtpRequest, req.body);
    const phone = normalizePhone(body.phone);
    if (!PHONE_RE.test(phone)) throw badRequest('INVALID_PHONE', 'Enter a valid phone number with country code');

    const ipLimit = await rateLimit(`otp:ip:${req.ip}`, 20, 600);
    if (!ipLimit.allowed) throw new (await import('../http.js')).AppError(429, 'RATE_LIMITED', 'Too many OTP requests. Try again in a few minutes.');
    const phoneLimit = await rateLimit(`otp:phone:${blindIndex(phone)}`, 5, 600);
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
  });

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
      user: { id: user!.id, full_name: user!.full_name, role: user!.role, salon_id: salonId },
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

  app.get('/auth/me', { preHandler: [authenticate] }, async (req) => {
    const user = await one(
      `SELECT id, full_name, email, role, status, gender, date_of_birth, avatar_s3_key,
              emergency_contacts_json, created_at, phone_e164_encrypted
         FROM users WHERE id = $1`,
      [req.auth!.id],
    );
    if (!user) throw notFound('User not found');
    const phone = decrypt(user.phone_e164_encrypted);
    delete user.phone_e164_encrypted;
    return { ...user, phone_masked: maskPhone(phone), phone };
  });

  app.patch('/users/me', { preHandler: [authenticate] }, async (req) => {
    const body = parse(ProfileUpdate, req.body);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.full_name !== undefined) push('full_name', body.full_name);
    if (body.email !== undefined) push('email', body.email.toLowerCase());
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

  app.delete('/users/me/addresses/:id', { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const deleted = await query(`DELETE FROM user_addresses WHERE id = $1 AND user_id = $2 RETURNING id`, [
      id,
      req.auth!.id,
    ]);
    if (!deleted.length) throw notFound('Address not found');
    return { ok: true };
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
