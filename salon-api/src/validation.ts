/**
 * Indian business identifier formats. Kept dependency-free so the API and the
 * unit tests share one definition.
 */

export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
// 2-digit state code, 5-letter name, 4 digits, entity letter, entity number,
// literal Z, checksum character.
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
// 4-letter bank code, literal 0, 6-char branch code.
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function normalizeCode(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

export function isValidPan(value: string): boolean {
  return PAN_PATTERN.test(normalizeCode(value));
}

export function isValidGstin(value: string): boolean {
  return GSTIN_PATTERN.test(normalizeCode(value));
}

export function isValidIfsc(value: string): boolean {
  return IFSC_PATTERN.test(normalizeCode(value));
}

export function panError(value: string): string | null {
  return isValidPan(value) ? null : 'PAN must look like ABCDE1234F';
}

export function gstinError(value: string): string | null {
  return isValidGstin(value) ? null : 'GSTIN must be a 15-character GST number';
}

export function ifscError(value: string): string | null {
  return isValidIfsc(value) ? null : 'IFSC must look like HDFC0001234';
}
