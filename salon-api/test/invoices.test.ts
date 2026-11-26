import '../test/setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateInvoiceTotals, validateSplitPayments } from '../src/services/invoices.js';

test('Invoice Totals: Standard new marketplace customer (1500 bps = 15% commission)', () => {
  // Gross ₹1000 (100,000 paise), 18% GST on ₹1000 = ₹180 (18,000 paise)
  // Net collected = ₹1180 (118,000 paise)
  // 15% commission on net = round(118,000 * 1500 / 10,000) = 17,700 paise (₹177)
  // Partner net settlement = 118,000 - 17,700 = 100,300 paise (₹1003)
  const totals = calculateInvoiceTotals({
    grossPaise: 100000,
    commissionBps: 1500,
  });

  assert.equal(totals.gross, 100000);
  assert.equal(totals.discount, 0);
  assert.equal(totals.loyalty, 0);
  assert.equal(totals.taxable, 100000);
  assert.equal(totals.tax, 18000);
  assert.equal(totals.net, 118000);
  assert.equal(totals.commission, 17700);
  assert.equal(totals.partnerSettlement, 100300);
});

test('Invoice Totals: Repeat CRM customer receives 0% commission (0 bps) retained 100% by salon', () => {
  // Repeat CRM client pays ₹500 (50,000 paise) gross + 18% GST (9,000 paise) = ₹590 net (59,000 paise)
  // Salon retains 100% of collected revenue
  const totals = calculateInvoiceTotals({
    grossPaise: 50000,
    commissionBps: 0,
  });

  assert.equal(totals.taxable, 50000);
  assert.equal(totals.tax, 9000);
  assert.equal(totals.net, 59000);
  assert.equal(totals.commission, 0);
  assert.equal(totals.partnerSettlement, 59000);
});

test('Invoice Totals: Discount deducted before GST calculation', () => {
  // Gross ₹2000 (200,000 paise), discount ₹500 (50,000 paise)
  // Taxable = ₹1500 (150,000 paise)
  // 18% GST on ₹1500 = ₹270 (27,000 paise)
  // Net = ₹1770 (177,000 paise)
  // Platform commission (15% = 1500 bps) = 26,550 paise (₹265.50)
  // Partner settlement = 150,450 paise (₹1504.50)
  const totals = calculateInvoiceTotals({
    grossPaise: 200000,
    discountPaise: 50000,
    commissionBps: 1500,
  });

  assert.equal(totals.gross, 200000);
  assert.equal(totals.discount, 50000);
  assert.equal(totals.taxable, 150000);
  assert.equal(totals.tax, 27000);
  assert.equal(totals.net, 177000);
  assert.equal(totals.commission, 26550);
  assert.equal(totals.partnerSettlement, 150450);
});

test('Invoice Totals: Loyalty point redemption combined with discount', () => {
  // Gross ₹1000 (100,000 paise), Discount ₹100 (10,000 paise), Loyalty ₹100 (10,000 paise)
  // Taxable = 80,000 paise (₹800)
  // 18% GST = 14,400 paise (₹144)
  // Net = 94,400 paise (₹944)
  const totals = calculateInvoiceTotals({
    grossPaise: 100000,
    discountPaise: 10000,
    loyaltyRedeemedPaise: 10000,
    commissionBps: 1500,
  });

  assert.equal(totals.taxable, 80000);
  assert.equal(totals.tax, 14400);
  assert.equal(totals.net, 94400);
  assert.equal(totals.commission, Math.round((94400 * 1500) / 10000)); // 14,160 paise
  assert.equal(totals.partnerSettlement, 94400 - 14160); // 80,240 paise
});

test('Invoice Totals: Discount capped at gross amount', () => {
  // Gross ₹500, Discount input ₹800 -> discount clamped to ₹500
  const totals = calculateInvoiceTotals({
    grossPaise: 50000,
    discountPaise: 80000,
    commissionBps: 1500,
  });

  assert.equal(totals.discount, 50000);
  assert.equal(totals.taxable, 0);
  assert.equal(totals.tax, 0);
  assert.equal(totals.net, 0);
  assert.equal(totals.commission, 0);
  assert.equal(totals.partnerSettlement, 0);
});

test('Split Payments: Valid 2-component split matching net collected amount', () => {
  // Net: ₹1180 (118,000 paise), Split into Cash ₹500 (50,000 paise) and UPI QR ₹680 (68,000 paise)
  const splitInput = [
    { method: 'CASH' as const, amount_paise: 50000 },
    { method: 'UPI_QR' as const, amount_paise: 68000 },
  ];
  const validated = validateSplitPayments(splitInput, 118000);

  assert.equal(validated.length, 2);
  assert.equal(validated[0].method, 'CASH');
  assert.equal(validated[0].amount_paise, 50000);
  assert.equal(validated[1].method, 'UPI_QR');
  assert.equal(validated[1].amount_paise, 68000);
});

test('Split Payments: Valid 3-component split matching net collected amount', () => {
  // Net: ₹1500 (150,000 paise) -> Cash 50,000 + UPI 50,000 + Card 50,000
  const splitInput = [
    { method: 'CASH' as const, amount_paise: 50000 },
    { method: 'UPI_QR' as const, amount_paise: 50000 },
    { method: 'CARD' as const, amount_paise: 50000 },
  ];
  const validated = validateSplitPayments(splitInput, 150000);

  assert.equal(validated.length, 3);
  assert.equal(validated.reduce((acc, p) => acc + p.amount_paise, 0), 150000);
});

test('Split Payments: Throws INVALID_SPLIT_PAYMENT if less than 2 payment components', () => {
  assert.throws(
    () => validateSplitPayments([], 100000),
    (err: any) => err.code === 'INVALID_SPLIT_PAYMENT',
  );

  assert.throws(
    () => validateSplitPayments([{ method: 'CASH' as const, amount_paise: 100000 }], 100000),
    (err: any) => err.code === 'INVALID_SPLIT_PAYMENT',
  );

  assert.throws(
    () => validateSplitPayments(undefined, 100000),
    (err: any) => err.code === 'INVALID_SPLIT_PAYMENT',
  );
});

test('Split Payments: Throws SPLIT_AMOUNT_MISMATCH when component sum does not equal net amount', () => {
  // Net ₹1000 (100,000 paise), components sum to ₹990 (99,000 paise)
  assert.throws(
    () =>
      validateSplitPayments(
        [
          { method: 'CASH' as const, amount_paise: 50000 },
          { method: 'UPI_QR' as const, amount_paise: 49000 },
        ],
        100000,
      ),
    (err: any) => err.code === 'SPLIT_AMOUNT_MISMATCH',
  );

  // Even 1 paisa mismatch throws
  assert.throws(
    () =>
      validateSplitPayments(
        [
          { method: 'CASH' as const, amount_paise: 50001 },
          { method: 'UPI_QR' as const, amount_paise: 50000 },
        ],
        100000,
      ),
    (err: any) => err.code === 'SPLIT_AMOUNT_MISMATCH',
  );
});

test('Split Payments: Accepts camelCase amountPaise from client payloads', () => {
  const splitInput = [
    { method: 'CASH', amountPaise: 40000 } as any,
    { method: 'UPI_QR', amountPaise: 60000 } as any,
  ];
  const validated = validateSplitPayments(splitInput, 100000);
  assert.equal(validated[0].amount_paise, 40000);
  assert.equal(validated[1].amount_paise, 60000);
});
