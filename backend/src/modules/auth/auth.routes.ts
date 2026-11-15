import { Router } from 'express';
import { z } from 'zod';
import { queryOne } from '../../db/pool';
import { clearRefreshCookie, setRefreshCookie } from '../../lib/cookies';
import { unauthorized } from '../../lib/errors';
import { requireAuth } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import { clientIp, userAgent } from '../../middleware/requestContext';
import { validate } from '../../middleware/validate';
import { changePassword, login, logout, register } from './auth.service';
import { rotateRefreshToken, signAccessToken } from './token.service';
import { getProfileSummary } from '../users/users.service';
import type { Role } from '../../types/express';

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
  // code (checked in auth.service.ts). Auditor accounts cannot be self-registered.
  role: z.enum(['borrower', 'staff']),
  // Required when role === 'staff'; the backend validates it against STAFF_INVITE_CODE.
  inviteCode: z.string().max(128).optional(),
  // Optional staff identifier.
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

export const authRouter = Router();

authRouter.post('/register', authLimiter, validate(registerSchema), async (req, res) => {
  const body = req.body as z.infer<typeof registerSchema>;
  const result = await register(body, {
    ip: clientIp(req),
    userAgent: userAgent(req),
    requestId: req.requestId,
  });
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
  setRefreshCookie(res, result.refresh.token, result.refresh.expiresAt);
  res.json({ user: result.user, accessToken: result.accessToken });
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

  const user = await queryOne<{ id: string; email: string; full_name: string; role: Role; created_at: Date }>(
    'SELECT id, email, full_name, role, created_at FROM users WHERE id = $1',
    [rotated.userId],
  );
  if (!user) throw unauthorized('Account no longer exists');

  res.json({
    user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role, createdAt: user.created_at },
    accessToken: signAccessToken({ id: user.id, role: user.role }),
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
  // All refresh tokens were revoked, so the client must log in again.
  clearRefreshCookie(res);
  res.json({ message: 'Password updated. Please sign in again.' });
});
