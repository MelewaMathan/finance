-- ============================================================================
-- 002_loans.sql -- loan applications, decisions, schedules, documents
-- ============================================================================

CREATE TYPE loan_status AS ENUM (
  'pending',        -- borrower applied, awaiting lender review
  'under_review',   -- lender opened it / identity verification in progress
  'approved',       -- lender approved, agreement generated, not yet disbursed
  'rejected',
  'held',           -- fraud gate: approval or disbursement blocked
  'disbursed',      -- money released (on-chain proof written)
  'active',         -- at least one repayment recorded, still outstanding
  'settled',
  'defaulted',
  'cancelled'
);

CREATE TYPE repayment_frequency AS ENUM ('daily', 'weekly', 'monthly');
CREATE TYPE installment_status AS ENUM ('pending', 'partial', 'paid', 'overdue', 'waived');
CREATE TYPE document_kind AS ENUM ('agreement', 'statement', 'forensic_report');

-- Human readable loan reference: SMF-2026-000123
CREATE SEQUENCE loan_ref_seq START 1;

CREATE TABLE loans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                   text NOT NULL UNIQUE,
  lender_id             uuid NOT NULL REFERENCES users(id),
  borrower_id           uuid NOT NULL REFERENCES users(id),
  principal_cents       bigint NOT NULL CHECK (principal_cents > 0),
  term_count            integer NOT NULL CHECK (term_count BETWEEN 1 AND 365),
  frequency             repayment_frequency NOT NULL,
  rate_bps              integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  purpose               text NOT NULL,
  collateral_desc       text,
  -- Guarantor details are PII: encrypted at rest.
  guarantor_name_enc    text,
  guarantor_phone_enc   text,
  guarantor_credit      smallint CHECK (guarantor_credit BETWEEN 0 AND 100),
  total_repayable_cents bigint NOT NULL CHECK (total_repayable_cents > 0),
  status                loan_status NOT NULL DEFAULT 'pending',
  identity_verified_at  timestamptz,
  identity_verified_by  uuid REFERENCES users(id),
  decided_at            timestamptz,
  decided_by            uuid REFERENCES users(id),
  decision_note         text,
  agreement_doc_id      uuid,
  agreement_sha256      char(64),
  score_snapshot_id     uuid,
  held_reason           text,
  disbursed_at          timestamptz,
  settled_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loans_distinct_parties CHECK (lender_id <> borrower_id)
);

CREATE INDEX loans_lender_status_idx ON loans(lender_id, status);
CREATE INDEX loans_borrower_created_idx ON loans(borrower_id, created_at DESC);
CREATE INDEX loans_status_idx ON loans(status);

CREATE TRIGGER loans_touch_updated_at
  BEFORE UPDATE ON loans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE loan_installments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                uuid NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  seq                    integer NOT NULL CHECK (seq > 0),
  due_date               date NOT NULL,
  principal_due_cents    bigint NOT NULL CHECK (principal_due_cents >= 0),
  interest_due_cents     bigint NOT NULL CHECK (interest_due_cents >= 0),
  penalty_accrued_cents  bigint NOT NULL DEFAULT 0 CHECK (penalty_accrued_cents >= 0),
  paid_principal_cents   bigint NOT NULL DEFAULT 0 CHECK (paid_principal_cents >= 0),
  paid_interest_cents    bigint NOT NULL DEFAULT 0 CHECK (paid_interest_cents >= 0),
  paid_penalty_cents     bigint NOT NULL DEFAULT 0 CHECK (paid_penalty_cents >= 0),
  status                 installment_status NOT NULL DEFAULT 'pending',
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, seq)
);

CREATE INDEX loan_installments_due_idx ON loan_installments(loan_id, due_date);

CREATE TABLE documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id    uuid REFERENCES loans(id) ON DELETE CASCADE,
  kind       document_kind NOT NULL,
  mime       text NOT NULL,
  file_path  text NOT NULL,
  sha256     char(64) NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX documents_loan_idx ON documents(loan_id, kind);

ALTER TABLE loans
  ADD CONSTRAINT loans_agreement_doc_fk
  FOREIGN KEY (agreement_doc_id) REFERENCES documents(id) ON DELETE SET NULL;
