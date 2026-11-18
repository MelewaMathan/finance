-- Store borrower KRA PINs encrypted, with a keyed blind index for duplicate checks.
ALTER TABLE borrower_profiles
  ADD COLUMN IF NOT EXISTS kra_pin_encrypted text,
  ADD COLUMN IF NOT EXISTS kra_pin_hash text,
  ADD COLUMN IF NOT EXISTS kra_pin_last4 text;

CREATE UNIQUE INDEX IF NOT EXISTS borrower_profiles_kra_pin_hash_uidx
  ON borrower_profiles (kra_pin_hash)
  WHERE kra_pin_hash IS NOT NULL;
