-- 009: Tenant isolation (RLS) + least-privilege application role
-- The API connects as glam_app, which is NOT the table owner and NOT a superuser,
-- so RLS on salon_customer_crm is enforced on every query.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'glam_app') THEN
    CREATE ROLE glam_app LOGIN PASSWORD 'glam_app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE glamconnect TO glam_app;
GRANT USAGE ON SCHEMA public TO glam_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO glam_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO glam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO glam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO glam_app;

-- Enforce strict tenant isolation so Salon A can NEVER read Salon B's CRM
ALTER TABLE salon_customer_crm ENABLE ROW LEVEL SECURITY;
ALTER TABLE salon_customer_crm FORCE ROW LEVEL SECURITY;
CREATE POLICY salon_crm_tenant_isolation ON salon_customer_crm
  USING (salon_id = NULLIF(current_setting('app.current_salon_id', true), '')::UUID);

-- Retention reminders are tenant-scoped too
ALTER TABLE retention_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY salon_reminders_tenant_isolation ON retention_reminders
  USING (salon_id = NULLIF(current_setting('app.current_salon_id', true), '')::UUID);
