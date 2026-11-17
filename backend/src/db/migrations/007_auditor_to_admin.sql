-- ============================================================================
-- 007_auditor_to_admin.sql
-- Renames the user_role enum value 'auditor' → 'admin'.
-- Data-safe and idempotent: guards with DO blocks.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'auditor'
  ) THEN
    ALTER TYPE user_role RENAME VALUE 'auditor' TO 'admin';
  END IF;
END;
$$;
