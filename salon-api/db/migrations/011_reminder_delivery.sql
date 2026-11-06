-- 011: Track reminder delivery attempts and retry state.
-- The dispatcher keeps rows SCHEDULED until the provider accepts the message,
-- then marks them SENT. Provider failures are retried with a short backoff.

ALTER TABLE retention_reminders
  ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_reminders_due_retry
  ON retention_reminders(scheduled_for, next_attempt_at)
  WHERE status = 'SCHEDULED';
