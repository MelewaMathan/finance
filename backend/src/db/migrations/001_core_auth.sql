-- ============================================================================
-- 001_core_auth.sql -- identity, roles, encrypted borrower profiles, sessions
-- ============================================================================

CREATE TYPE user_role AS ENUM ('borrower', 'staff', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'pending', 'suspended', 'closed');

-- Reusable updated_at trigger.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL UNIQUE,
  password_hash    text NOT NULL,
  role             user_role NOT NULL,
  full_name        text NOT NULL,
  status           user_status NOT NULL DEFAULT 'active',
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Emails are stored lower-cased by the API; enforce it in the schema too.
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);

CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Personal data that must never be readable from a DB dump: encrypted with
-- AES-256-GCM. *_bi columns are HMAC blind indexes used for duplicate checks
-- so we never have to decrypt a column to search it.
CREATE TABLE borrower_profiles (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  national_id_enc      text,
  national_id_bi       text,
  phone_enc            text,
  phone_bi             text,
  date_of_birth_enc    text,
  address_enc          text,
  occupation           text,
  monthly_income_cents bigint CHECK (monthly_income_cents >= 0),
  consent_flags        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Deliberately NOT unique: a duplicate national ID is a *detectable fraud
-- signal* (flagged for review), not a database error.
CREATE INDEX borrower_profiles_nid_bi_idx ON borrower_profiles(national_id_bi);
CREATE INDEX borrower_profiles_phone_bi_idx ON borrower_profiles(phone_bi);

CREATE TRIGGER borrower_profiles_touch_updated_at
  BEFORE UPDATE ON borrower_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE lender_profiles (
  user_id                    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  staff_id                   text,
  max_principal_cents        bigint NOT NULL DEFAULT 20000000 CHECK (max_principal_cents > 0),
  default_rate_bps           integer NOT NULL DEFAULT 1000 CHECK (default_rate_bps BETWEEN 0 AND 10000),
  default_penalty_bps_per_day integer NOT NULL DEFAULT 100 CHECK (default_penalty_bps_per_day >= 0),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER lender_profiles_touch_updated_at
  BEFORE UPDATE ON lender_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Rotating refresh tokens. Only the SHA-256 of the token is stored, so a
-- database leak does not hand out live sessions.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  char(64) NOT NULL UNIQUE,
  family_id   uuid NOT NULL,
  replaced_by uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  ip          inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id);
