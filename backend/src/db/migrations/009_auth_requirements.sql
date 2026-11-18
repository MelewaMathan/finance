-- ============================================================================
-- 009_auth_requirements.sql
-- Forward migration for auth schema additions that must not live in 001.
-- Safe when 005/008 have already applied these changes.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'user_status' AND e.enumlabel = 'pending'
  ) THEN
    ALTER TYPE user_status ADD VALUE 'pending';
  END IF;
END;
$$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
