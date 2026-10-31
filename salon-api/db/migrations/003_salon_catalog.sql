-- 003: F1.02 / F1.03 / F1.08 / F1.09 Salon, discovery, hygiene, catalog, KYC, commission
CREATE TYPE salon_verification_status AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED');
CREATE TYPE pricing_type AS ENUM ('FIXED', 'STARTING_FROM_QUOTE');

CREATE TABLE salons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id),
  parent_brand_id UUID,
  name VARCHAR(150) NOT NULL,
  slug VARCHAR(180) NOT NULL UNIQUE,
  description TEXT,
  salon_type VARCHAR(50) NOT NULL,
  verification_status salon_verification_status NOT NULL DEFAULT 'DRAFT',
  address_line VARCHAR(255) NOT NULL,
  locality VARCHAR(120) NOT NULL,
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100) NOT NULL,
  postal_code VARCHAR(20) NOT NULL,
  geo_point GEOGRAPHY(Point, 4326) NOT NULL,
  operating_hours JSONB NOT NULL,
  accepts_instant_booking BOOLEAN NOT NULL DEFAULT TRUE,
  accepts_walkins BOOLEAN NOT NULL DEFAULT TRUE,
  walkin_paused BOOLEAN NOT NULL DEFAULT FALSE,
  supports_at_home BOOLEAN NOT NULL DEFAULT FALSE,
  at_home_radius_km NUMERIC(4,1) DEFAULT 0.0,
  avg_rating NUMERIC(3,2) NOT NULL DEFAULT 0.00,
  review_count INTEGER NOT NULL DEFAULT 0,
  price_tier SMALLINT NOT NULL DEFAULT 2,
  is_sponsored BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_salons_geo_active ON salons USING GIST(geo_point) WHERE is_active = TRUE AND verification_status = 'APPROVED';
CREATE INDEX idx_salons_city_locality ON salons(city, locality) WHERE is_active = TRUE AND verification_status = 'APPROVED';
CREATE TRIGGER trg_salons_updated BEFORE UPDATE ON salons FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE salon_hygiene_facilities (
  salon_id UUID PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
  has_private_room BOOLEAN NOT NULL DEFAULT FALSE,
  has_women_only_zone BOOLEAN NOT NULL DEFAULT FALSE,
  wheelchair_accessible BOOLEAN NOT NULL DEFAULT FALSE,
  uses_disposable_kits BOOLEAN NOT NULL DEFAULT FALSE,
  autoclave_sterilization BOOLEAN NOT NULL DEFAULT FALSE,
  ac_available BOOLEAN NOT NULL DEFAULT TRUE,
  parking_available BOOLEAN NOT NULL DEFAULT FALSE,
  hygiene_checklist_json JSONB NOT NULL DEFAULT '{}',
  verified_by_admin_id UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER trg_hygiene_updated BEFORE UPDATE ON salon_hygiene_facilities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE service_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES service_categories(id),
  name VARCHAR(100) NOT NULL UNIQUE,
  slug VARCHAR(120) NOT NULL UNIQUE,
  default_reminder_interval_days SMALLINT NOT NULL DEFAULT 25,
  display_order SMALLINT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE salon_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES service_categories(id),
  custom_name VARCHAR(150) NOT NULL,
  description TEXT,
  pricing_model pricing_type NOT NULL DEFAULT 'FIXED',
  base_price_paise INTEGER NOT NULL CHECK (base_price_paise >= 0),
  discounted_price_paise INTEGER CHECK (discounted_price_paise >= 0),
  duration_mins SMALLINT NOT NULL CHECK (duration_mins >= 5),
  buffer_after_mins SMALLINT NOT NULL DEFAULT 5,
  reminder_interval_days SMALLINT NOT NULL DEFAULT 25,
  requires_resource_type VARCHAR(50),
  available_for_home_visit BOOLEAN NOT NULL DEFAULT FALSE,
  quote_questions_schema JSONB DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_salon_services_lookup ON salon_services(salon_id, category_id, is_active);
CREATE TRIGGER trg_salon_services_updated BEFORE UPDATE ON salon_services FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE salon_service_addons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  primary_service_id UUID NOT NULL REFERENCES salon_services(id) ON DELETE CASCADE,
  addon_service_id UUID NOT NULL REFERENCES salon_services(id) ON DELETE CASCADE,
  bundle_discount_paise INTEGER NOT NULL DEFAULT 0,
  priority_rank SMALLINT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (primary_service_id, addon_service_id)
);

CREATE TABLE salon_kyc_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL UNIQUE REFERENCES salons(id) ON DELETE CASCADE,
  pan_number_encrypted BYTEA NOT NULL,
  gstin VARCHAR(20),
  bank_account_encrypted BYTEA NOT NULL,
  bank_ifsc VARCHAR(16) NOT NULL,
  shop_license_s3_key VARCHAR(512),
  status salon_verification_status NOT NULL DEFAULT 'SUBMITTED',
  reviewed_by_admin_id UUID REFERENCES users(id),
  rejection_reason TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER trg_kyc_updated BEFORE UPDATE ON salon_kyc_verifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE salon_commission_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL UNIQUE REFERENCES salons(id) ON DELETE CASCADE,
  plan_tier VARCHAR(32) NOT NULL DEFAULT 'STANDARD_COMMISSION',
  marketplace_new_client_bps SMALLINT NOT NULL DEFAULT 1500,
  repeat_crm_client_bps SMALLINT NOT NULL DEFAULT 0,
  saas_monthly_fee_paise INTEGER NOT NULL DEFAULT 0,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
