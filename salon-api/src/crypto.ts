import crypto from 'node:crypto';
import { env } from './env.js';

const encKey = Buffer.from(env.PHONE_ENC_KEY, 'hex');

/** HMAC-SHA256 blind index for O(1) lookup on encrypted phone numbers. */
export function blindIndex(phone: string): string {
  return crypto.createHmac('sha256', env.PHONE_PEPPER).update(phone).digest('hex');
}

/** AES-256-GCM. Output layout: iv(12) | tag(16) | ciphertext. */
export function encrypt(text: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

export function decrypt(payload: Buffer): string {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const data = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function otpCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashOtp(challengeId: string, otp: string): string {
  return crypto.createHmac('sha256', env.PHONE_PEPPER).update(`${challengeId}:${otp}`).digest('hex');
}

export function maskPhone(phone: string): string {
  if (phone.length < 6) return '****';
  return `${phone.slice(0, 3)}******${phone.slice(-4)}`;
}

export function bookingCode(): string {
  const year = new Date().getUTCFullYear();
  const n = crypto.randomInt(0, 10_000);
  return `GC-${year}-${String(n).padStart(4, '0')}`;
}

export function checkinPin(): string {
  return String(crypto.randomInt(0, 10_000)).padStart(4, '0');
}

export function uuid(): string {
  return crypto.randomUUID();
}
