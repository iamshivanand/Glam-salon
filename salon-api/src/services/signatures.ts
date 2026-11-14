import crypto from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Twilio request signature: HMAC-SHA1 over the exact callback URL + sorted form fields. */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string | undefined>,
  signature: string | undefined,
  authToken: string | undefined,
): boolean {
  if (!signature || !authToken) return false;
  const data = Object.keys(params)
    .filter((key) => params[key] !== undefined)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64');
  return safeEqual(expected, signature);
}

/** Generic hex HMAC-SHA256 check used by Meta and internal webhooks. */
export function verifyHmacSha256(rawBody: string, secret: string | undefined, signature: string | undefined): boolean {
  if (!secret || !signature) return false;
  const received = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(expected, received);
}

/** Razorpay checkout callback signature: HMAC-SHA256(order_id|payment_id). */
export function verifyRazorpayPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string | undefined,
): boolean {
  if (!keySecret) return false;
  const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqual(expected, signature);
}

/** Razorpay webhook signature: HMAC-SHA256 over the raw request body. */
export function verifyRazorpayWebhook(rawBody: string, signature: string | undefined, secret: string | undefined): boolean {
  return verifyHmacSha256(rawBody, secret, signature);
}

export { safeEqual };
