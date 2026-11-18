import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../db/pool';
import {
  encryptField,
  kraPinBlindIndex,
  nationalIdBlindIndex,
  normalizeKraPin,
  normalizeNationalId,
  phoneBlindIndex,
} from '../../lib/crypto';
import { badRequest, conflict, forbidden } from '../../lib/errors';
import { requireAuth, denyAuditorWrites } from '../../middleware/auth';
import { limitWrites } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { auditRequest } from '../audit/audit.service';
import { detectIdentityConflicts } from '../fraud/rules.engine';
import { getProfileSummary } from './users.service';

/**
 * Self-service profile endpoints.
 *
 * National ID and phone are encrypted (AES-256-GCM) before they touch the
 * database, and a blind index (HMAC) is stored alongside so we can detect a
 * duplicate identity across accounts without decrypting anything.
 */
const updateSchema = z.object({
  nationalId: z
    .string()
    .trim()
    .refine((value) => value === '' || /^\d{7,9}$/.test(value), 'must be 7 to 9 digits')
    .optional(),
  phone: z
    .string()
    .trim()
    .max(24)
    .refine((value) => value === '' || normalizeKenyanMobilePhone(value) !== null, 'enter a valid Kenyan mobile number')
    .optional(),
  kraPin: z
    .string()
    .trim()
    .transform(normalizeKraPin)
    .refine(
      (value) => value === '' || /^A\d{9}[A-Z]$/.test(value),
      'Enter a valid KRA PIN (A followed by 9 digits and a letter)',
    )
    .optional(),
  occupation: z
    .string()
    .trim()
    .max(80)
    .refine((value) => value === '' || value.length >= 2, 'must be at least 2 characters')
    .optional(),
  // Zero is accepted as an explicit clear operation. A positive value is
  // required for profile completeness and is stored in cents.
  monthlyIncomeCents: z.number().int().min(0).max(1_000_000_000).optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
    .optional(),
  address: z.string().trim().max(200).optional(),
});

function normalizeKenyanMobilePhone(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\+?[\d -]+$/.test(trimmed)) return null;

  const digits = trimmed.replace(/\D/g, '');
  const national = digits.startsWith('254')
    ? digits.slice(3)
    : digits.startsWith('0')
      ? digits.slice(1)
      : digits;
  if (!/^[71]\d{8}$/.test(national)) return null;
  return `+254${national}`;
}

export const usersRouter = Router();

usersRouter.get('/profile', requireAuth, async (req, res) => {
  const profile = await getProfileSummary(req.user!.id);
  res.json({ profile });
});

usersRouter.put('/profile', requireAuth, denyAuditorWrites, limitWrites, validate(updateSchema), async (req, res) => {
  if (req.user!.role !== 'borrower') {
    throw forbidden('Only borrowers have a borrower profile');
  }

  const body = req.body as z.infer<typeof updateSchema>;

  // Build the update from an allow-list of columns; nothing from the request
  // is ever interpolated into SQL.
  const sets: string[] = [];
  const values: unknown[] = [];
  const changedFields: string[] = [];

  const push = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (body.nationalId !== undefined) {
    const nationalId = body.nationalId === '' ? null : normalizeNationalId(body.nationalId);
    push('national_id_enc', nationalId ? encryptField(nationalId) : null);
    push('national_id_bi', nationalId ? nationalIdBlindIndex(nationalId) : null);
    changedFields.push('nationalId');
    if (nationalId) {
      // Flag duplicates across accounts (fraud module owns the flag itself).
      await detectIdentityConflicts({
        userId: req.user!.id,
        nationalIdBi: nationalIdBlindIndex(nationalId),
      });
    }
  }
  if (body.phone !== undefined) {
    const phone = body.phone === '' ? null : normalizeKenyanMobilePhone(body.phone);
    if (body.phone !== '' && !phone) throw badRequest('Enter a valid Kenyan mobile number');
    push('phone_enc', phone ? encryptField(phone) : null);
    push('phone_bi', phone ? phoneBlindIndex(phone) : null);
    changedFields.push('phone');
    if (phone) {
      await detectIdentityConflicts({ userId: req.user!.id, phoneBi: phoneBlindIndex(phone) });
    }
  }
  if (body.kraPin !== undefined) {
    const kraPin = body.kraPin || null;
    const kraPinHash = kraPin ? kraPinBlindIndex(kraPin) : null;
    if (kraPinHash) {
      const duplicate = await queryOne<{ user_id: string }>(
        'SELECT user_id FROM borrower_profiles WHERE kra_pin_hash = $1 AND user_id <> $2',
        [kraPinHash, req.user!.id],
      );
      if (duplicate) throw conflict("This KRA PIN can't be used");
    }

    push('kra_pin_encrypted', kraPin ? encryptField(kraPin) : null);
    push('kra_pin_hash', kraPinHash);
    push('kra_pin_last4', kraPin ? kraPin.slice(-4) : null);
    changedFields.push('kraPin');
  }
  if (body.occupation !== undefined) {
    push('occupation', body.occupation || null);
    changedFields.push('occupation');
  }
  if (body.monthlyIncomeCents !== undefined) {
    push('monthly_income_cents', body.monthlyIncomeCents || null);
    changedFields.push('monthlyIncomeCents');
  }
  if (body.dateOfBirth) {
    push('date_of_birth_enc', encryptField(body.dateOfBirth));
    changedFields.push('dateOfBirth');
  }
  if (body.address) {
    push('address_enc', encryptField(body.address));
    changedFields.push('address');
  }

  if (sets.length === 0) throw badRequest('No profile fields supplied');

  values.push(req.user!.id);
  try {
    await query(
      `UPDATE borrower_profiles SET ${sets.join(', ')} WHERE user_id = $${values.length}`,
      values,
    );
  } catch (error) {
    const databaseError = error as { code?: string; constraint?: string };
    if (
      databaseError.code === '23505' &&
      databaseError.constraint === 'borrower_profiles_kra_pin_hash_uidx'
    ) {
      throw conflict("This KRA PIN can't be used");
    }
    throw error;
  }

  await auditRequest(req, 'profile.update', 'borrower_profile', req.user!.id, { changedFields });

  const profile = await getProfileSummary(req.user!.id);
  res.json({ profile, message: 'Profile updated' });
});
