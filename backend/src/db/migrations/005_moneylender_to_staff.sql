-- ============================================================================
-- 005_moneylender_to_staff.sql
-- Renames the role value to 'staff' from either 'moneylender' or 'lender'
-- (whichever the existing database uses) without losing any data.
-- Also:
--   • renames lender_profiles.business_name → staff_id (nullable text)
--   • adds a 'pending' status value for staff accounts awaiting admin approval
-- ============================================================================

-- Rename 'moneylender' → 'staff' if that value is still present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'moneylender'
  ) THEN
    ALTER TYPE user_role RENAME VALUE 'moneylender' TO 'staff';
  END IF;
END;
$$;

-- Rename 'lender' → 'staff' if that value is still present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'lender'
  ) THEN
    ALTER TYPE user_role RENAME VALUE 'lender' TO 'staff';
  END IF;
END;
$$;

-- Add 'pending' to user_status if it does not already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'user_status' AND e.enumlabel = 'pending'
  ) THEN
    ALTER TYPE user_status ADD VALUE 'pending';
  END IF;
END;
$$;

-- Rename business_name → staff_id on lender_profiles.
-- The column already exists as 'business_name' on databases migrated with 001.
-- On a fresh database this migration runs after 001 which already uses the new
-- column name, so we guard against the case where it was already renamed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lender_profiles' AND column_name = 'business_name'
  ) THEN
    ALTER TABLE lender_profiles RENAME COLUMN business_name TO staff_id;
  END IF;
END;
$$;
