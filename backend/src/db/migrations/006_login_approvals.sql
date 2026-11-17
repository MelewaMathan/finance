-- ============================================================================
-- 006_login_approvals.sql
-- Auditor-approved staff login flow.
--
-- Changes:
--   1. Ensures user_status has 'pending'. On a fresh DB, 001 already does
--      this, so we guard with a DO block for existing clusters.
--   2. Sets all existing staff rows to 'active' (safe — they were created
--      before this feature existed, so they're already in production use).
--   3. Creates login_approvals table.
-- ============================================================================

-- Guard: add 'pending' if it was not already in user_status
-- (migration 005 also does this, but that migration is idempotent too).
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

-- Existing staff accounts were active before this feature; keep them active.
-- New staff registrations will start as 'pending' (enforced in auth.service.ts).
UPDATE users SET status = 'active' WHERE role = 'staff' AND status = 'pending';

-- ---------------------------------------------------------------------------
-- login_approvals
--
-- One row per staff login attempt that reached the approval stage (i.e. the
-- password was correct). The auditor reads pending rows, approves or denies.
-- On approval the backend issues a real session and marks the row 'used'.
-- ---------------------------------------------------------------------------
CREATE TYPE login_approval_status AS ENUM ('pending', 'approved', 'denied', 'expired', 'used');

CREATE TABLE login_approvals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            login_approval_status NOT NULL DEFAULT 'pending',
  requested_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  decided_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at        timestamptz,
  decision_reason   text,
  ip_address        inet,
  user_agent        text,
  -- poll_token_hash: SHA-256 of the opaque token returned to the staff client.
  -- The token itself is never stored; only its hash is kept here.
  poll_token_hash   char(64) NOT NULL UNIQUE
);

CREATE INDEX login_approvals_staff_pending_idx
  ON login_approvals(staff_user_id, status)
  WHERE status = 'pending';

CREATE INDEX login_approvals_status_idx
  ON login_approvals(status, requested_at DESC);
