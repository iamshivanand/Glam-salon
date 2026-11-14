import '../test/setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  safeEqual,
  verifyHmacSha256,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhook,
  verifyTwilioSignature,
} from '../src/services/signatures.js';

test('Twilio signature accepts a correctly signed request', () => {
  const url = 'https://api.example.com/webhooks/twilio/status';
  const params: Record<string, string> = { MessageSid: 'SM123', MessageStatus: 'delivered', To: '+919800000002' };
  const token = 'twilio-auth-token';
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const signature = crypto.createHmac('sha1', token).update(data).digest('base64');

  assert.equal(verifyTwilioSignature(url, params, signature, token), true);
  assert.equal(verifyTwilioSignature(url, { ...params, MessageStatus: 'failed' }, signature, token), false);
  assert.equal(verifyTwilioSignature(url, params, undefined, token), false);
  assert.equal(verifyTwilioSignature(url, params, signature, undefined), false);
});

test('HMAC-SHA256 accepts both bare hex and sha256= prefixed signatures', () => {
  const body = JSON.stringify({ event: 'delivered', id: 'abc' });
  const secret = 'webhook-secret';
  const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(verifyHmacSha256(body, secret, hex), true);
  assert.equal(verifyHmacSha256(body, secret, `sha256=${hex}`), true);
  assert.equal(verifyHmacSha256(`${body} `, secret, hex), false);
  assert.equal(verifyHmacSha256(body, 'other-secret', hex), false);
  assert.equal(verifyHmacSha256(body, secret, undefined), false);
  assert.equal(verifyHmacSha256(body, undefined, hex), false);
});

test('Razorpay payment signature uses order|payment', () => {
  const secret = 'rzp-secret';
  const orderId = 'order_123';
  const paymentId = 'pay_456';
  const signature = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

  assert.equal(verifyRazorpayPaymentSignature(orderId, paymentId, signature, secret), true);
  assert.equal(verifyRazorpayPaymentSignature(orderId, 'pay_other', signature, secret), false);
  assert.equal(verifyRazorpayPaymentSignature(orderId, paymentId, signature, undefined), false);
  assert.equal(verifyRazorpayWebhook('{"event":"payment.captured"}', signature, secret), false);
  assert.equal(
    verifyRazorpayWebhook(
      '{"event":"payment.captured"}',
      `sha256=${crypto.createHmac('sha256', secret).update('{"event":"payment.captured"}').digest('hex')}`,
      secret,
    ),
    true,
  );
});

test('safeEqual rejects length mismatches without throwing', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});
