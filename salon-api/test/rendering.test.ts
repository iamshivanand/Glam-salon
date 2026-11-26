import '../test/setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReminderMessage, renderTransactional } from '../src/services/rendering.js';
import { isOptOutMessage } from '../src/services/opt-out.js';

test('transactional copy uses the first name and includes booking facts', () => {
  const msg = renderTransactional('BOOKING_CONFIRMED', {
    customerName: 'Ananya Rao',
    salonName: 'Glam Studio',
    serviceName: 'Hair spa',
    whenLocal: '2026-11-20 16:30',
    bookingCode: 'GC1234',
  });

  assert.match(msg.subject, /Booking confirmed/);
  assert.match(msg.text, /Hi Ananya/);
  assert.match(msg.text, /Hair spa/);
  assert.match(msg.text, /Glam Studio/);
  assert.match(msg.text, /2026-11-20 16:30/);
  assert.match(msg.text, /GC1234/);
  assert.equal(msg.params.length, 5);
  assert.equal(msg.params[0], 'Ananya');
});

test('cancellation copy includes an optional reason', () => {
  const withReason = renderTransactional('BOOKING_CANCELLED', {
    customerName: 'Diya',
    salonName: 'Glow Room',
    reason: 'artist unavailable',
  });
  assert.match(withReason.text, /artist unavailable/);

  const withoutReason = renderTransactional('BOOKING_CANCELLED', {
    customerName: 'Diya',
    salonName: 'Glow Room',
  });
  assert.doesNotMatch(withoutReason.text, /Reason:/);
});

test('queue and payment templates carry the token/amount', () => {
  const queue = renderTransactional('QUEUE_CALLED', {
    customerName: 'Kabir',
    salonName: 'Blush & Bloom',
    tokenNumber: 7,
  });
  assert.match(queue.text, /#7/);

  const receipt = renderTransactional('PAYMENT_RECEIPT', {
    customerName: 'Kabir',
    salonName: 'Blush & Bloom',
    amountInr: '2450.00',
    bookingCode: 'GC9999',
  });
  assert.match(receipt.text, /₹2450\.00/);
  assert.match(receipt.text, /GC9999/);

  const kycApproved = renderTransactional('KYC_APPROVED', {
    customerName: 'Ananya',
    salonName: 'The Glow Room',
  });
  assert.match(kycApproved.subject, /Salon verification approved/);
  assert.match(kycApproved.text, /active on the marketplace/);

  const kycRejected = renderTransactional('KYC_REJECTED', {
    customerName: 'Ananya',
    salonName: 'The Glow Room',
    reason: 'Shop license illegible',
  });
  assert.match(kycRejected.subject, /Salon verification update/);
  assert.match(kycRejected.text, /Shop license illegible/);
});

test('reminder rendering links through the click tracker and lowercases the service', () => {
  const msg = renderReminderMessage(
    {
      template_code: 'DAY_25_INVITE',
      customer_name: 'Meera Nair',
      salon_name: 'Glam Studio',
      category_name: 'Haircut',
      deep_link_token: 'tok-abc',
    },
    'https://api.example.com/',
  );

  assert.match(msg.subject, /Meera/);
  assert.match(msg.text, /haircut/);
  assert.match(msg.text, /https:\/\/api\.example\.com\/r\/tok-abc/);
});

test('unknown reminder templates still render a valid call to action', () => {
  const msg = renderReminderMessage(
    {
      template_code: 'SOMETHING_NEW',
      customer_name: 'Meera Nair',
      salon_name: 'Glam Studio',
      category_name: 'Facial',
      deep_link_token: 'tok-xyz',
    },
    'https://api.example.com',
  );
  assert.match(msg.subject, /A note from Glam Studio/);
  assert.match(msg.text, /\/r\/tok-xyz/);
});

test('opt-out detection trims, ignores case, and leaves normal replies alone', () => {
  assert.equal(isOptOutMessage('STOP'), true);
  assert.equal(isOptOutMessage('  unsubscribe \n'), true);
  assert.equal(isOptOutMessage('StopAll'), true);
  assert.equal(isOptOutMessage('please stop messaging me'), false);
  assert.equal(isOptOutMessage('Yes, book me in'), false);
  assert.equal(isOptOutMessage(''), false);
  assert.equal(isOptOutMessage(undefined), false);
  assert.equal(isOptOutMessage(null), false);
});
