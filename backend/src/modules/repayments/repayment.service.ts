import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../../db/pool';
import { hashLoanRef, hashTransaction } from '../../lib/canonical';
import { badRequest, conflict, unprocessable } from '../../lib/errors';
import { auditRequest } from '../audit/audit.service';
import {
  detectReferenceIssues,
  normaliseMobileCode,
  validateMobileCode,
} from '../fraud/rules.engine';
import { detectAnomaly } from '../fraud/anomaly.client';
import { isChainEnabled, recordOnChain, TX_TYPE } from '../ledger/chain.client';
import { getLoan, loadVisibleLoan, type Actor } from '../loans/loan.service';
import type { RepaymentInput } from './repayment.schemas';
import { accruePenalties } from './penalty.service';

/**
 * Repayment recording.
 *
 * A repayment is a claim ("this was paid") rather than money in the bank, so
 * it goes through the same reference checks as disbursement and can be held.
 * Once cleared, the amount is allocated penalty -> interest -> principal in
 * schedule order, and the loan settles automatically when nothing is left.
 */
interface InstallmentForUpdate {
  id: string;
  seq: number;
  penalty_accrued_cents: number;
  interest_due_cents: number;
  principal_due_cents: number;
  paid_penalty_cents: number;
  paid_interest_cents: number;
  paid_principal_cents: number;
  status: string;
}

interface Allocation {
  id: string;
  paidPenaltyCents: number;
  paidInterestCents: number;
  paidPrincipalCents: number;
  status: 'paid' | 'partial' | 'pending';
}

/** Splits an amount across installments: penalty, then interest, then principal. */
export function allocateRepayment(rows: InstallmentForUpdate[], amountCents: number): Allocation[] {
  let remaining = amountCents;
  const allocations: Allocation[] = [];

  for (const row of rows) {
    if (remaining <= 0) break;

    const penaltyRemaining = Math.max(0, row.penalty_accrued_cents - row.paid_penalty_cents);
    const interestRemaining = Math.max(0, row.interest_due_cents - row.paid_interest_cents);
    const principalRemaining = Math.max(0, row.principal_due_cents - row.paid_principal_cents);
    if (penaltyRemaining + interestRemaining + principalRemaining === 0) continue;

    const toPenalty = Math.min(remaining, penaltyRemaining);
    remaining -= toPenalty;
    const toInterest = Math.min(remaining, interestRemaining);
    remaining -= toInterest;
    const toPrincipal = Math.min(remaining, principalRemaining);
    remaining -= toPrincipal;

    if (toPenalty + toInterest + toPrincipal === 0) continue;

    const paidPenaltyCents = row.paid_penalty_cents + toPenalty;
    const paidInterestCents = row.paid_interest_cents + toInterest;
    const paidPrincipalCents = row.paid_principal_cents + toPrincipal;
    const cleared =
      paidPenaltyCents >= row.penalty_accrued_cents &&
      paidInterestCents >= row.interest_due_cents &&
      paidPrincipalCents >= row.principal_due_cents;

    allocations.push({
      id: row.id,
      paidPenaltyCents,
      paidInterestCents,
      paidPrincipalCents,
      status: cleared ? 'paid' : 'partial',
    });
  }

  return allocations;
}

async function outstandingCents(loanId: string, client?: PoolClient): Promise<number> {
  const sql = `SELECT COALESCE(SUM(
                        principal_due_cents + interest_due_cents + penalty_accrued_cents
                        - paid_principal_cents - paid_interest_cents - paid_penalty_cents), 0)::bigint AS outstanding
                 FROM loan_installments WHERE loan_id = $1`;
  if (client) {
    const result = await client.query<{ outstanding: number }>(sql, [loanId]);
    return Number(result.rows[0]?.outstanding ?? 0);
  }
  const rows = await query<{ outstanding: number }>(sql, [loanId]);
  return Number(rows[0]?.outstanding ?? 0);
}

/**
 * Applies an already-cleared payment to the schedule under a row lock.
 *
 * Shared by the normal path and by fraud-hold release: a payment cleared by a
 * reviewer must be allocated by exactly the same code as one that was never
 * held, or the two ledgers could disagree. Returns true when the loan settled.
 */
export async function applyRepayment(
  loanId: string,
  transactionId: string,
  amountCents: number,
  payloadHash: string,
): Promise<boolean> {
  return withTransaction(async (client) => {
    await accruePenalties(loanId, client);

    const rows = await client.query<InstallmentForUpdate>(
      `SELECT id, seq, penalty_accrued_cents, interest_due_cents, principal_due_cents,
              paid_penalty_cents, paid_interest_cents, paid_principal_cents, status
         FROM loan_installments
        WHERE loan_id = $1
        ORDER BY seq
        FOR UPDATE`,
      [loanId],
    );

    // Re-check inside the lock: two concurrent repayments must not overpay.
    const remainingOwed = rows.rows.reduce(
      (sum, row) =>
        sum +
        Math.max(0, row.principal_due_cents - row.paid_principal_cents) +
        Math.max(0, row.interest_due_cents - row.paid_interest_cents) +
        Math.max(0, row.penalty_accrued_cents - row.paid_penalty_cents),
      0,
    );
    if (amountCents > remainingOwed) {
      throw unprocessable(`Amount exceeds the outstanding balance of KES ${(remainingOwed / 100).toFixed(2)}`);
    }

    const allocations = allocateRepayment(rows.rows, amountCents);
    for (const allocation of allocations) {
      await client.query(
        `UPDATE loan_installments
            SET paid_penalty_cents = $2, paid_interest_cents = $3, paid_principal_cents = $4, status = $5
          WHERE id = $1`,
        [
          allocation.id,
          allocation.paidPenaltyCents,
          allocation.paidInterestCents,
          allocation.paidPrincipalCents,
          allocation.status,
        ],
      );
    }

    await client.query(
      `UPDATE transactions SET status = 'cleared', hold_reason = NULL, canonical_payload_hash = $2 WHERE id = $1`,
      [transactionId, payloadHash],
    );

    const totals = await client.query<{ paid: number; due: number }>(
      `SELECT COALESCE(SUM(paid_principal_cents + paid_interest_cents + paid_penalty_cents), 0)::bigint AS paid,
              COALESCE(SUM(principal_due_cents + interest_due_cents + penalty_accrued_cents), 0)::bigint AS due
         FROM loan_installments WHERE loan_id = $1`,
      [loanId],
    );
    const paid = Number(totals.rows[0]?.paid ?? 0);
    const due = Number(totals.rows[0]?.due ?? 0);
    const isSettled = due > 0 && paid >= due;

    await client.query(
      `UPDATE loans
          SET status = CASE WHEN $2 THEN 'settled'::loan_status ELSE 'active'::loan_status END,
              settled_at = CASE WHEN $2 THEN now() ELSE settled_at END
        WHERE id = $1 AND status IN ('disbursed','active')`,
      [loanId, isSettled],
    );

    return isSettled;
  });
}

export async function recordRepayment(actor: Actor, loanId: string, input: RepaymentInput, req: Request) {
  const loan = await loadVisibleLoan(actor, loanId);

  if (loan.status !== 'disbursed' && loan.status !== 'active') {
    throw conflict(`Repayments can only be recorded on a disbursed loan (this loan is ${loan.status})`);
  }

  let codeNorm: string | null = null;
  if (input.method === 'mobile_money') {
    if (!input.mobileTxnCode) throw badRequest('A mobile-money reference is required for mobile-money repayments');
    codeNorm = normaliseMobileCode(input.mobileTxnCode);
    const validation = validateMobileCode(codeNorm);
    if (!validation.ok) throw badRequest(validation.reason ?? 'Invalid mobile-money reference');
  }

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw badRequest('occurredAt must be an ISO timestamp');
  if (occurredAt.getTime() > Date.now() + 5 * 60 * 1000) throw badRequest('A repayment cannot be dated in the future');
  if (loan.disbursed_at && occurredAt.getTime() < new Date(loan.disbursed_at).getTime() - 86_400_000) {
    throw badRequest('A repayment cannot predate the disbursement');
  }

  await accruePenalties(loanId);
  const owed = await outstandingCents(loanId);
  if (owed === 0) throw conflict('This loan has nothing left to repay');
  if (input.amountCents > owed) {
    throw unprocessable(`Amount exceeds the outstanding balance of KES ${(owed / 100).toFixed(2)}`);
  }

  const created = await queryOne<{ id: string }>(
    `INSERT INTO transactions
       (loan_id, type, amount_cents, method, mobile_txn_code, mobile_txn_code_norm, occurred_at, recorded_by, status)
     VALUES ($1, 'repayment', $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING id`,
    [loanId, input.amountCents, input.method, input.mobileTxnCode ?? null, codeNorm, occurredAt, actor.id],
  );
  if (!created) throw new Error('Transaction insert returned no row');

  const payloadHash = hashTransaction({
    txnId: created.id,
    loanRef: loan.ref,
    type: 'repayment',
    amountCents: input.amountCents,
    occurredAt,
    mobileCodeNorm: codeNorm,
  });

  const drafts = codeNorm
    ? await detectReferenceIssues({ loanId, transactionId: created.id, borrowerId: loan.borrower_id, codeNorm })
    : [];
  // Layer 2 runs even without a receipt code: a cash repayment at 03:00 for
  // thirty times the borrower's normal amount is exactly what the model is for.
  const anomaly = await detectAnomaly({
    loanId,
    transactionId: created.id,
    borrowerId: loan.borrower_id,
    amountCents: input.amountCents,
    occurredAt,
  });
  const blocking = [...drafts, ...anomaly.drafts].filter(
    (draft) => draft.severity === 'high' || draft.severity === 'critical',
  );

  if (blocking.length > 0) {
    const reason = `Held for review: ${blocking.map((draft) => draft.flagType.replace(/_/g, ' ')).join(', ')}`;
    await query(
      `UPDATE transactions SET status = 'held', hold_reason = $2, canonical_payload_hash = $3 WHERE id = $1`,
      [created.id, reason, payloadHash],
    );
    await auditRequest(req, 'repayment.held', 'transaction', created.id, {
      loanId,
      ref: loan.ref,
      amountCents: input.amountCents,
      reason,
      flagTypes: blocking.map((draft) => draft.flagType),
    });
    return {
      held: true,
      anchored: false,
      reason,
      loan: await getLoan(actor, loanId),
    };
  }

  let settled = false;
  try {
    settled = await applyRepayment(loanId, created.id, input.amountCents, payloadHash);
  } catch (error) {
    // The claim was recorded but the money could not be applied; keep the row
    // so the lender sees it as rejected rather than vanishing.
    await query("UPDATE transactions SET status = 'rejected', hold_reason = 'Application failed' WHERE id = $1", [
      created.id,
    ]);
    throw error;
  }

  // Anchor after commit: an unreachable chain must not roll back a real payment.
  let anchoredHash: string | null = null;
  let anchorTxHash: string | null = null;
  let anchorBlock: number | null = null;
  if (isChainEnabled()) {
    try {
      const record = await recordOnChain({
        loanRefHash: hashLoanRef(loan.ref),
        txType: TX_TYPE.repayment,
        occurredAt,
        recordHashHex: payloadHash,
      });
      // Stored as the bare 32-byte digest; the 0x form is only for the chain.
      anchoredHash = payloadHash;
      anchorTxHash = record.txHash;
      anchorBlock = record.blockNumber;
    } catch (error) {
      console.warn('[ledger] repayment anchor failed:', (error as Error).message);
    }
  }

  if (anchoredHash) {
    await query(
      `UPDATE transactions
          SET onchain_hash = $2, onchain_tx_hash = $3, onchain_block = $4, onchain_recorded_at = $5, verified_at = $5
        WHERE id = $1`,
      [created.id, anchoredHash, anchorTxHash, anchorBlock, occurredAt],
    );
  }

  await auditRequest(
    req,
    settled ? 'loan.settled' : 'repayment.recorded',
    'transaction',
    created.id,
    {
      loanId,
      ref: loan.ref,
      amountCents: input.amountCents,
      method: input.method,
      settled,
      anchored: Boolean(anchoredHash),
    },
    { afterHash: payloadHash },
  );

  return { held: false, anchored: Boolean(anchoredHash), reason: null, loan: await getLoan(actor, loanId) };
}
