import { query } from '../../db/pool';
import { hashLoanRef, hashTransaction, toBytes32 } from '../../lib/canonical';
import { AppError, forbidden, unprocessable } from '../../lib/errors';
import { verifyAuditChain } from '../audit/audit.service';
import { loadVisibleLoan, type Actor } from '../loans/loan.service';
import {
  anchorAuditRoot,
  getChainStatus,
  isChainEnabled,
  readOnChain,
  recordOnChain,
  TX_TYPE,
  type ChainStatus,
} from './chain.client';

/**
 * Verification of off-chain records against the ledger.
 *
 * The guarantee being offered is narrow and honest: the hash written on-chain
 * is the hash of this exact database row. So the check recomputes the hash from
 * the row as it is *now* and compares three things:
 *
 *   1. the recomputed hash against the hash recorded when the money moved,
 *   2. the recorded hash against the ledger,
 *   3. the ledger's loan reference and timestamp against the database.
 *
 * Any mismatch is reported as `broken` with the reason. We never "repair" a
 * mismatch silently -- an auditor needs to see it.
 */
export type ProofState = 'verified' | 'anchored_unchecked' | 'unanchored' | 'broken';

export interface PaymentProof {
  transactionId: string;
  type: 'disbursement' | 'repayment';
  method: string;
  amountCents: number;
  occurredAt: string;
  transactionStatus: string;
  /** Hash recomputed from the row as it stands now. */
  recomputedHash: string;
  /** Hash stored when the transaction was recorded. */
  recordedHash: string | null;
  onChain: {
    hash: string;
    txHash: string | null;
    block: number | null;
    recorder: string | null;
    recordedAt: string | null;
  } | null;
  state: ProofState;
  problem: string | null;
}

export interface LoanLedgerReport {
  loan: { id: string; ref: string; status: string };
  loanRefHash: string;
  chain: ChainStatus;
  proofs: PaymentProof[];
  summary: { total: number; verified: number; anchoredUnchecked: number; unanchored: number; broken: number };
  ok: boolean;
  generatedAt: string;
}

interface TransactionRow {
  id: string;
  type: 'disbursement' | 'repayment';
  amount_cents: number;
  method: string;
  mobile_txn_code_norm: string | null;
  status: string;
  canonical_payload_hash: string | null;
  onchain_hash: string | null;
  onchain_tx_hash: string | null;
  onchain_block: number | null;
  onchain_recorded_at: Date | null;
  occurred_at: Date;
}

function epochSeconds(value: Date | string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

async function verifyRow(
  loanRef: string,
  row: TransactionRow,
  chainEnabled: boolean,
): Promise<PaymentProof> {
  const recomputedHash = hashTransaction({
    txnId: row.id,
    loanRef,
    type: row.type,
    amountCents: Number(row.amount_cents),
    occurredAt: row.occurred_at,
    mobileCodeNorm: row.mobile_txn_code_norm,
  });

  const proof: PaymentProof = {
    transactionId: row.id,
    type: row.type,
    method: row.method,
    amountCents: Number(row.amount_cents),
    occurredAt: new Date(row.occurred_at).toISOString(),
    transactionStatus: row.status,
    recomputedHash,
    recordedHash: row.canonical_payload_hash,
    onChain: row.onchain_hash
      ? {
          hash: row.onchain_hash,
          txHash: row.onchain_tx_hash,
          block: row.onchain_block,
          recorder: null,
          recordedAt: row.onchain_recorded_at ? new Date(row.onchain_recorded_at).toISOString() : null,
        }
      : null,
    state: 'unanchored',
    problem: null,
  };

  if (!row.canonical_payload_hash) {
    proof.state = 'broken';
    proof.problem = 'No payload hash was stored for this transaction.';
    return proof;
  }

  if (row.canonical_payload_hash !== recomputedHash) {
    proof.state = 'broken';
    proof.problem = 'The stored hash does not match the transaction as it is stored now.';
    return proof;
  }

  if (!row.onchain_hash) {
    proof.state = 'unanchored';
    proof.problem = chainEnabled ? null : 'On-chain anchoring is disabled.';
    return proof;
  }

  if (!chainEnabled) {
    proof.state = 'anchored_unchecked';
    proof.problem = 'The hash is anchored, but the ledger is not reachable to confirm it.';
    return proof;
  }

  try {
    const entry = await readOnChain(row.onchain_hash);
    if (!entry) {
      proof.state = 'broken';
      proof.problem = 'The ledger has no record for this hash.';
      return proof;
    }
    proof.onChain!.recorder = entry.recorder;
    proof.onChain!.recordedAt = new Date(entry.occurredAt * 1000).toISOString();

    if (entry.loanRef.toLowerCase() !== toBytes32(hashLoanRef(loanRef)).toLowerCase()) {
      proof.state = 'broken';
      proof.problem = 'The proof on the ledger belongs to a different loan.';
      return proof;
    }
    if (entry.txType !== TX_TYPE[row.type]) {
      proof.state = 'broken';
      proof.problem = 'The ledger records a different transaction type.';
      return proof;
    }
    if (entry.occurredAt !== epochSeconds(row.occurred_at)) {
      proof.state = 'broken';
      proof.problem = 'The timestamp on the ledger differs from the recorded payment time.';
      return proof;
    }
    proof.state = 'verified';
    return proof;
  } catch (error) {
    proof.state = 'anchored_unchecked';
    proof.problem = `Ledger unreachable: ${(error as Error).message}`.slice(0, 200);
    return proof;
  }
}

/** Full proof report for one loan, visible to its borrower, lender and auditors. */
export async function getLoanLedgerReport(actor: Actor, loanId: string): Promise<LoanLedgerReport> {
  const loan = await loadVisibleLoan(actor, loanId);
  const rows = await query<TransactionRow>(
    `SELECT id, type, amount_cents, method, mobile_txn_code_norm, status, canonical_payload_hash,
            onchain_hash, onchain_tx_hash, onchain_block, onchain_recorded_at, occurred_at
       FROM transactions
      WHERE loan_id = $1
      ORDER BY occurred_at ASC`,
    [loanId],
  );

  const chainEnabled = isChainEnabled();
  const proofs: PaymentProof[] = [];
  for (const row of rows) {
    proofs.push(await verifyRow(loan.ref, row, chainEnabled));
  }

  const summary = {
    total: proofs.length,
    verified: proofs.filter((proof) => proof.state === 'verified').length,
    anchoredUnchecked: proofs.filter((proof) => proof.state === 'anchored_unchecked').length,
    unanchored: proofs.filter((proof) => proof.state === 'unanchored').length,
    broken: proofs.filter((proof) => proof.state === 'broken').length,
  };

  return {
    loan: { id: loan.id, ref: loan.ref, status: loan.status },
    loanRefHash: hashLoanRef(loan.ref),
    chain: await getChainStatus(),
    proofs,
    summary,
    ok: summary.broken === 0,
    generatedAt: new Date().toISOString(),
  };
}

export interface AnchorRetryResult {
  attempted: number;
  anchored: number;
  skipped: number;
  failures: Array<{ transactionId: string; reason: string }>;
}

/**
 * Re-attempts anchoring of cleared transactions that were recorded while the
 * chain was unreachable. Idempotent: the contract rejects a duplicate hash, so
 * a second run cannot mint a second proof.
 */
export async function anchorLoanTransactions(actor: Actor, loanId: string): Promise<AnchorRetryResult> {
  if (actor.role !== 'lender') throw forbidden('Only a lender can anchor transactions.');
  if (!isChainEnabled()) {
    throw new AppError(503, 'CHAIN_UNAVAILABLE', 'On-chain anchoring is not configured on this server.');
  }

  const loan = await loadVisibleLoan(actor, loanId);
  if (loan.lender_id !== actor.id) throw forbidden('This loan is not in your book.');

  const rows = await query<TransactionRow>(
    `SELECT id, type, amount_cents, method, mobile_txn_code_norm, status, canonical_payload_hash,
            onchain_hash, onchain_tx_hash, onchain_block, onchain_recorded_at, occurred_at
       FROM transactions
      WHERE loan_id = $1 AND status = 'cleared'
      ORDER BY occurred_at ASC`,
    [loanId],
  );

  const pending = rows.filter((row) => !row.onchain_hash);
  const failures: AnchorRetryResult['failures'] = [];
  let anchored = 0;

  for (const row of pending) {
    const recordHash = row.canonical_payload_hash;
    if (!recordHash) {
      failures.push({ transactionId: row.id, reason: 'Transaction has no payload hash.' });
      continue;
    }
    try {
      const record = await recordOnChain({
        loanRefHash: hashLoanRef(loan.ref),
        txType: TX_TYPE[row.type],
        occurredAt: row.occurred_at,
        recordHashHex: recordHash,
      });
      await query(
        `UPDATE transactions
            SET onchain_hash = $2, onchain_tx_hash = $3, onchain_block = $4,
                onchain_recorded_at = now(), verified_at = now()
          WHERE id = $1 AND onchain_hash IS NULL`,
        // onchain_hash is char(64): store the digest, never its 0x form.
        [row.id, recordHash, record.txHash, record.blockNumber],
      );
      anchored += 1;
    } catch (error) {
      // A hash already on the chain is success, not failure: the earlier
      // attempt committed but the update did not land.
      const message = (error as Error).message ?? 'unknown error';
      if (/AlreadyRecorded|already known/i.test(message)) {
        await query(
          `UPDATE transactions
              SET onchain_hash = $2, onchain_recorded_at = COALESCE(onchain_recorded_at, now()),
                  verified_at = COALESCE(verified_at, now())
            WHERE id = $1 AND onchain_hash IS NULL`,
          [row.id, recordHash],
        );
        anchored += 1;
      } else {
        failures.push({ transactionId: row.id, reason: message.slice(0, 200) });
      }
    }
  }

  return { attempted: pending.length, anchored, skipped: rows.length - pending.length, failures };
}

export interface AuditAnchorResult {
  anchored: boolean;
  seq: number;
  root: string;
  txHash: string | null;
  block: number | null;
}

/**
 * Anchors the head of the audit hash chain.
 *
 * Refuses to anchor a broken chain: publishing a root for a log that already
 * fails verification would let an attacker launder a tampered history.
 */
export async function anchorAuditTrail(actor: Actor): Promise<AuditAnchorResult> {
  if (actor.role !== 'lender') throw forbidden('Only a lender can anchor the audit trail.');
  if (!isChainEnabled()) {
    throw new AppError(503, 'CHAIN_UNAVAILABLE', 'On-chain anchoring is not configured on this server.');
  }

  const verification = await verifyAuditChain();
  if (!verification.ok) {
    throw unprocessable('The audit chain is broken; anchoring is refused until it is investigated.', {
      mismatches: verification.mismatches.slice(0, 10),
    });
  }
  if (verification.headSeq === 0) {
    throw unprocessable('The audit chain is empty.');
  }

  const result = await anchorAuditRoot(verification.headHash, verification.headSeq);
  return {
    anchored: true,
    seq: verification.headSeq,
    root: verification.headHash,
    txHash: result.txHash,
    block: result.blockNumber,
  };
}
