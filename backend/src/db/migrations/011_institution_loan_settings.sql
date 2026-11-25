-- Institution-wide loan terms replace per-staff lender profiles.
ALTER TABLE loans
  ALTER COLUMN lender_id DROP NOT NULL;

ALTER TABLE lender_profiles RENAME TO staff_profiles;
ALTER INDEX IF EXISTS lender_profiles_pkey RENAME TO staff_profiles_pkey;
ALTER TABLE staff_profiles
  DROP COLUMN IF EXISTS default_rate_bps,
  DROP COLUMN IF EXISTS max_principal_cents,
  DROP COLUMN IF EXISTS default_penalty_bps_per_day;
ALTER TRIGGER lender_profiles_touch_updated_at ON staff_profiles
  RENAME TO staff_profiles_touch_updated_at;

CREATE TABLE institution_loan_settings (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  interest_rate_bps     integer NOT NULL CHECK (interest_rate_bps BETWEEN 0 AND 10000),
  min_principal_cents   bigint NOT NULL CHECK (min_principal_cents > 0),
  max_principal_cents   bigint NOT NULL CHECK (max_principal_cents >= min_principal_cents),
  max_installments      integer NOT NULL CHECK (max_installments BETWEEN 1 AND 365),
  allowed_frequencies   text[] NOT NULL
    CHECK (cardinality(allowed_frequencies) BETWEEN 1 AND 3)
    CHECK (allowed_frequencies <@ ARRAY['daily', 'weekly', 'monthly']::text[]),
  institution_name      text NOT NULL CHECK (length(trim(institution_name)) BETWEEN 2 AND 120),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES users(id)
);

INSERT INTO institution_loan_settings
  (id, interest_rate_bps, min_principal_cents, max_principal_cents,
   max_installments, allowed_frequencies, institution_name)
VALUES
  (true, 1000, 10000, 20000000, 365, ARRAY['daily', 'weekly', 'monthly'], 'SecureMicrofinance');

CREATE TRIGGER institution_loan_settings_touch_updated_at
  BEFORE UPDATE ON institution_loan_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
