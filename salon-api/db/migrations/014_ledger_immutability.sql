-- 014: Enforce immutable customer_value_ledger (Ticket 14 - F1.14)
-- The loyalty ledger is append-only: UPDATE and DELETE are prohibited at both the permission and trigger levels.

REVOKE UPDATE, DELETE ON customer_value_ledger FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'glam_app') THEN
    REVOKE UPDATE, DELETE ON customer_value_ledger FROM glam_app;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION prevent_customer_value_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'customer_value_ledger is strictly append-only: UPDATE and DELETE operations are prohibited (F1.14)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_customer_value_ledger_mutation ON customer_value_ledger;
CREATE TRIGGER trg_prevent_customer_value_ledger_mutation
  BEFORE UPDATE OR DELETE ON customer_value_ledger
  FOR EACH ROW
  EXECUTE FUNCTION prevent_customer_value_ledger_mutation();
