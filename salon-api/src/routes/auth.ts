import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db.js';
import { redis, rateLimit } from '../redis.js';
import { blindIndex, encrypt, decrypt, maskPhone, otpCode, hashOtp, uuid } from '../crypto.js';
import { parse, badRequest, unauthorized, notFound, conflict, forbidden } from '../http.js';
import { authenticate, issueTokens, rotateRefresh, revokeRefresh } from '../auth.js';
import { env, devReturnOtp } from '../env.js';

const PHONE_RE = /^\+[1-9]\d{9,14}$/;

export function normalizePhone(raw: string): string {
  const trimmed = String(raw ?? '').trim().replace(/[\s()-]/g, '');
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

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

    req.log.info({ phone: maskPhone(phone) }, 'otp issued');
    return {
      challenge_id: challengeId,
      expires_in: 300,
      channel: 'SMS',
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

    const salon = await one<{ id: string }>(`SELECT id FROM salons WHERE owner_id = $1 ORDER BY created_at LIMIT 1`, [
      user!.id,
    ]);

    const tokens = await issueTokens(
      { id: user!.id, role: user!.role, salonId: salon?.id ?? null },
      { ip: req.ip, deviceFingerprint: body.device_fingerprint },
    );
    setRefreshCookie(reply, tokens.refresh_token);

    return {
      ...tokens,
      user: { id: user!.id, full_name: user!.full_name, role: user!.role, salon_id: salon?.id ?? null },
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
    return row;
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
};
