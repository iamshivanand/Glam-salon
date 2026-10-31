-- 005: F1.04 / F1.05 / F1.06 / F1.07 Bookings, lifecycle, audit, walk-in queue
CREATE TYPE booking_status AS ENUM (
  'REQUESTED', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE',
  'COMPLETED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SALON', 'DECLINED', 'NO_SHOW', 'EXPIRED'
);
CREATE TYPE booking_channel AS ENUM ('CUSTOMER_APP', 'PARTNER_POS', 'WALKIN_CONVERTED', 'URGENT_SLOT');
CREATE TYPE service_mode AS ENUM ('IN_SALON', 'AT_HOME');
CREATE TYPE queue_token_status AS ENUM ('WAITING', 'CALLED', 'IN_SERVICE', 'COMPLETED', 'SKIPPED', 'LEFT_QUEUE');

CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_code VARCHAR(16) NOT NULL UNIQUE,
  idempotency_key VARCHAR(64) NOT NULL UNIQUE,
  itinerary_group_id UUID,
  quote_request_id UUID,
  customer_id UUID NOT NULL REFERENCES users(id),
  salon_id UUID NOT NULL REFERENCES salons(id),
  mode service_mode NOT NULL DEFAULT 'IN_SALON',
  service_address_id UUID REFERENCES user_addresses(id),
  channel booking_channel NOT NULL DEFAULT 'CUSTOMER_APP',
  status booking_status NOT NULL DEFAULT 'REQUESTED',
  scheduled_start_at TIMESTAMPTZ NOT NULL,
  scheduled_end_at TIMESTAMPTZ NOT NULL,
  approval_expires_at TIMESTAMPTZ,
  checkin_pin CHAR(4) NOT NULL,
  subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise INTEGER NOT NULL DEFAULT 0,
  tax_paise INTEGER NOT NULL DEFAULT 0,
  booking_fee_paise INTEGER NOT NULL DEFAULT 0,
  total_payable_paise INTEGER NOT NULL CHECK (total_payable_paise >= 0),
  customer_notes TEXT,
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_bookings_salon_schedule ON bookings(salon_id, scheduled_start_at, status);
CREATE INDEX idx_bookings_customer_created ON bookings(customer_id, created_at DESC);
CREATE TRIGGER trg_bookings_updated BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE booking_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  salon_service_id UUID NOT NULL REFERENCES salon_services(id),
  staff_id UUID NOT NULL REFERENCES staff_members(id),
  resource_id UUID REFERENCES salon_resources(id),
  participant_name VARCHAR(100),
  is_addon BOOLEAN NOT NULL DEFAULT FALSE,
  service_name_snapshot VARCHAR(150) NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  duration_mins SMALLINT NOT NULL,
  time_range TSTZRANGE NOT NULL,
  status booking_status NOT NULL DEFAULT 'CONFIRMED',
  -- Kernel-level guarantee: no staff double-booking
  EXCLUDE USING gist (
    staff_id WITH =,
    time_range WITH &&
  ) WHERE (status IN ('CONFIRMED', 'ARRIVED', 'IN_SERVICE')),
  -- Kernel-level guarantee: no resource double-booking
  EXCLUDE USING gist (
    resource_id WITH =,
    time_range WITH &&
  ) WHERE (resource_id IS NOT NULL AND status IN ('CONFIRMED', 'ARRIVED', 'IN_SERVICE'))
);
CREATE INDEX idx_booking_items_booking ON booking_items(booking_id);
CREATE INDEX idx_booking_items_staff_time ON booking_items(staff_id, time_range);

CREATE TABLE booking_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  actor_role user_role NOT NULL,
  previous_status booking_status,
  new_status booking_status NOT NULL,
  change_reason VARCHAR(255),
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_booking_audit_booking ON booking_audit_logs(booking_id, created_at DESC);

CREATE TABLE walkin_queue_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES users(id),
  walkin_customer_name VARCHAR(100) NOT NULL,
  walkin_phone_encrypted BYTEA,
  walkin_phone_blind_index CHAR(64),
  preferred_staff_id UUID REFERENCES staff_members(id),
  assigned_staff_id UUID REFERENCES staff_members(id),
  assigned_resource_id UUID REFERENCES salon_resources(id),
  selected_service_ids UUID[] NOT NULL,
  total_duration_mins SMALLINT NOT NULL,
  queue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  token_number SMALLINT NOT NULL,
  status queue_token_status NOT NULL DEFAULT 'WAITING',
  estimated_wait_mins SMALLINT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  called_at TIMESTAMPTZ,
  service_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (salon_id, queue_date, token_number)
);
CREATE INDEX idx_queue_active_salon ON walkin_queue_tokens(salon_id, queue_date, status, token_number);
