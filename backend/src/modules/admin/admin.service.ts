import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { config } from '../../config/env';
import { query, queryOne, withTransaction } from '../../db/pool';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { recordAudit } from '../audit/audit.service';
import type { RefreshContext } from '../auth/token.service';
import type { Role } from '../../types/express';

export interface AdminUserRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  created_at: Date;
  last_login_at: Date | null;
  must_change_password: boolean;
}

const ADMIN_STATUS_LOCK = 918_273_646;

/** Lists all admin accounts. */
export async function listAdmins(): Promise<AdminUserRow[]> {
  return query<AdminUserRow>(
    `SELECT id, email, full_name, status, created_at, last_login_at, must_change_password
       FROM users
      WHERE role = 'admin'
      ORDER BY created_at ASC`,
  );
}

/**
 * Creates a new admin account.
 *
 * - Generates a strong random temporary password.
 * - Sets must_change_password = true.
 * - Returns the plain-text temporary password ONCE — it is never stored in
 *   plain text and never logged.
 * - Writes the event to the audit chain.
 */
export async function createAdminUser(
  actorId: string,
  input: { fullName: string; email: string },
  context: RefreshContext & { requestId?: string },
): Promise<{ userId: string; temporaryPassword: string }> {
  const email = input.email.trim().toLowerCase();

  const existing = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) throw conflict('An account with that email already exists');

  // Generate a 20-character random temporary password.
  // It satisfies the password policy (letters + digits + length).
  const temporaryPassword =
    crypto.randomBytes(15).toString('base64url').slice(0, 16) + 'Aa1!';

  const passwordHash = await bcrypt.hash(temporaryPassword, config.BCRYPT_COST);

  const userId = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, full_name, status, must_change_password)
       VALUES ($1, $2, 'admin', $3, 'active', true)
       RETURNING id`,
      [email, passwordHash, input.fullName.trim()],
    );
    const id = inserted.rows[0].id;

    await recordAudit(
      {
        actorUserId: actorId,
        actorRole: 'admin' as Role,
        action: 'admin.user_created',
        entityType: 'user',
        entityId: id,
        detail: { email, fullName: input.fullName, createdBy: actorId },
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
        requestId: context.requestId ?? null,
      },
      client,
    );

    return id;
  });

  return { userId, temporaryPassword };
}

/**
 * Suspends an admin account.
 * Guards:
 *  - Cannot suspend your own account.
 *  - Cannot suspend the last active admin.
 */
export async function suspendAdmin(
  actorId: string,
  targetId: string,
  context: RefreshContext & { requestId?: string },
): Promise<void> {
  if (actorId === targetId) {
    throw forbidden('You cannot suspend your own admin account');
  }

  await withTransaction(async (client) => {
    // Serialize admin status changes so concurrent requests cannot suspend
    // every active admin based on the same pre-update count.
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_STATUS_LOCK]);

    const targetResult = await client.query<{ id: string; role: string; status: string }>(
      'SELECT id, role, status FROM users WHERE id = $1',
      [targetId],
    );
    const target = targetResult.rows[0];
    if (!target) throw notFound('Admin account not found');
    if (target.role !== 'admin') throw badRequest('This account is not an admin');
    if (target.status === 'suspended') return; // idempotent

    const activeCount = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND status = 'active'`,
    );
    if ((activeCount.rows[0]?.count ?? 0) <= 1) {
      throw forbidden('Cannot suspend the last active admin account');
    }

    await client.query("UPDATE users SET status = 'suspended' WHERE id = $1", [targetId]);

    await recordAudit(
      {
        actorUserId: actorId,
        actorRole: 'admin' as Role,
        action: 'admin.user_suspended',
        entityType: 'user',
        entityId: targetId,
        detail: { suspendedBy: actorId },
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
        requestId: context.requestId ?? null,
      },
      client,
    );
  });
}

/** Reactivates a suspended admin account. */
export async function reactivateAdmin(
  actorId: string,
  targetId: string,
  context: RefreshContext & { requestId?: string },
): Promise<void> {
  await withTransaction(async (client) => {
    const targetResult = await client.query<{ id: string; role: string; status: string }>(
      'SELECT id, role, status FROM users WHERE id = $1',
      [targetId],
    );
    const target = targetResult.rows[0];
    if (!target) throw notFound('Admin account not found');
    if (target.role !== 'admin') throw badRequest('This account is not an admin');
    if (target.status === 'active') return; // idempotent

    await client.query("UPDATE users SET status = 'active' WHERE id = $1", [targetId]);

    await recordAudit(
      {
        actorUserId: actorId,
        actorRole: 'admin' as Role,
        action: 'admin.user_reactivated',
        entityType: 'user',
        entityId: targetId,
        detail: { reactivatedBy: actorId },
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
        requestId: context.requestId ?? null,
      },
      client,
    );
  });
}
