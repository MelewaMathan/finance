import { queryOne } from '../../db/pool';
import { decryptField, maskValue } from '../../lib/crypto';
import { notFound } from '../../lib/errors';

/**
 * Reads profile data for display. Sensitive values are decrypted only at the
 * edge and immediately masked; the raw value never leaves the API.
 */
export interface ProfileSummary {
  nationalIdMasked: string | null;
  phoneMasked: string | null;
  kraPinMasked: string | null;
  kraPinStored: boolean;
  occupation: string | null;
  monthlyIncomeCents: number | null;
  completeness?: ProfileCompleteness;
  staffId?: string | null;
  defaultRateBps?: number;
  maxPrincipalCents?: number;
}

export type ProfileCompleteness = {
  complete: boolean;
  completed: number;
  total: 5;
  missing: string[];
};

/** The shared source of truth for whether a borrower may apply for a loan. */
export async function getProfileCompleteness(userId: string): Promise<ProfileCompleteness> {
  const row = await queryOne<{
    national_id_enc: string | null;
    phone_enc: string | null;
    kra_pin_encrypted: string | null;
    occupation: string | null;
    monthly_income_cents: number | string | null;
  }>(
    `SELECT national_id_enc, phone_enc, kra_pin_encrypted, occupation, monthly_income_cents
       FROM borrower_profiles
      WHERE user_id = $1`,
    [userId],
  );

  const checks: Array<[string, boolean]> = [
    ['nationalId', Boolean(row?.national_id_enc)],
    ['phone', Boolean(row?.phone_enc)],
    ['occupation', Boolean(row?.occupation?.trim())],
    ['monthlyIncomeCents', Number(row?.monthly_income_cents ?? 0) > 0],
    ['kraPin', Boolean(row?.kra_pin_encrypted)],
  ];
  const missing = checks.filter(([, done]) => !done).map(([field]) => field);
  return {
    complete: missing.length === 0,
    completed: checks.length - missing.length,
    total: 5,
    missing,
  };
}

export async function getProfileSummary(userId: string): Promise<ProfileSummary> {
  const user = await queryOne<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]);
  if (!user) throw notFound('User not found');

  if (user.role === 'staff') {
    const row = await queryOne<{ staff_id: string | null; default_rate_bps: number; max_principal_cents: number }>(
      'SELECT staff_id, default_rate_bps, max_principal_cents FROM lender_profiles WHERE user_id = $1',
      [userId],
    );
    return {
      nationalIdMasked: null,
      phoneMasked: null,
      kraPinMasked: null,
      kraPinStored: false,
      occupation: null,
      monthlyIncomeCents: null,
      staffId: row?.staff_id ?? null,
      defaultRateBps: row?.default_rate_bps,
      maxPrincipalCents: row?.max_principal_cents,
    };
  }

  if (user.role === 'admin') {
    return {
      nationalIdMasked: null,
      phoneMasked: null,
      kraPinMasked: null,
      kraPinStored: false,
      occupation: null,
      monthlyIncomeCents: null,
    };
  }

  const row = await queryOne<{
    national_id_enc: string | null;
    phone_enc: string | null;
    kra_pin_encrypted: string | null;
    kra_pin_last4: string | null;
    occupation: string | null;
    monthly_income_cents: number | string | null;
  }>(
    `SELECT national_id_enc, phone_enc, kra_pin_encrypted, kra_pin_last4,
            occupation, monthly_income_cents
       FROM borrower_profiles
      WHERE user_id = $1`,
    [userId],
  );

  return {
    nationalIdMasked: maskValue(decryptField(row?.national_id_enc)),
    phoneMasked: maskValue(decryptField(row?.phone_enc)),
    kraPinMasked: row?.kra_pin_last4 ? `A******${row.kra_pin_last4}` : null,
    kraPinStored: Boolean(row?.kra_pin_encrypted),
    occupation: row?.occupation ?? null,
    monthlyIncomeCents: row?.monthly_income_cents === null || row?.monthly_income_cents === undefined
      ? null
      : Number(row.monthly_income_cents),
    completeness: await getProfileCompleteness(userId),
  };
}
