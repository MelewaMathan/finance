-- ============================================================================
-- 012_staff_tiers_and_loan_workflow.sql
-- Adds 3-tier staff hierarchy (regular, supervisor, finance_manager) and
-- multi-stage loan approval workflow:
--   1. Regular Staff: AI credit scoring review + identity verification -> submit to Supervisor
--   2. Supervisor: credibility check + suggestion -> submit to Finance Manager
--   3. Finance Manager: final approve/reject decision + disbursement
-- ============================================================================

-- 1. Staff tier on staff_profiles (create enum if not exists)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'staff_tier') THEN
    CREATE TYPE staff_tier AS ENUM ('regular', 'supervisor', 'finance_manager');
  END IF;
END;
$$;

ALTER TABLE staff_profiles
  ADD COLUMN IF NOT EXISTS staff_tier staff_tier NOT NULL DEFAULT 'regular';

-- 2. Extend loan_status enum with supervisor_review and manager_review
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'loan_status' AND e.enumlabel = 'supervisor_review'
  ) THEN
    ALTER TYPE loan_status ADD VALUE 'supervisor_review' AFTER 'under_review';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'loan_status' AND e.enumlabel = 'manager_review'
  ) THEN
    ALTER TYPE loan_status ADD VALUE 'manager_review' AFTER 'supervisor_review';
  END IF;
END;
$$;

-- 3. Multi-stage review columns on loans
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS staff_recommendation text CHECK (staff_recommendation IN ('approve', 'reject')),
  ADD COLUMN IF NOT EXISTS staff_recommended_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS staff_recommended_at timestamptz,
  ADD COLUMN IF NOT EXISTS staff_recommendation_note text,
  ADD COLUMN IF NOT EXISTS supervisor_recommendation text CHECK (supervisor_recommendation IN ('approve', 'reject')),
  ADD COLUMN IF NOT EXISTS supervisor_recommended_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS supervisor_recommended_at timestamptz,
  ADD COLUMN IF NOT EXISTS supervisor_recommendation_note text;

