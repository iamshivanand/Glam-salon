-- 002: F1.01 Customer auth, profile, addresses, DPDP consents
CREATE TYPE user_role AS ENUM ('CUSTOMER', 'SALON_OWNER', 'SALON_MANAGER', 'STAFF', 'PLATFORM_ADMIN');
CREATE TYPE account_status AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION', 'DELETED');
CREATE TYPE comm_channel AS ENUM ('WHATSAPP', 'SMS', 'PUSH', 'EMAIL');
CREATE TYPE consent_purpose AS ENUM ('BOOKING_TRANSACTIONAL', 'RETENTION_REMINDER', 'PROMOTIONAL_OFFERS', 'STYLE_PHOTO_STORAGE');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164_encrypted BYTEA NOT NULL,
  phone_blind_index CHAR(64) NOT NULL UNIQUE,
  email VARCHAR(255) UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  role user_role NOT NULL DEFAULT 'CUSTOMER',
  status account_status NOT NULL DEFAULT 'ACTIVE',
  avatar_s3_key VARCHAR(512),
  gender VARCHAR(32),
  date_of_birth DATE,
  emergency_contacts_json JSONB DEFAULT '[]',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_users_role_status ON users(role, status);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_family_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  device_fingerprint VARCHAR(255),
  ip_address INET,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_refresh_user_family ON user_refresh_tokens(user_id, token_family_id);

CREATE TABLE user_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label VARCHAR(50) NOT NULL,
  address_line_encrypted BYTEA NOT NULL,
  locality VARCHAR(120) NOT NULL,
  city VARCHAR(100) NOT NULL,
  postal_code VARCHAR(20) NOT NULL,
  geo_point GEOGRAPHY(Point, 4326) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_addresses_user ON user_addresses(user_id);
CREATE INDEX idx_user_addresses_geo ON user_addresses USING GIST(geo_point);

CREATE TABLE customer_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id UUID,
  channel comm_channel NOT NULL,
  purpose consent_purpose NOT NULL,
  is_granted BOOLEAN NOT NULL DEFAULT TRUE,
  ip_address INET,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (user_id, salon_id, channel, purpose)
);
CREATE INDEX idx_consents_lookup ON customer_consents(user_id, purpose, is_granted);
CREATE TRIGGER trg_consents_updated BEFORE UPDATE ON customer_consents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
