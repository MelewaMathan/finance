import bcrypt from 'bcryptjs';
import { config } from '../../config/env';
import { query, queryOne, withTransaction } from '../../db/pool';
import { conflict, locked, unauthorized } from '../../lib/errors';
import { recordAudit } from '../audit/audit.service';
import type { Role } from '../../types/express';
import {
  issueRefreshToken,
  revokeAllSessions,
  signAccessToken,
  type RefreshContext,
  type RefreshIssue,
} from './token.service';
import { createLoginApproval } from './login-approval.service';

/**
 * Authentication service.
 *
 * Security properties implemented here:
 *  - bcrypt (cost 12) hashing, never reversible, never logged
 *  - account lockout after N failed attempts
 *  - a single generic message for "unknown email" and "wrong password" so the
 *    endpoint cannot be used to enumerate accounts
 *  - every success and failure is written to the audit chain
 *  - staff logins require auditor approval before a session is issued
 */
export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  /** Public registration creates borrowers; staff registration requires a valid invite code. */
  role: 'borrower' | 'staff';
  /** Required when role === 'staff'. Must match STAFF_INVITE_CODE. */
  inviteCode?: string;
  /** Optional staff identifier shown on profiles. */
  staffId?: string;
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refresh: RefreshIssue;
}

/** Returned instead of AuthResult when a staff login needs auditor approval. */
export interface StaffApprovalPending {
  awaitingApproval: true;
  requestId: string;
  pollToken: string;
  expiresAt: string; // ISO
}

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  createdAt: string;
}

function toPublicUser(row: { id: string; email: string; full_name: string; role: Role; created_at: Date }): PublicUser {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function register(input: RegisterInput, context: RefreshContext & { requestId?: string }): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const existing = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) throw conflict('An account with that email already exists');

  // Staff self-registration requires a valid invite code (enforced on the
  // backend regardless of what the UI sends). Auditor accounts cannot be
  // created through this endpoint at all.
  if (input.role === 'staff') {
    if (!input.inviteCode || input.inviteCode !== config.STAFF_INVITE_CODE) {
      throw unauthorized('Invalid or missing staff invite code');
    }
  }

  const passwordHash = await bcrypt.hash(input.password, config.BCRYPT_COST);

  const user = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string; email: string; full_name: string; role: Role; created_at: Date }>(
      `INSERT INTO users (email, password_hash, role, full_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, full_name, role, created_at`,
      [email, passwordHash, input.role, input.fullName],
    );
    const created = inserted.rows[0];

    if (input.role === 'borrower') {
      await client.query('INSERT INTO borrower_profiles (user_id) VALUES ($1)', [created.id]);
    }

    if (input.role === 'staff') {
      await client.query('INSERT INTO lender_profiles (user_id, staff_id) VALUES ($1, $2)', [
        created.id,
        input.staffId ?? null,
      ]);
    }

    // Audit inside the same transaction so "user created" and "audit row"
    // can never disagree.
    await recordAudit(
      {
        actorUserId: created.id,
        actorRole: created.role,
        action: 'auth.register',
        entityType: 'user',
        entityId: created.id,
        detail: { email, role: created.role },
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
        requestId: context.requestId ?? null,
      },
      client,
    );

    return created;
  });

  const refresh = await issueRefreshToken(user.id, context);
  return {
    user: toPublicUser(user),
    accessToken: signAccessToken({ id: user.id, role: user.role }),
    refresh,
  };
}

export async function login(
  emailInput: string,
  password: string,
  context: RefreshContext & { requestId?: string },
): Promise<AuthResult | StaffApprovalPending> {
  const email = normalizeEmail(emailInput);
  const row = await queryOne<{
    id: string;
    email: string;
    password_hash: string;
    role: Role;
    full_name: string;
    status: string;
    failed_attempts: number;
    locked_until: Date | null;
    created_at: Date;
  }>('SELECT * FROM users WHERE email = $1', [email]);

  // Constant-ish work regardless of whether the account exists.
  const hashToCheck = row?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const passwordOk = await bcrypt.compare(password, hashToCheck);

  const auditFailure = async (reason: string) => {
    await recordAudit({
      actorUserId: row?.id ?? null,
      actorRole: row?.role ?? null,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: row?.id ?? null,
      detail: { email, reason },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      requestId: context.requestId ?? null,
    });
  };

  if (!row) {
    await auditFailure('unknown_email');
    throw unauthorized('Invalid email or password');
  }

  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    await auditFailure('account_locked');
    throw locked('Account temporarily locked after repeated failed logins');
  }

  if (!passwordOk) {
    const attempts = row.failed_attempts + 1;
    const shouldLock = attempts >= config.LOGIN_MAX_ATTEMPTS;
    await query(
      `UPDATE users
          SET failed_attempts = $2,
              locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
        WHERE id = $1`,
      [row.id, shouldLock ? 0 : attempts, shouldLock, String(config.LOGIN_LOCK_MINUTES)],
    );
    await auditFailure(shouldLock ? 'locked_out' : 'bad_password');
    throw unauthorized('Invalid email or password');
  }

  // Staff accounts that are 'pending' or 'suspended' get the same generic
  // response as an invalid login — never reveal account status to the caller.
  if (row.role === 'staff' && row.status !== 'active') {
    await auditFailure(`staff_${row.status}`);
    throw unauthorized('Invalid email or password');
  }

  // Non-staff inactive accounts.
  if (row.role !== 'staff' && row.status !== 'active') {
    await auditFailure('inactive_account');
    throw unauthorized('This account is not active');
  }

  // -------------------------------------------------------------------------
  // Staff login: correct password + active account → create an approval
  // request and return a poll token instead of a real session.
  // -------------------------------------------------------------------------
  if (row.role === 'staff') {
    // Reset failed_attempts on a correct password, even though we won't issue
    // a session yet — the lockout mechanism is about credential stuffing, not
    // about the approval flow.
    await query(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1',
      [row.id],
    );

    await auditFailure('staff_awaiting_approval'); // audit the attempt even when pending
    // Overwrite the 'failed' action with the real one.
    await recordAudit({
      actorUserId: row.id,
      actorRole: row.role,
      action: 'auth.login_staff_credentials_ok',
      entityType: 'user',
      entityId: row.id,
      detail: { email, requiresApproval: true },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      requestId: context.requestId ?? null,
    });

    const approval = await createLoginApproval(row.id, context);
    return {
      awaitingApproval: true,
      requestId: approval.requestId,
      pollToken: approval.pollToken,
      expiresAt: approval.expiresAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Borrower / Auditor — issue a session immediately (unchanged behaviour).
  // -------------------------------------------------------------------------
  await query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [row.id]);
  await recordAudit({
    actorUserId: row.id,
    actorRole: row.role,
    action: 'auth.login',
    entityType: 'user',
    entityId: row.id,
    detail: { email },
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    requestId: context.requestId ?? null,
  });

  const refresh = await issueRefreshToken(row.id, context);
  return {
    user: toPublicUser(row),
    accessToken: signAccessToken({ id: row.id, role: row.role }),
    refresh,
  };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  context: RefreshContext & { requestId?: string },
): Promise<void> {
  const row = await queryOne<{ password_hash: string; role: Role }>(
    'SELECT password_hash, role FROM users WHERE id = $1',
    [userId],
  );
  if (!row) throw unauthorized('Account not found');

  const ok = await bcrypt.compare(currentPassword, row.password_hash);
  if (!ok) {
    await recordAudit({
      actorUserId: userId,
      actorRole: row.role,
      action: 'auth.password_change_failed',
      entityType: 'user',
      entityId: userId,
      detail: { reason: 'bad_current_password' },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      requestId: context.requestId ?? null,
    });
    throw unauthorized('Current password is incorrect');
  }

  const hash = await bcrypt.hash(newPassword, config.BCRYPT_COST);
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
  await revokeAllSessions(userId);

  await recordAudit({
    actorUserId: userId,
    actorRole: row.role,
    action: 'auth.password_change',
    entityType: 'user',
    entityId: userId,
    detail: { sessionsRevoked: true },
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    requestId: context.requestId ?? null,
  });
}

export async function logout(rawToken: string | undefined, context: RefreshContext & { requestId?: string; userId?: string }): Promise<void> {
  if (rawToken) {
    const { revokeRefreshToken } = await import('./token.service');
    await revokeRefreshToken(rawToken);
  }
  await recordAudit({
    actorUserId: context.userId ?? null,
    actorRole: null,
    action: 'auth.logout',
    entityType: 'session',
    entityId: context.userId ?? null,
    detail: { hadToken: Boolean(rawToken) },
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    requestId: context.requestId ?? null,
  });
}
