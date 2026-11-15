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
  occupation: string | null;
  monthlyIncomeCents: number | null;
  staffId?: string | null;
  defaultRateBps?: number;
  maxPrincipalCents?: number;
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
      occupation: null,
      monthlyIncomeCents: null,
      staffId: row?.staff_id ?? null,
      defaultRateBps: row?.default_rate_bps,
      maxPrincipalCents: row?.max_principal_cents,
    };
  }

  if (user.role === 'auditor') {
    return { nationalIdMasked: null, phoneMasked: null, occupation: null, monthlyIncomeCents: null };
  }

  const row = await queryOne<{
    national_id_enc: string | null;
    phone_enc: string | null;
    occupation: string | null;
    monthly_income_cents: number | null;
  }>(
    'SELECT national_id_enc, phone_enc, occupation, monthly_income_cents FROM borrower_profiles WHERE user_id = $1',
    [userId],
  );

  return {
    nationalIdMasked: maskValue(decryptField(row?.national_id_enc)),
    phoneMasked: maskValue(decryptField(row?.phone_enc)),
    occupation: row?.occupation ?? null,
    monthlyIncomeCents: row?.monthly_income_cents ?? null,
  };
}
