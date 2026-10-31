-- 008: F1.15 Verified-visit reviews & complaint escalation
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id),
  salon_id UUID NOT NULL REFERENCES salons(id),
  customer_id UUID NOT NULL REFERENCES users(id),
  staff_id UUID REFERENCES staff_members(id),
  overall_rating SMALLINT NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  hygiene_rating SMALLINT NOT NULL CHECK (hygiene_rating BETWEEN 1 AND 5),
  review_text TEXT,
  ai_complaint_tags TEXT[] DEFAULT '{}',
  owner_reply TEXT,
  resolution_status VARCHAR(32) DEFAULT 'NONE',
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_reviews_salon_rating ON reviews(salon_id, overall_rating, created_at DESC);
