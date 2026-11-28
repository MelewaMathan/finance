-- ============================================================================
-- 013_concurrent_session_revocation.sql
-- Tracks when all access tokens for a user were forcibly invalidated (e.g.
-- when a concurrent staff login is detected on another device).
-- ============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tokens_valid_after timestamptz;

