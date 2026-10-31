-- 007: F1.13 POS billing / payments / commission + F1.14 immutable loyalty ledger
CREATE TYPE payment_method AS ENUM ('CASH', 'UPI_QR', 'ONLINE_UPI', 'CARD', 'LOYALTY_REDEEM', 'PREPAID_WALLET', 'SPLIT');
CREATE TYPE payment_status AS ENUM ('PENDING', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED');
CREATE TYPE ledger_bucket_type AS ENUM ('LOYALTY_POINTS', 'PURCHASED_WALLET_PAISE', 'PROMO_CREDIT_PAISE');
CREATE TYPE ledger_entry_type AS ENUM ('EARN_VISIT', 'REDEEM_CHECKOUT', 'WALLET_TOPUP', 'PROMO_BONUS', 'REFERRAL_REWARD', 'REFUND_REVERSAL', 'EXPIRED');

CREATE TABLE invoices_and_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number VARCHAR(32) NOT NULL UNIQUE,
  idempotency_key VARCHAR(64) NOT NULL UNIQUE,
  salon_id UUID NOT NULL REFERENCES salons(id),
  customer_id UUID NOT NULL REFERENCES users(id),
  booking_id UUID REFERENCES bookings(id),
  walkin_token_id UUID REFERENCES walkin_queue_tokens(id),
  gross_amount_paise INTEGER NOT NULL CHECK (gross_amount_paise >= 0),
  discount_paise INTEGER NOT NULL DEFAULT 0,
  loyalty_redeemed_paise INTEGER NOT NULL DEFAULT 0,
  wallet_redeemed_paise INTEGER NOT NULL DEFAULT 0,
  tax_paise INTEGER NOT NULL DEFAULT 0,
  net_collected_paise INTEGER NOT NULL CHECK (net_collected_paise >= 0),
  platform_commission_paise INTEGER NOT NULL DEFAULT 0,
  partner_net_settlement_paise INTEGER NOT NULL,
  method payment_method NOT NULL,
  status payment_status NOT NULL DEFAULT 'CAPTURED',
  gateway_order_id VARCHAR(128),
  gateway_payment_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_invoices_salon_created ON invoices_and_payments(salon_id, created_at DESC);

CREATE TABLE customer_value_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key VARCHAR(64) NOT NULL UNIQUE,
  salon_id UUID NOT NULL REFERENCES salons(id),
  customer_id UUID NOT NULL REFERENCES users(id),
  invoice_id UUID REFERENCES invoices_and_payments(id),
  bucket ledger_bucket_type NOT NULL DEFAULT 'LOYALTY_POINTS',
  entry_type ledger_entry_type NOT NULL,
  amount_delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  expires_at TIMESTAMPTZ,
  notes VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_value_ledger_lookup ON customer_value_ledger(salon_id, customer_id, bucket, created_at DESC);
