-- ============================================================================
-- 003_transactions_scoring.sql -- money movements and advisory credit scores
-- ============================================================================

CREATE TYPE txn_type AS ENUM ('disbursement', 'repayment');
CREATE TYPE txn_method AS ENUM ('cash', 'mobile_money', 'bank');
CREATE TYPE txn_status AS ENUM ('pending', 'held', 'cleared', 'rejected');
CREATE TYPE risk_level AS ENUM ('low', 'medium', 'high');
CREATE TYPE score_source AS ENUM ('ml_service', 'fallback_heuristic');

CREATE TABLE transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  type                  txn_type NOT NULL,
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0),
  method                txn_method NOT NULL DEFAULT 'mobile_money',
  mobile_txn_code       text,
  mobile_txn_code_norm  text,
  occurred_at           timestamptz NOT NULL,
  recorded_by           uuid REFERENCES users(id),
  status                txn_status NOT NULL DEFAULT 'pending',
  hold_reason           text,
  fraud_score           numeric(5, 4) CHECK (fraud_score >= 0 AND fraud_score <= 1),
  -- SHA-256 of the canonical payload; the value that gets anchored on-chain.
  canonical_payload_hash char(64),
  onchain_hash          char(64),
  onchain_tx_hash       text,
  onchain_block         bigint,
  onchain_recorded_at   timestamptz,
  verified_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- A repayment must never exceed the loan, a disbursement must not be zero.
  CONSTRAINT transactions_mobile_code_consistent
    CHECK (method <> 'mobile_money' OR mobile_txn_code IS NOT NULL)
);

CREATE INDEX transactions_loan_idx ON transactions(loan_id, occurred_at DESC);
CREATE INDEX transactions_code_idx ON transactions(mobile_txn_code_norm);
CREATE INDEX transactions_status_idx ON transactions(status);

CREATE TABLE credit_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id       uuid NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  model_version text NOT NULL,
  model_source  score_source NOT NULL,
  score         integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  risk_level    risk_level NOT NULL,
  features      jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation   jsonb NOT NULL DEFAULT '[]'::jsonb,
  advisory_only boolean NOT NULL DEFAULT true,
  latency_ms    integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX credit_scores_loan_idx ON credit_scores(loan_id, created_at DESC);
