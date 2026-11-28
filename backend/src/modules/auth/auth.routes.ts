import { Router } from 'express';
import { z } from 'zod';
import { queryOne } from '../../db/pool';
import { clearRefreshCookie, setRefreshCookie } from '../../lib/cookies';
import { unauthorized } from '../../lib/errors';
import { requireAuth, requireRole } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import { clientIp, userAgent } from '../../middleware/requestContext';
import { validate } from '../../middleware/validate';
import { changePassword, login, logout, register, forceChangePassword } from './auth.service';
import { rotateRefreshToken, signAccessToken } from './token.service';
import { getProfileSummary } from '../users/users.service';
import {
  decideLoginApproval,
  listApprovalHistory,
  listPendingApprovals,
  listStaffAccounts,
  pollLoginApproval,
  setStaffAccountStatus,
  setStaffAccountTier,
} from './login-approval.service';
import type { Role, StaffTier } from '../../types/express';

/**
 * Authentication endpoints.
 * Passwords are validated for length + character classes here; hashing and
 * lockout logic live in the service.
 */
const emailSchema = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/, 'must be a valid email address');

const passwordSchema = z
  .string()
  .min(10, 'use at least 10 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'must contain a letter')
  .regex(/\d/, 'must contain a number');

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(120),
  // Borrowers self-register freely. Staff registration requires a valid invite
  // code (checked in auth.service.ts). Admin accounts cannot be self-registered —
  // the enum only permits 'borrower' and 'staff'; the backend also rejects 'admin'
  // explicitly so a crafted request cannot bypass the UI constraint.
  role: z.enum(['borrower', 'staff']),
  inviteCode: z.string().max(128).optional(),
  staffId: z.string().trim().max(80).optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

const pollTokenSchema = z.object({
  pollToken: z.string().min(16).max(128),
});

const decideSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  reason: z.string().trim().max(500).optional(),
});

const staffStatusSchema = z.object({
  action: z.enum(['approve-account', 'suspend', 'reactivate']),
});

const staffTierSchema = z.object({
  tier: z.enum(['regular', 'supervisor', 'finance_manager']),
});

export const authRouter = Router();

authRouter.post('/register', authLimiter, validate(registerSchema), async (req, res) => {
  const body = req.body as z.infer<typeof registerSchema>;
  const result = await register(body, {
    ip: clientIp(req),
    userAgent: userAgent(req),
    requestId: req.requestId,
  });
  if ('pendingApproval' in result) {
    res.status(202).json({ status: 'pending_approval', user: result.user });
    return;
  }
  setRefreshCookie(res, result.refresh.token, result.refresh.expiresAt);
  res.status(201).json({ user: result.user, accessToken: result.accessToken });
});

authRouter.post('/login', authLimiter, validate(loginSchema), async (req, res) => {
  const body = req.body as z.infer<typeof loginSchema>;
  const result = await login(body.email, body.password, {
    ip: clientIp(req),
    userAgent: userAgent(req),
    requestId: req.requestId,
  });

  // Staff login — return the approval pending response without a session.
  if ('awaitingApproval' in result) {
    res.status(202).json({
      status: 'awaiting_approval',
      requestId: result.requestId,
      pollToken: result.pollToken,
      expiresAt: result.expiresAt,
    });
    return;
  }

  setRefreshCookie(res, result.refresh.token, result.refresh.expiresAt);
  res.json({ user: result.user, accessToken: result.accessToken, mustChangePassword: result.mustChangePassword ?? false });
});

authRouter.post('/refresh', async (req, res) => {
  const raw = req.cookies?.['smf_refresh'] as string | undefined;
  if (!raw) throw unauthorized('No refresh token cookie');

  const rotated = await rotateRefreshToken(raw, {
    ip: clientIp(req),
    userAgent: userAgent(req),
    requestId: req.requestId,
  });
  setRefreshCookie(res, rotated.issue.token, rotated.issue.expiresAt);

  const user = await queryOne<{
    id: string;
    email: string;
    full_name: string;
    role: Role;
    created_at: Date;
    must_change_password: boolean;
    staff_tier: StaffTier | null;
  }>(
    `SELECT u.id, u.email, u.full_name, u.role, u.created_at, u.must_change_password, sp.staff_tier
       FROM users u
       LEFT JOIN staff_profiles sp ON sp.user_id = u.id
      WHERE u.id = $1`,
    [rotated.userId],
  );
  if (!user) throw unauthorized('Account no longer exists');

  res.json({
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      staffTier: user.role === 'staff' ? (user.staff_tier ?? 'regular') : null,
      createdAt: user.created_at,
    },
    accessToken: signAccessToken({ id: user.id, role: user.role }),
    mustChangePassword: user.must_change_password,
  });
});

authRouter.post('/logout', async (req, res) => {
  const raw = req.cookies?.['smf_refresh'] as string | undefined;
  await logout(raw, { ip: clientIp(req), userAgent: userAgent(req), requestId: req.requestId });
  clearRefreshCookie(res);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const profile = await getProfileSummary(req.user!.id);
  res.json({ user: req.user, profile });
});

authRouter.patch('/password', requireAuth, validate(changePasswordSchema), async (req, res) => {
  const body = req.body as z.infer<typeof changePasswordSchema>;
  await changePassword(req.user!.id, body.currentPassword, body.newPassword, {
    ip: clientIp(req),
    userAgent: userAgent(req),
    requestId: req.requestId,
  });
  clearRefreshCookie(res);
  res.json({ message: 'Password updated. Please sign in again.' });
});

// Force-change password (for accounts with must_change_password = true).
// The user must already be authenticated (they got a session but can't
// reach other routes until they clear this flag).
authRouter.post('/password/force', requireAuth, validate(
  z.object({ newPassword: z.string().min(10).max(128).regex(/[A-Za-z]/).regex(/\d/) }),
), async (req, res) => {
  const { newPassword } = req.body as { newPassword: string };
  await forceChangePassword(req.user!.id, newPassword, {
    ip: clientIp(req),
    userAgent: userAgent(req),
    requestId: req.requestId,
  });
  clearRefreshCookie(res);
  res.json({ message: 'Password set. Please sign in again with your new password.' });
});

// ---------------------------------------------------------------------------
// Staff login polling — no auth token required (staff doesn't have one yet).
// ---------------------------------------------------------------------------
authRouter.get(
  '/login-requests/:id/status',
  authLimiter,
  validate(pollTokenSchema, 'query'),
  async (req, res) => {
    const { pollToken } = req.query as z.infer<typeof pollTokenSchema>;
    const result = await pollLoginApproval(pollToken, {
      ip: clientIp(req),
      userAgent: userAgent(req),
      requestId: req.requestId,
    });

    if (result.status === 'approved') {
      setRefreshCookie(res, result.refresh.token, result.refresh.expiresAt);
      res.json({
        status: 'approved',
        user: result.user,
        accessToken: result.accessToken,
      });
      return;
    }

    res.json(result);
  },
);

// ---------------------------------------------------------------------------
// Admin-only: login approval management
// ---------------------------------------------------------------------------
authRouter.get('/login-requests', requireAuth, requireRole('admin'), async (req, res) => {
  const rows = await listPendingApprovals(req.user!.id);
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      staffUserId: r.staff_user_id,
      staffName: r.staff_full_name,
      staffEmail: r.staff_email,
      requestedAt: r.requested_at,
      expiresAt: r.expires_at,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
    })),
  });
});

authRouter.get('/login-requests/history', requireAuth, requireRole('admin'), async (req, res) => {
  const rows = await listApprovalHistory(req.user!.id);
  res.json({ items: rows });
});

authRouter.post(
  '/login-requests/:id/decide',
  requireAuth,
  requireRole('admin'),
  validate(decideSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof decideSchema>;
    await decideLoginApproval(req.user!.id, req.params.id as string, body, {
      ip: clientIp(req),
      userAgent: userAgent(req),
      requestId: req.requestId,
    });
    res.json({ ok: true });
  },
);

authRouter.get('/staff-accounts', requireAuth, requireRole('admin'), async (_req, res) => {
  const rows = await listStaffAccounts();
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      status: r.status,
      staffTier: r.staff_tier ?? 'regular',
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
    })),
  });
});

authRouter.post(
  '/staff-accounts/:id/tier',
  requireAuth,
  requireRole('admin'),
  validate(staffTierSchema),
  async (req, res) => {
    const { tier } = req.body as z.infer<typeof staffTierSchema>;
    await setStaffAccountTier(req.user!.id, req.params.id as string, tier, {
      ip: clientIp(req),
      userAgent: userAgent(req),
      requestId: req.requestId,
    });
    res.json({ ok: true });
  },
);

authRouter.post(
  '/staff-accounts/:id/status',
  requireAuth,
  requireRole('admin'),
  validate(staffStatusSchema),
  async (req, res) => {
    const { action } = req.body as z.infer<typeof staffStatusSchema>;
    const newStatus: 'active' | 'pending' | 'suspended' =
      action === 'approve-account' ? 'active' : action === 'suspend' ? 'suspended' : 'active';
    await setStaffAccountStatus(req.user!.id, req.params.id as string, newStatus, {
      ip: clientIp(req),
      userAgent: userAgent(req),
      requestId: req.requestId,
    });
    res.json({ ok: true });
  },
);
