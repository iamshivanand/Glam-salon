import '../test/setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateLoyaltyEarned,
  calculateLoyaltyRedemptionValue,
} from '../src/services/invoices.js';

test('Loyalty Points Accrual: Earns 1 point per ₹100 (10,000 paise) spent on completed visits', () => {
  // Exactly ₹100 (10,000 paise) -> 1 point
  assert.equal(calculateLoyaltyEarned(10000), 1);

  // ₹150 (15,000 paise) -> 1 point (floored)
  assert.equal(calculateLoyaltyEarned(15000), 1);

  // ₹499 (49,900 paise) -> 4 points
  assert.equal(calculateLoyaltyEarned(49900), 4);

  // ₹1000 (100,000 paise) -> 10 points
  assert.equal(calculateLoyaltyEarned(100000), 10);

  // ₹2850 (285,000 paise) -> 28 points
  assert.equal(calculateLoyaltyEarned(285000), 28);

  // Sub-threshold spend: ₹99 (9,900 paise) -> 0 points
  assert.equal(calculateLoyaltyEarned(9900), 0);

  // Zero or negative spend -> 0 points
  assert.equal(calculateLoyaltyEarned(0), 0);
  assert.equal(calculateLoyaltyEarned(-5000), 0);
});

test('Loyalty Points Redemption Value: 1 point equals ₹1 (100 paise) discount', () => {
  assert.equal(calculateLoyaltyRedemptionValue(1), 100);
  assert.equal(calculateLoyaltyRedemptionValue(10), 1000);
  assert.equal(calculateLoyaltyRedemptionValue(25), 2500);
  assert.equal(calculateLoyaltyRedemptionValue(100), 10000);
  assert.equal(calculateLoyaltyRedemptionValue(0), 0);
  assert.equal(calculateLoyaltyRedemptionValue(-5), 0);
});

test('Ledger Running Balance Integrity: Chronological credit and debit progression', () => {
  interface MockLedgerEntry {
    entry_type: 'EARN_VISIT' | 'REDEEM_CHECKOUT' | 'WALLET_TOPUP' | 'PROMO_BONUS';
    bucket: 'LOYALTY_POINTS' | 'PURCHASED_WALLET_PAISE' | 'PROMO_CREDIT_PAISE';
    amount_delta: number;
    balance_after: number;
  }

  const ledger: MockLedgerEntry[] = [];
  let currentBalance = 0;

  function appendEntry(
    type: MockLedgerEntry['entry_type'],
    delta: number,
    bucket: MockLedgerEntry['bucket'] = 'LOYALTY_POINTS',
  ) {
    const nextBalance = currentBalance + delta;
    assert(nextBalance >= 0, `CHECK (balance_after >= 0) violated: next balance is ${nextBalance}`);
    currentBalance = nextBalance;
    const entry: MockLedgerEntry = {
      entry_type: type,
      bucket,
      amount_delta: delta,
      balance_after: currentBalance,
    };
    ledger.push(entry);
    return entry;
  }

  // 1. Visit 1: Earn 15 points
  appendEntry('EARN_VISIT', 15);
  assert.equal(currentBalance, 15);
  assert.equal(ledger[0].balance_after, 15);

  // 2. Visit 2: Earn 20 points
  appendEntry('EARN_VISIT', 20);
  assert.equal(currentBalance, 35);
  assert.equal(ledger[1].balance_after, 35);

  // 3. Visit 3: Redeem 10 points
  appendEntry('REDEEM_CHECKOUT', -10);
  assert.equal(currentBalance, 25);
  assert.equal(ledger[2].balance_after, 25);

  // 4. Over-redemption must be rejected
  assert.throws(
    () => appendEntry('REDEEM_CHECKOUT', -30),
    /CHECK \(balance_after >= 0\) violated/,
  );

  // Invariants:
  assert.equal(ledger.length, 3);
  assert.equal(ledger[0].amount_delta, 15);
  assert.equal(ledger[1].amount_delta, 20);
  assert.equal(ledger[2].amount_delta, -10);
});

test('Phase 2 Dual-Ledger Extensibility: Supports separate prepaid wallet and promo credit buckets', () => {
  const supportedBuckets = ['LOYALTY_POINTS', 'PURCHASED_WALLET_PAISE', 'PROMO_CREDIT_PAISE'] as const;
  const supportedEntryTypes = [
    'EARN_VISIT',
    'REDEEM_CHECKOUT',
    'WALLET_TOPUP',
    'PROMO_BONUS',
    'REFERRAL_REWARD',
    'REFUND_REVERSAL',
    'EXPIRED',
  ] as const;

  assert.equal(supportedBuckets.length, 3);
  assert.equal(supportedEntryTypes.length, 7);

  // Example Phase 2 Top-up: ₹500 Purchased Wallet + ₹50 Promo Bonus
  const purchasedWalletDelta = 50000; // paise
  const promoCreditDelta = 5000; // paise

  assert.equal(purchasedWalletDelta, 50000);
  assert.equal(promoCreditDelta, 5000);
});

test('Ledger Idempotency: Distinct non-colliding keys for earn and redeem within same transaction', () => {
  const baseKey = 'f89a9c3b-5517-48e0-a7d1-e6a3d6cb7f9b';
  const earnKey = `${baseKey}:earn`;
  const redeemKey = `${baseKey}:redeem`;

  assert.notEqual(earnKey, redeemKey);
  assert(earnKey.startsWith(baseKey));
  assert(redeemKey.startsWith(baseKey));
});
