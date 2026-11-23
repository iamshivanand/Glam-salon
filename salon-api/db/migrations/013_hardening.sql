-- 013: Hardening pass — upload registry, refund ledger, payout records,
-- platform audit log, consent history and account deletion support.

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Every presigned upload gets a row. The key alone is never trusted: avatars and
-- KYC documents must reference an UPLOADED row owned by the caller.
CREATE TABLE IF NOT EXISTS uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id UUID REFERENCES salons(id) ON DELETE CASCADE,
  purpose VARCHAR(24) NOT NULL CHECK (purpose IN ('avatar', 'kyc_document', 'style_photo')),
  s3_key TEXT NOT NULL UNIQUE,
  declared_content_type VARCHAR(64) NOT NULL,
  declared_size_bytes INTEGER,
  actual_content_type VARCHAR(64),
  actual_size_bytes BIGINT,
  status VARCHAR(16) NOT NULL DEFAULT 'PRESIGNED'
    CHECK (status IN ('PRESIGNED', 'UPLOADED', 'REJECTED', 'DELETED')),
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_salon ON uploads(salon_id, created_at DESC);

-- Refund ledger. The unique key makes partner refunds idempotent: a retried
-- request returns the original outcome instead of moving money twice.
CREATE TABLE IF NOT EXISTS payment_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  payment_order_id UUID NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  reason VARCHAR(255),
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  provider_refund_id VARCHAR(128),
  idempotency_key VARCHAR(64) NOT NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (salon_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_order ON payment_refunds(payment_order_id);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_salon ON payment_refunds(salon_id, created_at DESC);

ALTER TABLE payment_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_refunds_tenant_isolation ON payment_refunds
  USING (salon_id = NULLIF(current_setting('app.current_salon_id', true), '')::UUID)
  WITH CHECK (salon_id = NULLIF(current_setting('app.current_salon_id', true), '')::UUID);
CREATE POLICY payment_refunds_integration ON payment_refunds
  USING (current_setting('app.integration', true) = 'true')
  WITH CHECK (current_setting('app.integration', true) = 'true');

-- Manually recorded payouts. Settlement reports stay computed; a payout row is
-- the evidence that money actually left the platform for a period.
CREATE TABLE IF NOT EXISTS settlement_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  reference VARCHAR(128),
  notes VARCHAR(500),
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (salon_id, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_settlement_payouts_salon
  ON settlement_payouts(salon_id, period_end DESC);

ALTER TABLE settlement_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_payouts FORCE ROW LEVEL SECURITY;
CREATE POLICY settlement_payouts_tenant_isolation ON settlement_payouts
  USING (salon_id = NULLIF(current_setting('app.current_salon_id', true), '')::UUID)
  WITH CHECK (salon_id = NULLIF(current_setting('app.current_salon_id', true), '')::UUID);

-- Who did what in the platform console. Append-only; never updated by the API.
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role VARCHAR(32),
  salon_id UUID REFERENCES salons(id) ON DELETE SET NULL,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_salon ON audit_log(salon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

-- Consent history: customer_consents only stores the current flag, so keep an
-- append-only trail for DPDP evidence and for the account screen.
CREATE TABLE IF NOT EXISTS customer_consent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id UUID REFERENCES salons(id) ON DELETE SET NULL,
  channel VARCHAR(16) NOT NULL,
  purpose VARCHAR(32) NOT NULL,
  is_granted BOOLEAN NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'ACCOUNT',
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_consent_events_user
  ON customer_consent_events(user_id, created_at DESC);
