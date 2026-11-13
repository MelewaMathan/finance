import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool';
import { computeAuditRowHash, GENESIS_HASH } from '../../lib/canonical';
import { clientIp, userAgent } from '../../middleware/requestContext';
import type { Request } from 'express';

/**
 * Append-only, hash-chained audit trail.
 *
 * Why not a database trigger? A trigger cannot know who the actor is, which
 * IP made the request, or the correlation id. Writing from the application
 * keeps that context, while the trigger enforces immutability and the
 * per-row hash chain makes silent edits detectable.
 */
export interface AuditEntry {
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  beforeHash?: string | null;
  afterHash?: string | null;
}

export interface AuditResult {
  seq: number;
  rowHash: string;
}

/** Advisory lock key: serialises concurrent writers so the chain never forks. */
const CHAIN_LOCK = 918_273_645;

export async function recordAudit(entry: AuditEntry, existingClient?: PoolClient): Promise<AuditResult> {
  const run = async (client: PoolClient): Promise<AuditResult> => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [CHAIN_LOCK]);
    const last = await client.query<{ seq: number; row_hash: string }>(
      'SELECT seq, row_hash FROM audit_log ORDER BY seq DESC LIMIT 1',
    );
    const prevHash = last.rows[0]?.row_hash ?? GENESIS_HASH;

    const seqResult = await client.query<{ seq: number; created_at: Date }>(
      "SELECT nextval('audit_seq') AS seq, now() AS created_at",
    );
    const seq = Number(seqResult.rows[0].seq);
    const createdAt = seqResult.rows[0].created_at;
    const detail = entry.detail ?? {};

    const rowHash = computeAuditRowHash({
      seq,
      prevHash,
      actorUserId: entry.actorUserId ?? null,
      actorRole: entry.actorRole ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      detail,
      ip: entry.ip ?? null,
      createdAt,
    });

    await client.query(
      `INSERT INTO audit_log
         (seq, actor_user_id, actor_role, action, entity_type, entity_id, ip, user_agent,
          request_id, before_hash, after_hash, detail, prev_hash, row_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        seq,
        entry.actorUserId ?? null,
        entry.actorRole ?? null,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.ip ?? null,
        entry.userAgent ?? null,
        entry.requestId ?? null,
        entry.beforeHash ?? null,
        entry.afterHash ?? null,
        JSON.stringify(detail),
        prevHash,
        rowHash,
        createdAt,
      ],
    );

    return { seq, rowHash };
  };

  if (existingClient) return run(existingClient);
  return withTransaction(run);
}

/** Convenience wrapper that pulls actor/IP/request context off the request. */
export async function auditRequest(
  req: Request,
  action: string,
  entityType: string,
  entityId: string | null,
  detail: Record<string, unknown> = {},
  extra: { beforeHash?: string | null; afterHash?: string | null } = {},
): Promise<AuditResult> {
  return recordAudit({
    actorUserId: req.user?.id ?? null,
    actorRole: req.user?.role ?? null,
    action,
    entityType,
    entityId,
    detail,
    ip: clientIp(req),
    userAgent: userAgent(req),
    requestId: req.requestId,
    beforeHash: extra.beforeHash ?? null,
    afterHash: extra.afterHash ?? null,
  });
}

export interface AuditMismatch {
  seq: number;
  reason: 'hash_mismatch' | 'broken_link';
  expected: string;
  actual: string;
}

export interface ChainVerification {
  ok: boolean;
  rowsChecked: number;
  headSeq: number;
  headHash: string;
  mismatches: AuditMismatch[];
}

/**
 * Recomputes every row hash and checks each prev_hash link.
 *
 * This is the core tamper test: if somebody edits an audit row directly in
 * the database (with the guard trigger disabled) the recomputed hash differs
 * and every following row reports a broken link.
 */
export async function verifyAuditChain(): Promise<ChainVerification> {
  const rows = await query<{
    seq: number;
    prev_hash: string;
    row_hash: string;
    actor_user_id: string | null;
    actor_role: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    detail: Record<string, unknown>;
    ip: string | null;
    created_at: Date;
  }>('SELECT * FROM audit_log ORDER BY seq ASC');

  const mismatches: AuditMismatch[] = [];
  let expectedPrev = GENESIS_HASH;

  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      mismatches.push({ seq: row.seq, reason: 'broken_link', expected: expectedPrev, actual: row.prev_hash });
    }
    const recomputed = computeAuditRowHash({
      seq: row.seq,
      prevHash: row.prev_hash,
      actorUserId: row.actor_user_id,
      actorRole: row.actor_role,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      detail: row.detail,
      ip: row.ip,
      createdAt: row.created_at,
    });
    if (recomputed !== row.row_hash) {
      mismatches.push({ seq: row.seq, reason: 'hash_mismatch', expected: recomputed, actual: row.row_hash });
    }
    expectedPrev = row.row_hash;
  }

  const head = rows[rows.length - 1];
  return {
    ok: mismatches.length === 0,
    rowsChecked: rows.length,
    headSeq: head?.seq ?? 0,
    headHash: head?.row_hash ?? GENESIS_HASH,
    mismatches,
  };
}
