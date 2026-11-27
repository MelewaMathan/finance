import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { clientIp, userAgent } from '../../middleware/requestContext';
import { getInstitutionLoanSettings, updateInstitutionLoanSettings } from './loanSettings.service';
import { createAdminUser, listAdmins, reactivateAdmin, suspendAdmin } from './admin.service';
import { DEFAULT_STAFF_INVITE_CODES } from '../auth/auth.service';

/**
 * Admin-management endpoints — admin role required on every route.
 * Staff and borrowers receive 403 from requireRole('admin').
 */
export const adminRouter = Router();

// All routes in this file require admin role.
adminRouter.use(requireAuth, requireRole('admin'));

const createAdminSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z
    .string()
    .trim()
    .max(254)
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/, 'must be a valid email address'),
});

const statusActionSchema = z.object({
  action: z.enum(['suspend', 'reactivate']),
});

const loanSettingsSchema = z
  .object({
    interestRateBps: z.number().int().min(0).max(10_000),
    minPrincipalCents: z.number().int().positive().max(1_000_000_000),
    maxPrincipalCents: z.number().int().positive().max(1_000_000_000),
    maxInstallments: z.number().int().min(1).max(365),
    allowedFrequencies: z.array(z.enum(['daily', 'weekly', 'monthly'])).min(1).max(3),
    institutionName: z.string().trim().min(2).max(120),
  })
  .refine((value) => value.minPrincipalCents <= value.maxPrincipalCents, {
    message: 'Minimum amount cannot exceed maximum amount',
    path: ['maxPrincipalCents'],
  })
  .refine((value) => new Set(value.allowedFrequencies).size === value.allowedFrequencies.length, {
    message: 'Repayment frequencies must be unique',
    path: ['allowedFrequencies'],
  });

adminRouter.get('/loan-settings', async (_req, res) => {
  res.json({ settings: await getInstitutionLoanSettings() });
});

adminRouter.get('/staff-invite-codes', async (_req, res) => {
  res.json({ codes: DEFAULT_STAFF_INVITE_CODES });
});

adminRouter.put('/loan-settings', validate(loanSettingsSchema), async (req, res) => {
  const settings = await updateInstitutionLoanSettings(
    req.user!.id,
    req.body as z.infer<typeof loanSettingsSchema>,
    req,
  );
  res.json({ settings });
});

/** List all admin accounts. */
adminRouter.get('/users', async (_req, res) => {
  const rows = await listAdmins();
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      status: r.status,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      mustChangePassword: r.must_change_password,
    })),
  });
});

/**
 * Create a new admin account.
 * Returns the temporary password once — store it somewhere safe
 * before closing the response.
 */
adminRouter.post('/users', validate(createAdminSchema), async (req, res) => {
  const body = req.body as z.infer<typeof createAdminSchema>;
  const result = await createAdminUser(req.user!.id, body, {
    ip: clientIp(req),
    userAgent: userAgent(req),
    requestId: req.requestId,
  });
  res.status(201).json({
    userId: result.userId,
    // The plain-text password is returned ONLY on creation and never stored.
    temporaryPassword: result.temporaryPassword,
    message:
      'Admin account created. Share the temporary password with the new admin. ' +
      'They will be forced to change it on first login.',
  });
});

/** Suspend or reactivate an admin. */
adminRouter.post(
  '/users/:id/status',
  validate(statusActionSchema),
  async (req, res) => {
    const { action } = req.body as z.infer<typeof statusActionSchema>;
    const context = {
      ip: clientIp(req),
      userAgent: userAgent(req),
      requestId: req.requestId,
    };
    if (action === 'suspend') {
      await suspendAdmin(req.user!.id, req.params.id as string, context);
    } else {
      await reactivateAdmin(req.user!.id, req.params.id as string, context);
    }
    res.json({ ok: true });
  },
);
