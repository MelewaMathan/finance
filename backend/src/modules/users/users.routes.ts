import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../db/pool';
import {
  encryptField,
  nationalIdBlindIndex,
  normalizeNationalId,
  normalizePhone,
  phoneBlindIndex,
} from '../../lib/crypto';
import { badRequest, forbidden } from '../../lib/errors';
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
  nationalId: z.string().trim().min(5).max(32).optional(),
  phone: z.string().trim().min(9).max(20).optional(),
  occupation: z.string().trim().max(80).optional(),
  monthlyIncomeCents: z.number().int().min(0).max(1_000_000_000).optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
    .optional(),
  address: z.string().trim().max(200).optional(),
});

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
  const auditDetail: Record<string, unknown> = {};

  const push = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (body.nationalId) {
    const normalized = normalizeNationalId(body.nationalId);
    push('national_id_enc', encryptField(body.nationalId));
    push('national_id_bi', nationalIdBlindIndex(body.nationalId));
    auditDetail.nationalIdUpdated = true;
    // Flag duplicates across accounts (fraud module owns the flag itself).
    await detectIdentityConflicts({ userId: req.user!.id, nationalIdBi: nationalIdBlindIndex(body.nationalId) });
    if (!normalized) throw badRequest('National ID is not usable');
  }
  if (body.phone) {
    push('phone_enc', encryptField(normalizePhone(body.phone)));
    push('phone_bi', phoneBlindIndex(body.phone));
    auditDetail.phoneUpdated = true;
    await detectIdentityConflicts({ userId: req.user!.id, phoneBi: phoneBlindIndex(body.phone) });
  }
  if (body.occupation !== undefined) {
    push('occupation', body.occupation);
    auditDetail.occupationUpdated = true;
  }
  if (body.monthlyIncomeCents !== undefined) {
    push('monthly_income_cents', body.monthlyIncomeCents);
    auditDetail.monthlyIncomeUpdated = true;
  }
  if (body.dateOfBirth) {
    push('date_of_birth_enc', encryptField(body.dateOfBirth));
    auditDetail.dateOfBirthUpdated = true;
  }
  if (body.address) {
    push('address_enc', encryptField(body.address));
    auditDetail.addressUpdated = true;
  }

  if (sets.length === 0) throw badRequest('No profile fields supplied');

  values.push(req.user!.id);
  await query(
    `UPDATE borrower_profiles SET ${sets.join(', ')} WHERE user_id = $${values.length}`,
    values,
  );

  await auditRequest(req, 'profile.update', 'borrower_profile', req.user!.id, auditDetail);

  const profile = await getProfileSummary(req.user!.id);
  res.json({ profile, message: 'Profile updated' });
});
