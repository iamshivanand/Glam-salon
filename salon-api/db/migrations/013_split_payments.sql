-- F1.13: Split payment itemization on invoices_and_payments
ALTER TABLE invoices_and_payments ADD COLUMN IF NOT EXISTS split_details_json JSONB DEFAULT '[]';
