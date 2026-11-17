import { query, queryOne, withTransaction } from '../../db/pool';
import { randomToken, sha256Hex } from '../../lib/crypto';
import { notFound, forbidden, conflict, tooMany } from '../../lib/errors';
import { recordAudit } from '../audit/audit.service';
import { issueRefreshToken, signAccessToken } from './token.service';
import type { RefreshContext } from './token.service';
import type { Role } from '../../types/express';

/** How long a pending approval request remains valid (10 minutes). */
const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** Max pending requests per staff user at any time (spam guard). */
const MAX_PENDING_PER_USER = 1;

export interface PendingApprovalRow {
  id: string;
  staff_user_id: string;
  status: string;
  requested_at: Date;
  expires_at: Date;
  ip_address: string | null;
  user_agent: string | null;
  staff_full_name: string;
  staff_email: string;
}

/**
 * Creates a login_approval row after a staff member has supplied the
 * correct password. Returns a poll token (opaque, single-use) that the
 * client uses to check approval status.
 *
 * Throws conflict(429-ish) if a pending request already exists for this user,
 * to prevent spamming the auditor.
 */
export async function createLoginApproval(
  staffUserId: string,
  context: RefreshContext & { requestId?: string },
): Promise<{ requestId: string; pollToken: string; expiresAt: Date }> {
  // Expire old pending rows for this user first.
  await query(
    `UPDATE login_approvals
        SET status = 'expired'
      WHERE staff_user_id = $1
        AND status = 'pending'
        AND expires_at < now()`,
    [staffUserId],
  );

  // Check for an existing pending request.
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM login_approvals
      WHERE staff_user_id = $1 AND status = 'pending'`,
    [staffUserId],
  );
  if (existing) {
    throw tooMany(
      'A login approval request is already pending. Please wait for it to expire or be decided.',
    );
  }

  const pollToken = randomToken(32);
  const pollTokenHash = sha256Hex(pollToken);
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);

  const row = await queryOne<{ id: string }>(
    `INSERT INTO login_approvals
       (staff_user_id, status, expires_at, ip_address, user_agent, poll_token_hash)
     VALUES ($1, 'pending', $2, $3, $4, $5)
     RETURNING id`,
    [
      staffUserId,
      expiresAt,
      context.ip ?? null,
      context.userAgent ?? null,
      pollTokenHash,
    ],
  );
  if (!row) throw new Error('Failed to create login approval row');

  await recordAudit({
    actorUserId: staffUserId,
    actorRole: 'staff',
    action: 'auth.login_approval_requested',
    entityType: 'login_approval',
    entityId: row.id,
    detail: { ip: context.ip ?? null },
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    requestId: context.requestId ?? null,
  });

  return { requestId: row.id, pollToken, expiresAt };
}

/**
 * Checks the status of a login approval request via the poll token.
 *
 * - 'pending' → still waiting.
 * - 'approved' → issues a real session ONCE and marks the row 'used'.
 * - anything else → no session, return the status so the client can show
 *   an appropriate message.
 *
 * The session is issued inside a transaction that atomically flips the row
 * to 'used', so the token cannot be replayed.
 */
export async function pollLoginApproval(
  pollToken: string,
  context: RefreshContext & { requestId?: string },
): Promise<
  | { status: 'pending'; expiresAt: Date }
  | { status: 'approved'; user: { id: string; email: string; fullName: string; role: Role; createdAt: string }; accessToken: string; refresh: { token: string; expiresAt: Date; familyId: string } }
  | { status: 'denied'; reason: string | null }
  | { status: 'expired' }
  | { status: 'used' }
> {
  const tokenHash = sha256Hex(pollToken);

  // Expire stale requests before checking.
  await query(
    `UPDATE login_approvals SET status = 'expired'
      WHERE status = 'pending' AND expires_at < now()`,
  );

  const row = await queryOne<{
    id: string;
    staff_user_id: string;
    status: string;
    expires_at: Date;
    decision_reason: string | null;
  }>(
    `SELECT id, staff_user_id, status, expires_at, decision_reason
       FROM login_approvals
      WHERE poll_token_hash = $1`,
    [tokenHash],
  );

  if (!row) throw notFound('Login request not found or already used');

  if (row.status === 'pending') {
    return { status: 'pending', expiresAt: row.expires_at };
  }
  if (row.status === 'denied') {
    return { status: 'denied', reason: row.decision_reason };
  }
  if (row.status === 'expired') {
    return { status: 'expired' };
  }
  if (row.status === 'used') {
    return { status: 'used' };
  }

  // status === 'approved' — issue session exactly once.
  return withTransaction(async (client) => {
    // Atomic claim: flip 'approved' → 'used' in one UPDATE.
    const claimed = await client.query<{ id: string }>(
      `UPDATE login_approvals
          SET status = 'used'
        WHERE id = $1 AND status = 'approved'
        RETURNING id`,
      [row.id],
    );
    if (claimed.rowCount === 0) {
      // Another request raced and already used it.
      return { status: 'used' as const };
    }

    const user = await client.query<{
      id: string;
      email: string;
      full_name: string;
      role: Role;
      status: string;
      created_at: Date;
    }>('SELECT id, email, full_name, role, status, created_at FROM users WHERE id = $1', [
      row.staff_user_id,
    ]);
    const u = user.rows[0];
    if (!u || u.status !== 'active') {
      throw forbidden('Account is no longer active');
    }

    // Update last_login_at.
    await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);

    const refresh = await issueRefreshToken(u.id, context);

    await recordAudit(
      {
        actorUserId: u.id,
        actorRole: u.role,
        action: 'auth.login',
        entityType: 'user',
        entityId: u.id,
        detail: { approvalId: row.id, via: 'approval_flow' },
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
        requestId: context.requestId ?? null,
      },
      client,
    );

    return {
      status: 'approved' as const,
      user: {
        id: u.id,
        email: u.email,
        fullName: u.full_name,
        role: u.role,
        createdAt: new Date(u.created_at).toISOString(),
      },
      accessToken: signAccessToken({ id: u.id, role: u.role }),
      refresh,
    };
  });
}

/** Lists pending login approval requests for the auditor. */
export async function listPendingApprovals(auditorId: string): Promise<PendingApprovalRow[]> {
  // Expire stale rows first.
  await query(
    `UPDATE login_approvals SET status = 'expired'
      WHERE status = 'pending' AND expires_at < now()`,
  );

  return query<PendingApprovalRow>(
    `SELECT
       la.id,
       la.staff_user_id,
       la.status,
       la.requested_at,
       la.expires_at,
       la.ip_address,
       la.user_agent,
       u.full_name  AS staff_full_name,
       u.email      AS staff_email
       FROM login_approvals la
       JOIN users u ON u.id = la.staff_user_id
      WHERE la.status = 'pending'
      ORDER BY la.requested_at ASC`,
  );
}

/** History of past decisions (last 100). */
export async function listApprovalHistory(auditorId: string) {
  return query<{
    id: string;
    staff_full_name: string;
    staff_email: string;
    status: string;
    requested_at: Date;
    decided_at: Date | null;
    decision_reason: string | null;
    decided_by_name: string | null;
  }>(
    `SELECT
       la.id,
       su.full_name AS staff_full_name,
       su.email     AS staff_email,
       la.status,
       la.requested_at,
       la.decided_at,
       la.decision_reason,
       au.full_name AS decided_by_name
       FROM login_approvals la
       JOIN users su ON su.id = la.staff_user_id
       LEFT JOIN users au ON au.id = la.decided_by
      WHERE la.status <> 'pending'
      ORDER BY la.requested_at DESC
      LIMIT 100`,
  );
}

export interface DecideApprovalInput {
  decision: 'approve' | 'deny';
  reason?: string;
}

/**
 * Auditor approves or denies a pending login request.
 * An auditor cannot approve their own login (they can't have a login_approval
 * row since only staff get them, but we guard explicitly anyway).
 */
export async function decideLoginApproval(
  auditorId: string,
  approvalId: string,
  input: DecideApprovalInput,
  context: RefreshContext & { requestId?: string },
): Promise<void> {
  // Expire stale rows first.
  await query(
    `UPDATE login_approvals SET status = 'expired'
      WHERE status = 'pending' AND expires_at < now()`,
  );

  const row = await queryOne<{
    id: string;
    staff_user_id: string;
    status: string;
  }>(
    `SELECT id, staff_user_id, status FROM login_approvals WHERE id = $1`,
    [approvalId],
  );

  if (!row) throw notFound('Login approval request not found');

  // Guard: an auditor cannot approve their own login attempt.
  if (row.staff_user_id === auditorId) {
    throw forbidden('An auditor cannot approve their own login request');
  }

  if (row.status !== 'pending') {
    throw conflict(`This request is already ${row.status}`);
  }

  if (input.decision === 'deny' && !input.reason?.trim()) {
    throw conflict('A reason is required when denying a login request');
  }

  const newStatus = input.decision === 'approve' ? 'approved' : 'denied';

  await query(
    `UPDATE login_approvals
        SET status = $2,
            decided_by = $3,
            decided_at = now(),
            decision_reason = $4
      WHERE id = $1`,
    [approvalId, newStatus, auditorId, input.reason ?? null],
  );

  await recordAudit({
    actorUserId: auditorId,
    actorRole: 'auditor',
    action: `auth.login_approval_${newStatus}`,
    entityType: 'login_approval',
    entityId: approvalId,
    detail: {
      staffUserId: row.staff_user_id,
      reason: input.reason ?? null,
    },
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    requestId: context.requestId ?? null,
  });
}

/** Lists all staff users with their account status (for the auditor). */
export async function listStaffAccounts() {
  return query<{
    id: string;
    email: string;
    full_name: string;
    status: string;
    created_at: Date;
    last_login_at: Date | null;
  }>(
    `SELECT id, email, full_name, status, created_at, last_login_at
       FROM users
      WHERE role = 'staff'
      ORDER BY created_at DESC`,
  );
}

export async function setStaffAccountStatus(
  auditorId: string,
  staffUserId: string,
  newStatus: 'active' | 'pending' | 'suspended',
  context: RefreshContext & { requestId?: string },
): Promise<void> {
  const user = await queryOne<{ id: string; role: string; status: string }>(
    'SELECT id, role, status FROM users WHERE id = $1',
    [staffUserId],
  );
  if (!user) throw notFound('Staff account not found');
  if (user.role !== 'staff') throw forbidden('This endpoint is for staff accounts only');
  if (user.status === newStatus) return; // idempotent

  await query('UPDATE users SET status = $2 WHERE id = $1', [staffUserId, newStatus]);

  await recordAudit({
    actorUserId: auditorId,
    actorRole: 'auditor',
    action: `auth.staff_account_${newStatus === 'active' ? 'activated' : newStatus === 'suspended' ? 'suspended' : 'pending'}`,
    entityType: 'user',
    entityId: staffUserId,
    detail: { previousStatus: user.status, newStatus },
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    requestId: context.requestId ?? null,
  });
}
