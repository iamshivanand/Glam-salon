-- 004: F1.10 Staff, skill matrix, schedules, breaks, resources
CREATE TABLE staff_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  display_name VARCHAR(100) NOT NULL,
  specialization VARCHAR(150),
  experience_years SMALLINT DEFAULT 0,
  is_bgv_verified BOOLEAN NOT NULL DEFAULT FALSE,
  home_visit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  commission_share_bps SMALLINT DEFAULT 0,
  avg_rating NUMERIC(3,2) NOT NULL DEFAULT 0.00,
  review_count INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_staff_salon_active ON staff_members(salon_id, is_active);

CREATE TABLE staff_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
  override_date DATE,
  shift_start TIME NOT NULL,
  shift_end TIME NOT NULL,
  breaks_json JSONB NOT NULL DEFAULT '[]',
  is_working_day BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_staff_schedules_lookup ON staff_schedules(staff_id, day_of_week, override_date);

CREATE TABLE staff_service_mapping (
  staff_id UUID NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  salon_service_id UUID NOT NULL REFERENCES salon_services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, salon_service_id)
);

CREATE TABLE salon_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX idx_resources_salon ON salon_resources(salon_id, resource_type, is_active);
