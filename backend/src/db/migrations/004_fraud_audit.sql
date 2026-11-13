-- ============================================================================
-- 004_fraud_audit.sql -- fraud flags, alerts, append-only audit log, integrity
-- ============================================================================

CREATE TYPE flag_type AS ENUM (
  'duplicate_txn_code',
  'malformed_reference',
  'identity_conflict',
  'rapid_applications',
  'ml_anomaly',
  'duplicate_disbursement',
  'hash_mismatch'
);

CREATE TYPE flag_severity AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE flag_status AS ENUM ('open', 'cleared', 'confirmed');
CREATE TYPE flag_source AS ENUM ('rule', 'ml');
CREATE TYPE integrity_scope AS ENUM ('all', 'loan', 'entity', 'audit_chain');
CREATE TYPE integrity_result AS ENUM ('ok', 'tampered', 'error');

CREATE TABLE fraud_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id         uuid REFERENCES loans(id) ON DELETE CASCADE,
  transaction_id  uuid REFERENCES transactions(id) ON DELETE CASCADE,
  borrower_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  flag_type       flag_type NOT NULL,
  severity        flag_severity NOT NULL,
  status          flag_status NOT NULL DEFAULT 'open',
  source          flag_source NOT NULL DEFAULT 'rule',
  rule_id         text,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Natural key so the same problem is not reported twice on every scan.
  dedupe_key      text NOT NULL UNIQUE,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  resolution_note text
);

CREATE INDEX fraud_flags_status_idx ON fraud_flags(status, severity, detected_at DESC);
CREATE INDEX fraud_flags_loan_idx ON fraud_flags(loan_id);

CREATE TABLE alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  severity    flag_severity NOT NULL DEFAULT 'medium',
  title       text NOT NULL,
  body        text NOT NULL,
  entity_type text,
  entity_id   text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX alerts_user_idx ON alerts(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Append-only audit log with a per-row hash chain.
--
-- Every row stores prev_hash (the previous row's row_hash). Updating or
-- deleting a historical row is blocked by a trigger, and even if an attacker
-- disables the trigger and edits a row, recomputing the chain exposes it:
-- the chain no longer links, and the transaction hashes still match the
-- on-chain ledger.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE audit_seq START 1;

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  seq           bigint NOT NULL UNIQUE DEFAULT nextval('audit_seq'),
  actor_user_id uuid,
  actor_role    text,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  ip            inet,
  user_agent    text,
  request_id    text,
  before_hash   char(64),
  after_hash    char(64),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash     char(64) NOT NULL,
  row_hash      char(64) NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id, seq);
CREATE INDEX audit_log_actor_idx ON audit_log(actor_user_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC);
CREATE INDEX audit_log_detail_gin ON audit_log USING gin (detail);

CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_mutation();

-- Checkpoints of the audit chain head, optionally anchored on-chain.
CREATE TABLE audit_anchors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upto_seq        bigint NOT NULL,
  chain_root      char(64) NOT NULL,
  onchain_tx_hash text,
  anchored_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integrity_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           integrity_scope NOT NULL,
  target_id       text,
  records_checked integer NOT NULL DEFAULT 0,
  mismatches      integer NOT NULL DEFAULT 0,
  result          integrity_result NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_by          uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX integrity_checks_created_idx ON integrity_checks(created_at DESC);
