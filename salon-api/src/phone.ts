const PHONE_RE = /^\+[1-9]\d{9,14}$/;

/** Normalise a user-entered phone number to E.164. Defaults to India for 10-digit input. */
export function normalizePhone(raw: string): string {
  const trimmed = String(raw ?? '').trim().replace(/[\s()-]/g, '');
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

export function isValidPhone(raw: string): boolean {
  return PHONE_RE.test(normalizePhone(raw));
}
