-- ============================================================================
-- 008_must_change_password.sql
-- Adds must_change_password flag to users.
-- When true the user is forced to set a new password on next login before
-- they can reach any authenticated page.
-- ============================================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
