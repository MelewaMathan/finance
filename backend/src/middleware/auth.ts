import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { queryOne } from '../db/pool';
import { unauthorized, forbidden } from '../lib/errors';
import type { Role } from '../types/express';

const accessPayload = z.object({
  sub: z.string().uuid(),
  role: z.enum(['borrower', 'staff', 'auditor']),
  typ: z.literal('access'),
});

/**
 * Verifies the Bearer access token and re-loads the principal from the
 * database. The DB read is deliberate: a suspended account loses access
 * immediately instead of waiting for its 15-minute token to expire.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw unauthorized('Missing bearer token');
    }
    const token = header.slice('Bearer '.length);
    const { verifyAccessToken } = await import('../modules/auth/token.service');
    const payload = verifyAccessToken(token);
    const parsed = accessPayload.parse(payload);

    const user = await queryOne<{ id: string; email: string; role: Role; full_name: string; status: string }>(
      'SELECT id, email, role, full_name, status FROM users WHERE id = $1',
      [parsed.sub],
    );
    if (!user) throw unauthorized('Account no longer exists');
    if (user.status !== 'active') throw forbidden('This account is not active');

    req.user = { id: user.id, email: user.email, role: user.role, fullName: user.full_name };
    next();
  } catch (error) {
    next(error);
  }
}

/** Role gate. Use per route, e.g. requireRole('staff'). */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(forbidden(`Requires role: ${roles.join(' or ')}`));
      return;
    }
    next();
  };
}

/**
 * Auditors are strictly read-only. Applied to every state-changing route so
 * the guarantee is enforced by middleware, not by remembering to check.
 */
export function denyAuditorWrites(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role === 'auditor') {
    next(forbidden('Forensic auditors have read-only access'));
    return;
  }
  next();
}
