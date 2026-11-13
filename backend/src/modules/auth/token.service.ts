import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config/env';
import { query, queryOne } from '../../db/pool';
import { randomToken, sha256Hex } from '../../lib/crypto';
import { unauthorized } from '../../lib/errors';
import { recordAudit } from '../audit/audit.service';
import type { Role } from '../../types/express';

/**
 * Token strategy.
 *
 * Access token  : short-lived JWT (15m), sent as `Authorization: Bearer`,
 *                 kept in memory by the SPA -- never in localStorage.
 * Refresh token : opaque 48-byte random value in an httpOnly cookie and
 *                 stored only as a SHA-256 hash. Rotated on every use; if a
 *                 already-rotated token is replayed the whole family is
 *                 revoked (refresh-token reuse detection).
 */
export interface AccessTokenPayload {
  sub: string;
  role: Role;
  typ: 'access';
  iat?: number;
  exp?: number;
}

export function signAccessToken(user: { id: string; role: Role }): string {
  return jwt.sign({ sub: user.id, role: user.role, typ: 'access' }, config.JWT_ACCESS_SECRET, {
    expiresIn: config.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    issuer: 'secure-microfinance',
    audience: 'smf-web',
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, config.JWT_ACCESS_SECRET, {
      issuer: 'secure-microfinance',
      audience: 'smf-web',
    }) as AccessTokenPayload;
  } catch {
    // Expired / tampered / wrong audience are indistinguishable to callers.
    throw unauthorized('Invalid or expired token');
  }
}

export interface RefreshContext {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface RefreshIssue {
  token: string;
  expiresAt: Date;
  familyId: string;
}

function refreshExpiry(): Date {
  return new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export async function issueRefreshToken(userId: string, context: RefreshContext, familyId?: string): Promise<RefreshIssue> {
  const token = randomToken(48);
  const expiresAt = refreshExpiry();
  const family = familyId ?? crypto.randomUUID();

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, sha256Hex(token), family, expiresAt, context.ip ?? null, context.userAgent ?? null],
  );

  return { token, expiresAt, familyId: family };
}

export interface RotatedRefresh {
  userId: string;
  role: Role;
  issue: RefreshIssue;
}

interface RefreshRow {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  role: Role;
}

/**
 * Decides what a replayed refresh token means.
 *
 * Two tabs (or React StrictMode re-mounting the provider) can send the same
 * cookie simultaneously. The loser of that race sees a token that was
 * revoked a few milliseconds ago *and* whose replacement is still active --
 * that is a benign double-submit, not theft. Outside the grace window, or
 * when the replacement is gone, we treat it as a stolen token and revoke the
 * whole family.
 */
async function handleReplay(row: RefreshRow, context: RefreshContext, reason: string): Promise<RotatedRefresh> {
  let replacementActive = false;
  if (row.replaced_by) {
    const replacement = await queryOne<{ revoked_at: Date | null }>('SELECT revoked_at FROM refresh_tokens WHERE id = $1', [
      row.replaced_by,
    ]);
    replacementActive = Boolean(replacement && !replacement.revoked_at);
  }

  const revokedAgoMs = row.revoked_at ? Date.now() - new Date(row.revoked_at).getTime() : Number.POSITIVE_INFINITY;
  const graceMs = config.REFRESH_REUSE_GRACE_SECONDS * 1000;

  if (replacementActive && revokedAgoMs <= graceMs) {
    const issue = await issueRefreshToken(row.user_id, context, row.family_id);
    await recordAudit({
      actorUserId: row.user_id,
      actorRole: row.role,
      action: 'auth.refresh_concurrent',
      entityType: 'session',
      entityId: row.user_id,
      detail: { reason, revokedAgoMs },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      requestId: context.requestId ?? null,
    });
    return { userId: row.user_id, role: row.role, issue };
  }

  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id]);
  await recordAudit({
    actorUserId: row.user_id,
    actorRole: row.role,
    action: 'auth.refresh_reuse_detected',
    entityType: 'session',
    entityId: row.user_id,
    detail: { reason, family_id: row.family_id, revokedAgoMs },
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    requestId: context.requestId ?? null,
  });
  throw unauthorized('Refresh token reuse detected; all sessions revoked');
}

/**
 * Validates a refresh token and rotates it.
 *
 * The row is claimed with a conditional UPDATE so two concurrent requests can
 * never both rotate the same token (which would fork the token family).
 * Reuse outside the concurrency grace window is treated as theft.
 */
export async function rotateRefreshToken(rawToken: string, context: RefreshContext): Promise<RotatedRefresh> {
  const tokenHash = sha256Hex(rawToken);
  const row = await queryOne<RefreshRow>(
    `SELECT rt.id, rt.user_id, rt.family_id, rt.expires_at, rt.revoked_at, rt.replaced_by, u.role
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1`,
    [tokenHash],
  );

  if (!row) throw unauthorized('Invalid refresh token');
  if (row.revoked_at) return handleReplay(row, context, 'already_rotated');

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
    throw unauthorized('Refresh token expired');
  }

  // Claim the row: exactly one concurrent caller wins this UPDATE.
  const claimed = await query<{ id: string }>(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id',
    [row.id],
  );
  if (claimed.length === 0) {
    const current = await queryOne<{ revoked_at: Date | null; replaced_by: string | null }>(
      'SELECT revoked_at, replaced_by FROM refresh_tokens WHERE id = $1',
      [row.id],
    );
    return handleReplay(
      { ...row, revoked_at: current?.revoked_at ?? new Date(), replaced_by: current?.replaced_by ?? null },
      context,
      'lost_rotation_race',
    );
  }

  const issue = await issueRefreshToken(row.user_id, context, row.family_id);
  await query('UPDATE refresh_tokens SET replaced_by = (SELECT id FROM refresh_tokens WHERE token_hash = $2) WHERE id = $1', [
    row.id,
    sha256Hex(issue.token),
  ]);

  return { userId: row.user_id, role: row.role, issue };
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
    sha256Hex(rawToken),
  ]);
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}
