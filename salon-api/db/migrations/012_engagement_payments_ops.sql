-- 012: Engagement tracking, flows, payments, push tokens and notification logs.

-- Delivery/engagement state for reminders. SENT means the provider accepted the
-- message; DELIVERED/OPENED/CLICKED/CONVERTED now have timestamps as well.
ALTER TABLE retention_reminders
  ADD COLUMN IF NOT EXISTS provider VARCHAR(32),
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_reminders_provider_message
  ON retention_reminders(provider, provider_message_id);
CREATE INDEX IF NOT EXISTS idx_reminders_deep_link
  ON retention_reminders(deep_link_token);

-- Inbound provider callbacks and public click redirects run without a salon
-- context. A permissive integration policy lets those code paths opt in with
-- app.integration = 'true' inside a transaction.
CREATE POLICY salon_reminders_integration ON retention_reminders
  USING (current_setting('app.integration', true) = 'true')
  WITH CHECK (current_setting('app.integration', true) = 'true');

CREATE TABLE IF NOT EXISTS reminder_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id UUID NOT NULL REFERENCES retention_reminders(id) ON DELETE CASCADE,
  provider VARCHAR(32),
  event_type VARCHAR(32) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reminder_events_reminder
  ON reminder_events(reminder_id, created_at DESC);

-- Online payment attempts. Manual/POS collections still live in
-- invoices_and_payments; this table tracks gateway orders before capture.
CREATE TABLE IF NOT EXISTS payment_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  invoice_id UUID REFERENCES invoices_and_payments(id) ON DELETE SET NULL,
  customer_id UUID NOT NULL REFERENCES users(id),
  provider VARCHAR(32) NOT NULL DEFAULT 'manual',
  provider_order_id VARCHAR(128),
  provider_payment_id VARCHAR(128),
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(24) NOT NULL DEFAULT 'CREATED',
  idempotency_key VARCHAR(64),
  raw_response JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_provider_order
  ON payment_orders(provider, provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_idempotency
  ON payment_orders(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_orders_salon
  ON payment_orders(salon_id, created_at DESC);

ALTER TABLE payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_orders_tenant_isolation ON payment_orders
  USING (salon_id = NULLIF(current_setting('app.current_salon_id', true), '')::UUID)
  WITH CHECK (salon_id = NULLIF(current_setting('app.current_salon_id', true), '')::UUID);
CREATE POLICY payment_orders_integration ON payment_orders
  USING (current_setting('app.integration', true) = 'true')
  WITH CHECK (current_setting('app.integration', true) = 'true');

-- Expo push / FCM device registration.
CREATE TABLE IF NOT EXISTS device_push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform VARCHAR(16) NOT NULL DEFAULT 'unknown',
  app VARCHAR(16) NOT NULL DEFAULT 'customer',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_device_push_user ON device_push_tokens(user_id);

-- Audit trail for OTP, transactional and reminder sends.
CREATE TABLE IF NOT EXISTS notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  salon_id UUID REFERENCES salons(id) ON DELETE SET NULL,
  channel comm_channel NOT NULL,
  template_code VARCHAR(64),
  destination_masked VARCHAR(256),
  provider VARCHAR(32),
  provider_message_id VARCHAR(128),
  status VARCHAR(24) NOT NULL DEFAULT 'SENT',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_log_created
  ON notification_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_log_user
  ON notification_log(user_id, created_at DESC);
