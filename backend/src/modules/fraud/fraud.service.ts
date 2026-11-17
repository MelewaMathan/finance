import type { Request } from 'express';
import { query, queryOne } from '../../db/pool';
import { hashLoanRef } from '../../lib/canonical';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { auditRequest } from '../audit/audit.service';
import { isChainEnabled, recordOnChain, TX_TYPE } from '../ledger/chain.client';
import { getLoan, loadVisibleLoan, type Actor } from '../loans/loan.service';
import { applyRepayment } from '../repayments/repayment.service';
import type { FlagQuery, HoldDecisionInput, ResolveFlagInput } from './fraud.schemas';
import type { Severity } from './rules.engine';

/**
 * Fraud review (M6, layer 3).
 *
 * Rules and the Isolation Forest only *raise* flags. Nothing here can call
 * itself: a human decides. Two facts are kept strictly apart because confusing
 * them is how fraud reviews go wrong:
 *
 *   the flag   -- "this pattern is suspicious" (a judgement)
 *   the hold   -- "this movement has not happened yet" (a fact about money)
 *
 * Clearing a flag therefore does not move money, and releasing a hold does not
 * pretend the pattern was innocent. Both are recorded, with a note, under the
 * reviewer's name.
 */
export type FlagStatus = 'open' | 'cleared' | 'confirmed';

export interface FraudFlag {
  id: string;
  loanId: string | null;
  loanRef: string | null;
  transactionId: string | null;
  borrowerId: string | null;
  borrowerName: string | null;
  flagType: string;
  severity: Severity;
  status: FlagStatus;
  source: 'rule' | 'ml';
  ruleId: string | null;
  detail: Record<string, unknown>;
  /** A held transaction means money has not moved yet; that is actionable. */
  transactionStatus: string | null;
  transactionHoldReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  resolutionNote: string | null;
}

interface FlagRow {
  id: string;
  loan_id: string | null;
  loan_ref: string | null;
  transaction_id: string | null;
  borrower_id: string | null;
  borrower_name: string | null;
  flag_type: string;
  severity: Severity;
  status: FlagStatus;
  source: 'rule' | 'ml';
  rule_id: string | null;
  detail: Record<string, unknown>;
  transaction_status: string | null;
  transaction_hold_reason: string | null;
  created_at: Date;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  resolution_note: string | null;
}

interface HeldTxn {
  id: string;
  type: 'disbursement' | 'repayment';
  amount_cents: number;
  occurred_at: Date;
  canonical_payload_hash: string | null;
  hold_reason: string | null;
}

function toFlag(row: FlagRow): FraudFlag {
  return {
    id: row.id,
    loanId: row.loan_id,
    loanRef: row.loan_ref,
    transactionId: row.transaction_id,
    borrowerId: row.borrower_id,
    borrowerName: row.borrower_name,
    flagType: row.flag_type,
    severity: row.severity,
    status: row.status,
    source: row.source,
    ruleId: row.rule_id,
    detail: row.detail ?? {},
    transactionStatus: row.transaction_status,
    transactionHoldReason: row.transaction_hold_reason,
    createdAt: new Date(row.created_at).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    reviewedBy: row.reviewed_by,
    resolutionNote: row.resolution_note,
  };
}

const FLAG_SELECT = `
  SELECT f.id, f.loan_id, l.ref AS loan_ref, f.transaction_id, f.borrower_id,
         u.full_name AS borrower_name, f.flag_type, f.severity, f.status, f.source,
         f.detected_at AS created_at, f.reviewed_at,
         rv.full_name AS reviewed_by, f.resolution_note,
         t.status AS transaction_status, t.hold_reason AS transaction_hold_reason
    FROM fraud_flags f
    LEFT JOIN loans l  ON l.id = f.loan_id
    LEFT JOIN users u  ON u.id = f.borrower_id
    LEFT JOIN users rv ON rv.id = f.reviewed_by
    LEFT JOIN transactions t ON t.id = f.transaction_id
`;

function assertQueueReader(actor: Actor): void {
  if (actor.role !== 'staff' && actor.role !== 'admin') {
    throw forbidden('Only the enterprise and admins may review fraud flags');
  }
}

/**
 * The review queue. A lender sees their own book; an auditor sees everything,
 * which is the point of the role, but can change nothing.
 */
export async function listFlags(actor: Actor, filters: FlagQuery): Promise<FraudFlag[]> {
  assertQueueReader(actor);

  const rows = await query<FlagRow>(
    `${FLAG_SELECT}
      WHERE ($1::text = 'all' OR f.status::text = $1)
        AND ($2::text IS NULL OR f.severity::text = $2)
        AND ($3::uuid IS NULL OR f.loan_id = $3)
        AND ($4::uuid IS NULL
             OR l.lender_id = $4
             -- An identity conflict raised at registration has no loan yet, so
             -- ownership runs through the borrower's book instead.
             OR EXISTS (SELECT 1 FROM loans own
                         WHERE own.borrower_id = f.borrower_id AND own.lender_id = $4))
      ORDER BY CASE f.severity
                 WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3
               END,
               f.detected_at DESC
      LIMIT $5`,
    [
      filters.status,
      filters.severity ?? null,
      filters.loanId ?? null,
      actor.role === 'staff' ? actor.id : null,
      filters.limit,
    ],
  );

  return rows.map(toFlag);
}

/** Flags attached to one loan, for the loan detail page. */
export async function listLoanFlags(actor: Actor, loanId: string): Promise<FraudFlag[]> {
  const loan = await loadVisibleLoan(actor, loanId);
  // A borrower may see that their own payment was held; they may not browse
  // the queue, and the flag detail carries internal reviewer context.
  if (actor.role === 'borrower') {
    const rows = await query<FlagRow>(
      `${FLAG_SELECT} WHERE f.loan_id = $1 ORDER BY f.detected_at DESC LIMIT 50`,
      [loan.id],
    );
    return rows.map(toFlag).map((flag) => ({ ...flag, detail: {}, resolutionNote: null }));
  }
  assertQueueReader(actor);
  const rows = await query<FlagRow>(
    `${FLAG_SELECT} WHERE f.loan_id = $1 ORDER BY f.detected_at DESC LIMIT 50`,
    [loan.id],
  );
  return rows.map(toFlag);
}

/** Reads one flag with enough context to decide who may act on it. */
async function loadFlagForReview(flagId: string): Promise<(FlagRow & { lender_id: string | null }) | null> {
  const row = await queryOne<FlagRow & { lender_id: string | null }>(
    `WITH base AS (${FLAG_SELECT} WHERE f.id = $1)
     SELECT base.*, (SELECT l2.lender_id FROM loans l2 WHERE l2.id = base.loan_id) AS lender_id
       FROM base`,
    [flagId],
  );
  return row ?? null;
}

/** A lender may act only on flags arising from their own book. */
async function lenderOwnsFlag(actor: Actor, row: FlagRow & { lender_id: string | null }): Promise<boolean> {
  if (row.lender_id === actor.id) return true;
  if (!row.borrower_id) return false;
  const shared = await queryOne<{ ok: boolean }>(
    'SELECT true AS ok FROM loans WHERE borrower_id = $1 AND lender_id = $2 LIMIT 1',
    [row.borrower_id, actor.id],
  );
  return Boolean(shared);
}

/** Reviewer decision on a single flag. Does not move money. */
export async function resolveFlag(actor: Actor, flagId: string, input: ResolveFlagInput, req: Request): Promise<FraudFlag> {
  if (actor.role !== 'staff') throw forbidden('Only the enterprise can resolve a flag');

  const row = await loadFlagForReview(flagId);
  // Unknown flag and someone else's flag look identical on purpose.
  if (!row) throw notFound('Flag not found');
  if (!(await lenderOwnsFlag(actor, row))) throw notFound('Flag not found');
  if (row.status !== 'open') throw conflict(`This flag was already ${row.status} by ${row.reviewed_by ?? 'a reviewer'}`);

  const updated = await queryOne<FlagRow>(
    `UPDATE fraud_flags
        SET status = $2::flag_status, reviewed_by = $3, reviewed_at = now(), resolution_note = $4
      WHERE id = $1
      RETURNING id`,
    [flagId, input.resolution, actor.id, input.note],
  );
  if (!updated) throw new Error('Flag update returned no row');

  await auditRequest(req, `fraud.flag_${input.resolution}`, 'fraud_flag', flagId, {
    loanId: row.loan_id,
    ref: row.loan_ref,
    flagType: row.flag_type,
    severity: row.severity,
    resolution: input.resolution,
    note: input.note,
  });

  const fresh = await queryOne<FlagRow>(`${FLAG_SELECT} WHERE f.id = $1`, [flagId]);
  if (!fresh) throw new Error('Flag disappeared after update');
  return toFlag(fresh);
}

/**
 * Releases or rejects the money movement parked by a hold.
 *
 * Release reuses `applyRepayment` for repayments, so a payment a human cleared
 * is allocated by the same code as one that was never held. Rejection leaves
 * the row visible as `rejected` rather than deleting it: an auditor must be
 * able to see that a claim was made and refused.
 */
export async function resolveHold(actor: Actor, loanId: string, input: HoldDecisionInput, req: Request) {
  if (actor.role !== 'staff') throw forbidden('Only the enterprise can release or reject a held movement');
  const loan = await loadVisibleLoan(actor, loanId);

  const held = await queryOne<HeldTxn>(
    `SELECT id, type, amount_cents, occurred_at, canonical_payload_hash, hold_reason
       FROM transactions
      WHERE loan_id = $1 AND status = 'held'
      ORDER BY occurred_at DESC
      LIMIT 1`,
    [loanId],
  );
  if (!held) throw conflict('This loan has no held movement to resolve');

  if (input.decision === 'reject') {
    await query(
      `UPDATE transactions
          SET status = 'rejected',
              hold_reason = COALESCE(hold_reason, 'Held for review') || ' -- rejected: ' || $2
        WHERE id = $1`,
      [held.id, input.note],
    );

    // A rejected disbursement never happened, so the loan goes back to the
    // state where the lender can decide what to do next.
    if (held.type === 'disbursement') {
      await query(`UPDATE loans SET status = 'approved', held_reason = NULL WHERE id = $1 AND status = 'held'`, [loanId]);
    } else {
      await query(`UPDATE loans SET held_reason = NULL WHERE id = $1`, [loanId]);
    }

    await query(
      `UPDATE fraud_flags
          SET status = 'confirmed', reviewed_by = $2, reviewed_at = now(), resolution_note = $3
        WHERE transaction_id = $1 AND status = 'open'`,
      [held.id, actor.id, input.note],
    );

    await auditRequest(req, 'fraud.hold_rejected', 'transaction', held.id, {
      loanId,
      ref: loan.ref,
      type: held.type,
      amountCents: Number(held.amount_cents),
      note: input.note,
    });

    return { loan: await getLoan(actor, loanId), decision: input.decision, anchored: false };
  }

  if (!held.canonical_payload_hash) {
    throw conflict('The held row has no payload hash, so it cannot be cleared safely');
  }

  const occurredAt = new Date(held.occurred_at);
  let anchoredHash: string | null = null;
  let anchorTxHash: string | null = null;
  let anchorBlock: number | null = null;

  if (held.type === 'disbursement') {
    if (loan.status !== 'held') throw conflict(`Only a held loan can be released (this loan is ${loan.status})`);

    if (isChainEnabled()) {
      try {
        const record = await recordOnChain({
          loanRefHash: hashLoanRef(loan.ref),
          txType: TX_TYPE.disbursement,
          occurredAt,
          recordHashHex: held.canonical_payload_hash,
        });
        // Persisted as the bare 32-byte digest (the column is char(64));
        // the 0x form is only for contract calls.
        anchoredHash = held.canonical_payload_hash;
        anchorTxHash = record.txHash;
        anchorBlock = record.blockNumber;
      } catch (error) {
        console.warn('[fraud] release anchor failed:', (error as Error).message);
      }
    }

    await query(
      `UPDATE transactions
          SET status = 'cleared', hold_reason = NULL,
              onchain_hash = $2, onchain_tx_hash = $3, onchain_block = $4,
              onchain_recorded_at = $5, verified_at = $5
        WHERE id = $1`,
      [held.id, anchoredHash, anchorTxHash, anchorBlock, anchoredHash ? occurredAt : null],
    );
    await query(`UPDATE loans SET status = 'disbursed', disbursed_at = $2, held_reason = NULL WHERE id = $1`, [
      loanId,
      occurredAt,
    ]);
  } else {
    await applyRepayment(loanId, held.id, Number(held.amount_cents), held.canonical_payload_hash);
    await query(`UPDATE loans SET held_reason = NULL WHERE id = $1`, [loanId]);

    if (isChainEnabled()) {
      try {
        const record = await recordOnChain({
          loanRefHash: hashLoanRef(loan.ref),
          txType: TX_TYPE.repayment,
          occurredAt,
          recordHashHex: held.canonical_payload_hash,
        });
        anchoredHash = held.canonical_payload_hash;
        anchorTxHash = record.txHash;
        anchorBlock = record.blockNumber;
        await query(
          `UPDATE transactions
              SET onchain_hash = $2, onchain_tx_hash = $3, onchain_block = $4,
                  onchain_recorded_at = $5, verified_at = $5
            WHERE id = $1`,
          [held.id, anchoredHash, anchorTxHash, anchorBlock, occurredAt],
        );
      } catch (error) {
        console.warn('[fraud] repayment release anchor failed:', (error as Error).message);
      }
    }
  }

  // Releasing money clears the suspicion, not the finding: the flag stays in
  // the table with the reviewer's note attached.
  await query(
    `UPDATE fraud_flags
        SET status = 'cleared', reviewed_by = $2, reviewed_at = now(), resolution_note = $3
      WHERE transaction_id = $1 AND status = 'open'`,
    [held.id, actor.id, input.note],
  );

  await auditRequest(req, 'fraud.hold_released', 'transaction', held.id, {
    loanId,
    ref: loan.ref,
    type: held.type,
    amountCents: Number(held.amount_cents),
    note: input.note,
    anchored: Boolean(anchoredHash),
  });

  return { loan: await getLoan(actor, loanId), decision: input.decision, anchored: Boolean(anchoredHash) };
}

export interface AlertView {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

interface AlertRow {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  read_at: Date | null;
  created_at: Date;
}

const ALERT_SELECT = `
  SELECT id, type, severity, title, body, entity_type, entity_id, read_at, created_at
    FROM alerts
`;

function toAlert(row: AlertRow): AlertView {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    entityType: row.entity_type,
    entityId: row.entity_id,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** In-app alerts for the signed-in user, newest first. */
export async function listAlerts(actor: Actor, unreadOnly: boolean): Promise<{ alerts: AlertView[]; unread: number }> {
  const [rows, unread] = await Promise.all([
    query<AlertRow>(
      `${ALERT_SELECT} WHERE user_id = $1 AND ($2::boolean = false OR read_at IS NULL) ORDER BY created_at DESC LIMIT 100`,
      [actor.id, unreadOnly],
    ),
    queryOne<{ count: number }>('SELECT count(*)::int AS count FROM alerts WHERE user_id = $1 AND read_at IS NULL', [
      actor.id,
    ]),
  ]);
  return { alerts: rows.map(toAlert), unread: Number(unread?.count ?? 0) };
}

export async function markAlertRead(actor: Actor, alertId: string): Promise<AlertView> {
  const row = await queryOne<AlertRow>(
    `UPDATE alerts SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND user_id = $2
      RETURNING id, type, severity, title, body, entity_type, entity_id, read_at, created_at`,
    [alertId, actor.id],
  );
  if (!row) throw notFound('Alert not found');
  return toAlert(row);
}

export interface FraudSummary {
  openFlags: number;
  bySeverity: Record<'low' | 'medium' | 'high' | 'critical', number>;
  heldMovements: number;
  newLast24h: number;
  mlFlags: number;
}

/** Header numbers for the review queue. */
export async function getFraudSummary(actor: Actor): Promise<FraudSummary> {
  assertQueueReader(actor);
  const lenderScope = actor.role === 'staff' ? actor.id : null;
  const rows = await query<{ severity: Severity; count: number }>(
    `SELECT f.severity, count(*)::int AS count
       FROM fraud_flags f
       LEFT JOIN loans l ON l.id = f.loan_id
      WHERE f.status = 'open'
        AND ($1::uuid IS NULL OR l.lender_id = $1)
      GROUP BY f.severity`,
    [lenderScope],
  );

  const [held, recent, ml] = await Promise.all([
    queryOne<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM transactions t
         JOIN loans l ON l.id = t.loan_id
        WHERE t.status = 'held' AND ($1::uuid IS NULL OR l.lender_id = $1)`,
      [lenderScope],
    ),
    queryOne<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM fraud_flags f
         LEFT JOIN loans l ON l.id = f.loan_id
        WHERE f.detected_at > now() - interval '24 hours'
          AND ($1::uuid IS NULL OR l.lender_id = $1)`,
      [lenderScope],
    ),
    queryOne<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM fraud_flags f
         LEFT JOIN loans l ON l.id = f.loan_id
        WHERE f.status = 'open' AND f.source = 'ml'
          AND ($1::uuid IS NULL OR l.lender_id = $1)`,
      [lenderScope],
    ),
  ]);

  const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const row of rows) {
    bySeverity[row.severity] = Number(row.count);
  }
  const openFlags = Object.values(bySeverity).reduce((sum, value) => sum + value, 0);

  return {
    openFlags,
    bySeverity,
    heldMovements: Number(held?.count ?? 0),
    newLast24h: Number(recent?.count ?? 0),
    mlFlags: Number(ml?.count ?? 0),
  };
}
