-- 006: F1.11 CRM style vault + F1.12 retention reminders
CREATE TYPE retention_segment_type AS ENUM ('NEW', 'REGULAR', 'AT_RISK', 'INACTIVE');

CREATE TABLE salon_customer_crm (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  custom_customer_code VARCHAR(32) NOT NULL,
  preferred_staff_id UUID REFERENCES staff_members(id),
  preferred_service_ids UUID[] DEFAULT '{}',
  first_visit_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_visit_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_expected_visit_date DATE,
  total_visits INTEGER NOT NULL DEFAULT 1,
  total_spend_paise BIGINT NOT NULL DEFAULT 0,
  avg_bill_paise INTEGER NOT NULL DEFAULT 0,
  computed_visit_interval_days SMALLINT NOT NULL DEFAULT 25,
  retention_segment retention_segment_type NOT NULL DEFAULT 'NEW',
  style_preferences_json JSONB NOT NULL DEFAULT '{}',
  reference_photo_s3_keys TEXT[] DEFAULT '{}',
  loyalty_points_balance INTEGER NOT NULL DEFAULT 0,
  prepaid_purchased_balance_paise INTEGER NOT NULL DEFAULT 0,
  prepaid_promo_balance_paise INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (salon_id, customer_id)
);
CREATE INDEX idx_crm_salon_segment_lastvisit ON salon_customer_crm(salon_id, retention_segment, last_visit_at);
CREATE INDEX idx_crm_salon_next_expected ON salon_customer_crm(salon_id, next_expected_visit_date);
CREATE TRIGGER trg_crm_updated BEFORE UPDATE ON salon_customer_crm FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE reminder_stage AS ENUM ('DAY_20_GENTLE', 'DAY_25_INVITE', 'DAY_35_REENGAGE');
CREATE TYPE reminder_status AS ENUM (
  'SCHEDULED', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED',
  'CONVERTED_TO_BOOKING', 'SUPPRESSED_ALREADY_BOOKED', 'SUPPRESSED_OPT_OUT', 'FAILED'
);

CREATE TABLE retention_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_booking_id UUID REFERENCES bookings(id),
  service_category_id UUID NOT NULL REFERENCES service_categories(id),
  stage reminder_stage NOT NULL,
  channel comm_channel NOT NULL DEFAULT 'WHATSAPP',
  scheduled_for TIMESTAMPTZ NOT NULL,
  status reminder_status NOT NULL DEFAULT 'SCHEDULED',
  template_code VARCHAR(64) NOT NULL,
  deep_link_token VARCHAR(64) NOT NULL UNIQUE,
  provider_message_id VARCHAR(128),
  attributed_booking_id UUID REFERENCES bookings(id),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_reminders_due_dispatch ON retention_reminders(scheduled_for, status) WHERE status = 'SCHEDULED';
CREATE INDEX idx_reminders_customer_suppress ON retention_reminders(customer_id, salon_id, status);
CREATE TRIGGER trg_reminders_updated BEFORE UPDATE ON retention_reminders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
