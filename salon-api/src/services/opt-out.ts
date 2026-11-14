/**
 * Inbound opt-out detection. Kept dependency-free so it is cheap to unit test
 * and safe to import from webhook handlers.
 */
const OPT_OUT_WORDS = new Set([
  'stop',
  'unsubscribe',
  'stopall',
  'optout',
  'opt-out',
  'remove me',
  'do not message',
]);

export function isOptOutMessage(body: string | undefined | null): boolean {
  if (!body) return false;
  return OPT_OUT_WORDS.has(body.trim().toLowerCase());
}
