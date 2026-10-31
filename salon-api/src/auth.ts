import { SignJWT, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import { env } from './env.js';
import { one, query } from './db.js';
import { randomToken, sha256, uuid } from './crypto.js';
import { forbidden, unauthorized } from './http.js';
import type { AuthUser, UserRole } from './types.js';

const secret = new TextEncoder().encode(env.JWT_SECRET);

export async function signAccessToken(user: AuthUser): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: user.role, salon_id: user.salonId ?? null })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(now + env.JWT_ACCESS_TTL_SEC)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AuthUser> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (!payload.sub) throw new Error('missing sub');
    return {
      id: payload.sub,
      role: payload.role as UserRole,
      salonId: (payload.salon_id as string | null) ?? null,
    };
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
}

export interface IssuedTokens {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

export async function issueTokens(
  user: AuthUser,
  meta: { ip?: string; deviceFingerprint?: string; familyId?: string } = {},
): Promise<IssuedTokens> {
  const access_token = await signAccessToken(user);
  const refresh_token = randomToken(32);
  const familyId = meta.familyId ?? uuid();
  const expiresAt = new Date(Date.now() + env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO user_refresh_tokens
       (user_id, token_family_id, token_hash, device_fingerprint, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user.id, familyId, sha256(refresh_token), meta.deviceFingerprint ?? null, meta.ip ?? null, expiresAt],
  );

  return { access_token, expires_in: env.JWT_ACCESS_TTL_SEC, refresh_token };
}

export async function rotateRefresh(rawToken: string, ip?: string): Promise<IssuedTokens> {
  const row = await one(
    `SELECT * FROM user_refresh_tokens WHERE token_hash = $1`,
    [sha256(rawToken)],
  );
  if (!row) throw unauthorized('Invalid refresh token');

  // Reuse of a revoked token means the family may be compromised.
  if (row.revoked_at) {
    await query(
      `UPDATE user_refresh_tokens SET revoked_at = NOW()
        WHERE token_family_id = $1 AND revoked_at IS NULL`,
      [row.token_family_id],
    );
    throw unauthorized('Refresh token reuse detected; all sessions revoked');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) throw unauthorized('Refresh token expired');

  await query(`UPDATE user_refresh_tokens SET revoked_at = NOW() WHERE id = $1`, [row.id]);

  const user = await one(`SELECT id, role FROM users WHERE id = $1 AND status = 'ACTIVE'`, [row.user_id]);
  if (!user) throw unauthorized('User not found');

  const salon = await one(`SELECT id FROM salons WHERE owner_id = $1 LIMIT 1`, [user.id]);
  return issueTokens(
    { id: user.id, role: user.role as UserRole, salonId: salon?.id ?? null },
    { familyId: row.token_family_id, deviceFingerprint: row.device_fingerprint ?? undefined, ip },
  );
}

export async function revokeRefresh(rawToken: string): Promise<void> {
  await query(
    `UPDATE user_refresh_tokens SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sha256(rawToken)],
  );
}

export async function authenticate(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  req.auth = await verifyAccessToken(header.slice(7));
}

export function requireRole(...roles: UserRole[]) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.auth) throw unauthorized();
    if (!roles.includes(req.auth.role)) throw forbidden(`Requires role: ${roles.join(' or ')}`);
  };
}

export async function salonIdForUser(userId: string): Promise<string | null> {
  const salon = await one(`SELECT id FROM salons WHERE owner_id = $1 ORDER BY created_at LIMIT 1`, [userId]);
  return salon?.id ?? null;
}
