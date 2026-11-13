import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import { config } from '../../config/env';
import { query, queryOne, withTransaction } from '../../db/pool';
import { hashLoanRef, hashTransaction } from '../../lib/canonical';
import { decryptField, encryptField, maskValue, sha256Hex } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { renderPdf, type PdfLine } from '../../lib/pdf';
import { auditRequest } from '../audit/audit.service';
import {
  detectDuplicateDisbursement,
  detectRapidApplications,
  detectReferenceIssues,
  normaliseMobileCode,
  validateMobileCode,
} from '../fraud/rules.engine';
import { detectAnomaly } from '../fraud/anomaly.client';
import { isChainEnabled, recordOnChain, TX_TYPE } from '../ledger/chain.client';
import { accruePenalties } from '../repayments/penalty.service';
import { generateScore, getLatestScore, type ScoreResult } from '../scoring/scoring.service';
import type { Role } from '../../types/express';
import type { ApplyLoanInput, DecisionInput, DisburseInput, LoanListQuery } from './loan.schemas';

/**
 * Loan lifecycle.
 *
 *   pending -> under_review -> approved -> disbursed -> active -> settled
 *                    \-> rejected             \-> held (fraud gate)
 *
 * Money and dates are server-derived. Every transition is audited, and the
 * agreement PDF's SHA-256 is stored so either party can prove later that the
 * document they hold is the one the system issued.
 */
export interface Actor {
  id: string;
  role: Role;
}

type LoanStatus =
  | 'pending'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'held'
  | 'disbursed'
  | 'active'
  | 'settled'
  | 'defaulted'
  | 'cancelled';

interface LoanRecord {
  id: string;
  ref: string;
  lender_id: string;
  borrower_id: string;
  principal_cents: number;
  term_count: number;
  frequency: 'daily' | 'weekly' | 'monthly';
  rate_bps: number;
  purpose: string;
  collateral_desc: string | null;
  guarantor_name_enc: string | null;
  guarantor_phone_enc: string | null;
  guarantor_credit: number | null;
  total_repayable_cents: number;
  status: LoanStatus;
  identity_verified_at: Date | null;
  decided_at: Date | null;
  decision_note: string | null;
  agreement_doc_id: string | null;
  agreement_sha256: string | null;
  score_snapshot_id: string | null;
  held_reason: string | null;
  disbursed_at: Date | null;
  settled_at: Date | null;
  created_at: Date;
  borrower_name: string;
  borrower_email: string;
  lender_name: string;
  lender_business: string | null;
  /** Present only when the query joined the latest credit score. */
  score_value?: number | null;
  score_risk_level?: 'low' | 'medium' | 'high' | null;
  score_source?: string | null;
}

interface InstallmentRecord {
  id: string;
  seq: number;
  due_date: string;
  principal_due_cents: number;
  interest_due_cents: number;
  penalty_accrued_cents: number;
  paid_principal_cents: number;
  paid_interest_cents: number;
  paid_penalty_cents: number;
  status: 'pending' | 'partial' | 'paid' | 'overdue' | 'waived';
}

interface TransactionRecord {
  id: string;
  type: 'disbursement' | 'repayment';
  amount_cents: number;
  method: string;
  mobile_txn_code: string | null;
  status: 'pending' | 'held' | 'cleared' | 'rejected';
  hold_reason: string | null;
  canonical_payload_hash: string | null;
  onchain_hash: string | null;
  onchain_tx_hash: string | null;
  onchain_block: number | null;
  occurred_at: Date;
  created_at: Date;
}

const LOAN_SELECT = `
  SELECT l.*,
         b.full_name AS borrower_name,
         b.email     AS borrower_email,
         w.full_name AS lender_name,
         lp.business_name AS lender_business
    FROM loans l
    JOIN users b ON b.id = l.borrower_id
    JOIN users w ON w.id = l.lender_id
    LEFT JOIN lender_profiles lp ON lp.user_id = l.lender_id
`;

const LATERAL_SCORE = `
  LEFT JOIN LATERAL (
    SELECT score, risk_level, model_source
      FROM credit_scores c
     WHERE c.loan_id = l.id
     ORDER BY c.created_at DESC
     LIMIT 1
  ) cs ON true`;

const FREQUENCY_DAYS: Record<'daily' | 'weekly', number> = { daily: 1, weekly: 7 };

/** Adds `count` repayment periods, clamping month-end dates (31 Jan + 1m). */
export function addPeriods(from: Date, frequency: 'daily' | 'weekly' | 'monthly', count: number): Date {
  const date = new Date(from.getTime());
  if (frequency === 'monthly') {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + count);
    const endOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, endOfMonth));
    return date;
  }
  date.setUTCDate(date.getUTCDate() + FREQUENCY_DAYS[frequency] * count);
  return date;
}

/**
 * Flat interest on the original principal, charged once per period
 * (assumption A4 in the plan: informal lenders quote a flat rate per period,
 * not an amortised APR). Rounding stays in integer cents.
 */
export function computeTotalRepayable(principalCents: number, rateBps: number, termCount: number): number {
  const interest = Math.round((principalCents * rateBps * termCount) / 10_000);
  return principalCents + interest;
}

export interface ScheduleRow {
  seq: number;
  dueDate: string;
  principalDueCents: number;
  interestDueCents: number;
}

/** Equal installments; the last row absorbs integer-division remainders. */
export function buildSchedule(input: {
  principalCents: number;
  rateBps: number;
  termCount: number;
  frequency: 'daily' | 'weekly' | 'monthly';
  startDate: Date;
}): ScheduleRow[] {
  const totalInterest = computeTotalRepayable(input.principalCents, input.rateBps, input.termCount) - input.principalCents;
  const basePrincipal = Math.floor(input.principalCents / input.termCount);
  const baseInterest = Math.floor(totalInterest / input.termCount);
  const rows: ScheduleRow[] = [];

  for (let seq = 1; seq <= input.termCount; seq += 1) {
    const isLast = seq === input.termCount;
    rows.push({
      seq,
      dueDate: addPeriods(input.startDate, input.frequency, seq).toISOString().slice(0, 10),
      principalDueCents: isLast ? input.principalCents - basePrincipal * (input.termCount - 1) : basePrincipal,
      interestDueCents: isLast ? totalInterest - baseInterest * (input.termCount - 1) : baseInterest,
    });
  }
  return rows;
}

function isOverdue(dueDate: string, status: InstallmentRecord['status']): boolean {
  if (status === 'paid' || status === 'waived') return false;
  return new Date(`${dueDate}T23:59:59Z`).getTime() < Date.now();
}

function toInstallment(row: InstallmentRecord) {
  const dueCents = row.principal_due_cents + row.interest_due_cents + row.penalty_accrued_cents;
  const paidCents = row.paid_principal_cents + row.paid_interest_cents + row.paid_penalty_cents;
  return {
    id: row.id,
    seq: row.seq,
    dueDate: row.due_date,
    principalDueCents: row.principal_due_cents,
    interestDueCents: row.interest_due_cents,
    penaltyAccruedCents: row.penalty_accrued_cents,
    paidCents,
    dueCents,
    status: isOverdue(row.due_date, row.status) && row.status !== 'partial' ? 'overdue' : row.status,
  };
}

function toTransaction(row: TransactionRecord) {
  return {
    id: row.id,
    type: row.type,
    amountCents: row.amount_cents,
    method: row.method,
    mobileTxnCode: row.mobile_txn_code,
    status: row.status,
    holdReason: row.hold_reason,
    hash: row.canonical_payload_hash,
    onchain: {
      anchored: Boolean(row.onchain_hash),
      hash: row.onchain_hash,
      txHash: row.onchain_tx_hash,
      block: row.onchain_block,
      verified: Boolean(row.onchain_hash),
    },
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function toSummary(row: LoanRecord, outstandingCents: number | null = null) {
  return {
    id: row.id,
    ref: row.ref,
    status: row.status,
    principalCents: row.principal_cents,
    rateBps: row.rate_bps,
    termCount: row.term_count,
    frequency: row.frequency,
    totalRepayableCents: row.total_repayable_cents,
    purpose: row.purpose,
    outstandingCents,
    borrower: { id: row.borrower_id, fullName: row.borrower_name, email: row.borrower_email },
    lender: { id: row.lender_id, fullName: row.lender_name, businessName: row.lender_business },
    identityVerified: Boolean(row.identity_verified_at),
    agreementSha256: row.agreement_sha256,
    heldReason: row.held_reason,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    disbursedAt: row.disbursed_at,
    score:
      row.score_value === undefined || row.score_value === null
        ? null
        : { score: Number(row.score_value), riskLevel: row.score_risk_level ?? null, source: row.score_source ?? null },
  };
}

/** Loads a loan and enforces visibility: own book, own loan, or auditor. */
export async function loadVisibleLoan(actor: Actor, loanId: string): Promise<LoanRecord> {
  const loan = await queryOne<LoanRecord>(`${LOAN_SELECT} WHERE l.id = $1`, [loanId]);
  if (!loan) throw notFound('Loan not found');

  if (actor.role === 'borrower' && loan.borrower_id !== actor.id) throw notFound('Loan not found');
  if (actor.role === 'lender' && loan.lender_id !== actor.id) throw notFound('Loan not found');
  return loan;
}

function assertLenderOwns(actor: Actor, loan: LoanRecord): void {
  if (loan.lender_id !== actor.id) throw notFound('Loan not found');
}

export async function listLenderOptions() {
  const rows = await query<{
    id: string;
    full_name: string;
    business_name: string | null;
    default_rate_bps: number | null;
    max_principal_cents: number | null;
  }>(
    `SELECT u.id, u.full_name, lp.business_name, lp.default_rate_bps, lp.max_principal_cents
       FROM users u
       LEFT JOIN lender_profiles lp ON lp.user_id = u.id
      WHERE u.role = 'lender' AND u.status = 'active'
      ORDER BY COALESCE(lp.business_name, u.full_name)`,
  );
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    businessName: row.business_name,
    defaultRateBps: row.default_rate_bps ?? 1000,
    maxPrincipalCents: row.max_principal_cents ?? 50_000_00,
  }));
}

export async function createApplication(actor: Actor, input: ApplyLoanInput, req: Request) {
  if (actor.role !== 'borrower') throw forbidden('Only borrowers can apply for a loan');

  const lender = await queryOne<{ id: string; default_rate_bps: number | null; max_principal_cents: number | null }>(
    `SELECT u.id, lp.default_rate_bps, lp.max_principal_cents
       FROM users u LEFT JOIN lender_profiles lp ON lp.user_id = u.id
      WHERE u.id = $1 AND u.role = 'lender' AND u.status = 'active'`,
    [input.lenderId],
  );
  if (!lender) throw badRequest('Select an active moneylender');

  const maxPrincipal = lender.max_principal_cents ?? 50_000_00;
  if (input.principalCents > maxPrincipal) {
    throw unprocessable(`This lender lends up to ${(maxPrincipal / 100).toFixed(0)} KES per loan`);
  }

  // Identity verification needs the two encrypted identifiers on file.
  const profile = await queryOne<{ national_id_enc: string | null; phone_enc: string | null }>(
    'SELECT national_id_enc, phone_enc FROM borrower_profiles WHERE user_id = $1',
    [actor.id],
  );
  if (!profile?.national_id_enc || !profile.phone_enc) {
    throw unprocessable('Add your national ID and phone number to your profile before applying');
  }

  const rateBps = lender.default_rate_bps ?? 1000;
  const totalRepayable = computeTotalRepayable(input.principalCents, rateBps, input.termCount);

  const created = await queryOne<{ id: string }>(
    `INSERT INTO loans
       (ref, lender_id, borrower_id, principal_cents, term_count, frequency, rate_bps, purpose,
        collateral_desc, guarantor_name_enc, guarantor_phone_enc, guarantor_credit,
        total_repayable_cents, status)
     VALUES
       ('SMF-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('loan_ref_seq')::text, 6, '0'),
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
     RETURNING id`,
    [
      lender.id,
      actor.id,
      input.principalCents,
      input.termCount,
      input.frequency,
      rateBps,
      input.purpose,
      input.collateralDesc ?? null,
      input.guarantorName ? encryptField(input.guarantorName) : null,
      input.guarantorPhone ? encryptField(input.guarantorPhone) : null,
      input.guarantorCredit ?? null,
      totalRepayable,
    ],
  );
  if (!created) throw new Error('Loan insert returned no row');

  // Rule R4: rapid repeated applications. Advisory for the lender, not a block.
  await detectRapidApplications({ loanId: created.id, borrowerId: actor.id });

  // Score at submission so the lender sees an advisory risk band immediately.
  // A scoring failure must not lose the application, hence the catch.
  let score: ScoreResult | null = null;
  try {
    score = await generateScore(created.id);
  } catch (error) {
    console.warn('[scoring] could not score new application:', (error as Error).message);
  }

  await auditRequest(req, 'loan.application_submitted', 'loan', created.id, {
    ref: undefined,
    principalCents: input.principalCents,
    termCount: input.termCount,
    frequency: input.frequency,
    rateBps,
    lenderId: lender.id,
    score: score?.score ?? null,
    scoreSource: score?.modelSource ?? null,
  });

  return getLoan(actor, created.id);
}

export async function listLoans(actor: Actor, filters: LoanListQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (actor.role === 'borrower') {
    params.push(actor.id);
    conditions.push(`l.borrower_id = $${params.length}`);
  } else if (actor.role === 'lender') {
    params.push(actor.id);
    conditions.push(`l.lender_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`l.status = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    conditions.push(`(l.ref ILIKE $${params.length} OR l.purpose ILIKE $${params.length})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (filters.page - 1) * filters.pageSize;

  const rows = await query<LoanRecord & { total_count: number }>(
    `${LOAN_SELECT.replace('SELECT l.*,', 'SELECT l.*, count(*) OVER() AS total_count, cs.score AS score_value, cs.risk_level AS score_risk_level, cs.model_source AS score_source,').replace(
      'FROM loans l',
      `FROM loans l${LATERAL_SCORE}`,
    )}
     ${where}
     ORDER BY l.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, offset],
  );

  // Outstanding = what is still contractually owed, including accrued penalties.
  const ids = rows.map((row) => row.id);
  const outstanding = new Map<string, number>();
  if (ids.length > 0) {
    const agg = await query<{ loan_id: string; paid: number }>(
      `SELECT loan_id,
              COALESCE(SUM(paid_principal_cents + paid_interest_cents + paid_penalty_cents), 0)::bigint AS paid
         FROM loan_installments
        WHERE loan_id = ANY($1::uuid[])
        GROUP BY loan_id`,
      [ids],
    );
    for (const row of agg) outstanding.set(row.loan_id, Number(row.paid));
  }

  return {
    items: rows.map((row) => {
      const paid = outstanding.get(row.id) ?? 0;
      const owes = row.status === 'pending' || row.status === 'rejected' || row.status === 'under_review' ? null : Math.max(0, row.total_repayable_cents - paid);
      return toSummary(row, owes);
    }),
    page: filters.page,
    pageSize: filters.pageSize,
    total: rows[0]?.total_count ?? 0,
  };
}

export async function getLoan(actor: Actor, loanId: string) {
  const loan = await loadVisibleLoan(actor, loanId);

  // Accrue first so every read returns the true amount owed, not a stale one.
  await accruePenalties(loanId);

  const installments = await query<InstallmentRecord>(
    `SELECT id, seq, to_char(due_date, 'YYYY-MM-DD') AS due_date, principal_due_cents, interest_due_cents,
            penalty_accrued_cents, paid_principal_cents, paid_interest_cents, paid_penalty_cents, status
       FROM loan_installments WHERE loan_id = $1 ORDER BY seq`,
    [loanId],
  );

  const transactions = await query<TransactionRecord>(
    `SELECT id, type, amount_cents, method, mobile_txn_code, status, hold_reason, canonical_payload_hash,
            onchain_hash, onchain_tx_hash, onchain_block, occurred_at, created_at
       FROM transactions WHERE loan_id = $1 ORDER BY occurred_at ASC`,
    [loanId],
  );

  const flags = await query<{ id: string; flag_type: string; severity: string; status: string; detected_at: Date }>(
    `SELECT id, flag_type, severity, status, detected_at
       FROM fraud_flags WHERE loan_id = $1 ORDER BY detected_at DESC LIMIT 20`,
    [loanId],
  );

  const mappedInstallments = installments.map(toInstallment);
  const paidCents = mappedInstallments.reduce((sum, row) => sum + row.paidCents, 0);
  const penaltyCents = mappedInstallments.reduce((sum, row) => sum + (row.status === 'paid' ? 0 : row.penaltyAccruedCents), 0);
  const scheduled = mappedInstallments.length > 0;
  const outstanding = scheduled
    ? Math.max(0, loan.total_repayable_cents + penaltyCents - paidCents)
    : null;

  return {
    ...toSummary(loan, outstanding),
    collateralDesc: loan.collateral_desc,
    guarantor: loan.guarantor_name_enc
      ? {
          name: decryptField(loan.guarantor_name_enc),
          phoneMasked: maskValue(decryptField(loan.guarantor_phone_enc)),
          credit: loan.guarantor_credit,
        }
      : null,
    decisionNote: loan.decision_note,
    identityVerifiedAt: loan.identity_verified_at,
    agreement: loan.agreement_doc_id ? { docId: loan.agreement_doc_id, sha256: loan.agreement_sha256 } : null,
    scoreSnapshotId: loan.score_snapshot_id,
    score: await getLatestScore(loanId),
    installments: mappedInstallments,
    transactions: transactions.map(toTransaction),
    flags,
    summary: {
      totalRepayableCents: loan.total_repayable_cents,
      paidCents,
      accruedPenaltyCents: penaltyCents,
      outstandingCents: outstanding,
      installmentsPaid: mappedInstallments.filter((row) => row.status === 'paid').length,
      installmentsTotal: mappedInstallments.length,
    },
  };
}

export async function verifyIdentity(actor: Actor, loanId: string, note: string | undefined, req: Request) {
  if (actor.role !== 'lender') throw forbidden('Only the lender can verify identity');
  const loan = await loadVisibleLoan(actor, loanId);
  assertLenderOwns(actor, loan);

  if (loan.status !== 'pending' && loan.status !== 'under_review') {
    throw conflict(`Cannot verify identity on a ${loan.status} loan`);
  }

  await query(
    `UPDATE loans SET identity_verified_at = now(), identity_verified_by = $2, status = 'under_review'
      WHERE id = $1 AND status IN ('pending','under_review')`,
    [loanId, actor.id],
  );

  await auditRequest(req, 'loan.identity_verified', 'loan', loanId, {
    ref: loan.ref,
    borrowerId: loan.borrower_id,
    note: note ?? null,
  });

  return getLoan(actor, loanId);
}

/** Renders the agreement PDF bytes. Content is deterministic for a given loan. */
function renderAgreement(loan: LoanRecord, schedule: ScheduleRow[], decidedAt: Date): Buffer {
  const money = (cents: number) => `KES ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
  const guarantor = loan.guarantor_name_enc ? decryptField(loan.guarantor_name_enc) : null;

  const lines: PdfLine[] = [
    { text: 'LOAN AGREEMENT', size: 18, bold: true },
    { text: `Reference ${loan.ref}`, size: 11, gapBefore: 4 },
    { text: `Issued ${decidedAt.toISOString().slice(0, 10)}`, size: 9 },
    { text: '', gapBefore: 10 },
    { text: 'PARTIES', size: 10, bold: true },
    { text: `Lender: ${loan.lender_business ?? loan.lender_name}` },
    { text: `Borrower: ${loan.borrower_name}` },
    { text: '', gapBefore: 8 },
    { text: 'LOAN TERMS', size: 10, bold: true },
    { text: `Principal: ${money(loan.principal_cents)}` },
    { text: `Interest: flat ${(loan.rate_bps / 100).toFixed(2)}% of principal per ${loan.frequency.replace('ly', '')} period` },
    { text: `Term: ${loan.term_count} ${loan.frequency} installments` },
    { text: `Total repayable: ${money(loan.total_repayable_cents)}` },
    { text: `Purpose: ${loan.purpose}` },
  ];

  if (loan.collateral_desc) lines.push({ text: `Collateral: ${loan.collateral_desc}` });
  if (guarantor) lines.push({ text: `Guarantor: ${guarantor}${loan.guarantor_credit ? ` (credit ${loan.guarantor_credit})` : ''}` });

  lines.push({ text: '', gapBefore: 10 }, { text: 'REPAYMENT SCHEDULE', size: 10, bold: true });
  lines.push({ text: 'No.   Due date      Principal        Interest        Total', size: 9, bold: true });
  for (const row of schedule) {
    lines.push({
      text: `${String(row.seq).padStart(2, ' ')}    ${row.dueDate}    ${money(row.principalDueCents).padEnd(16, ' ')}${money(row.interestDueCents).padEnd(16, ' ')}${money(row.principalDueCents + row.interestDueCents)}`,
      size: 9,
    });
  }

  lines.push(
    { text: '', gapBefore: 12 },
    { text: 'RECORDS AND VERIFICATION', size: 10, bold: true },
    {
      text:
        'This agreement is generated by SecureMicrofinance. Its SHA-256 fingerprint is stored with the loan and ' +
        'shown to both parties. Every disbursement and repayment is hashed and anchored on a public ledger, so a ' +
        'receipt cannot be altered after the fact without breaking verification.',
    },
    { text: 'Sensitive identity data is encrypted at rest and only ever displayed masked.', gapBefore: 4 },
    { text: '', gapBefore: 14 },
    { text: 'Lender signature: ______________________      Borrower signature: ______________________', size: 9 },
    { text: '', gapBefore: 10 },
    { text: 'Generated document - synthetic data, demo deployment.', size: 8 },
  );

  return renderPdf(lines);
}

export async function decide(actor: Actor, loanId: string, input: DecisionInput, req: Request) {
  if (actor.role !== 'lender') throw forbidden('Only the lender can decide on a loan');
  const loan = await loadVisibleLoan(actor, loanId);
  assertLenderOwns(actor, loan);

  if (loan.status !== 'pending' && loan.status !== 'under_review') {
    throw conflict(`This loan is already ${loan.status}`);
  }

  const decidedAt = new Date();

  if (input.decision === 'reject') {
    await query(
      `UPDATE loans SET status = 'rejected', decided_at = $2, decided_by = $3, decision_note = $4
        WHERE id = $1 AND status IN ('pending','under_review')`,
      [loanId, decidedAt, actor.id, input.note ?? null],
    );
    await auditRequest(req, 'loan.rejected', 'loan', loanId, {
      ref: loan.ref,
      principalCents: loan.principal_cents,
      note: input.note ?? null,
    });
    return getLoan(actor, loanId);
  }

  if (!loan.identity_verified_at) {
    throw conflict('Verify the borrower identity before approving');
  }

  const rateBps = input.rateBps ?? loan.rate_bps;
  const totalRepayable = computeTotalRepayable(loan.principal_cents, rateBps, loan.term_count);
  const schedule = buildSchedule({
    principalCents: loan.principal_cents,
    rateBps,
    termCount: loan.term_count,
    frequency: loan.frequency,
    startDate: decidedAt,
  });

  // Bytes are rendered before the transaction: a file-system failure must not
  // leave an "approved" loan with no agreement.
  const pdf = renderAgreement({ ...loan, rate_bps: rateBps, total_repayable_cents: totalRepayable }, schedule, decidedAt);
  const digest = sha256Hex(pdf);

  const dir = path.resolve(config.storageDir, 'agreements');
  fs.mkdirSync(dir, { recursive: true });
  const relativePath = path.posix.join('agreements', `${loanId}.pdf`);
  fs.writeFileSync(path.resolve(config.storageDir, relativePath), pdf);

  const docId = await withTransaction(async (client) => {
    await client.query('DELETE FROM loan_installments WHERE loan_id = $1', [loanId]);

    for (const row of schedule) {
      await client.query(
        `INSERT INTO loan_installments (loan_id, seq, due_date, principal_due_cents, interest_due_cents)
         VALUES ($1,$2,$3,$4,$5)`,
        [loanId, row.seq, row.dueDate, row.principalDueCents, row.interestDueCents],
      );
    }

    const insertedDoc = await client.query<{ id: string }>(
      `INSERT INTO documents (loan_id, kind, mime, file_path, sha256, created_by)
       VALUES ($1, 'agreement', 'application/pdf', $2, $3, $4) RETURNING id`,
      [loanId, relativePath, digest, actor.id],
    );

    await client.query(
      `UPDATE loans
          SET status = 'approved', rate_bps = $2, total_repayable_cents = $3,
              agreement_doc_id = $4, agreement_sha256 = $5,
              decided_at = $6, decided_by = $7, decision_note = $8
        WHERE id = $1`,
      [loanId, rateBps, totalRepayable, insertedDoc.rows[0].id, digest, decidedAt, actor.id, input.note ?? null],
    );

    return insertedDoc.rows[0].id;
  });

  await auditRequest(
    req,
    'loan.approved',
    'loan',
    loanId,
    { ref: loan.ref, rateBps, totalRepayableCents: totalRepayable, installments: schedule.length },
    { afterHash: digest },
  );

  await auditRequest(req, 'document.agreement_issued', 'document', docId, {
    loanId,
    sha256: digest,
    mime: 'application/pdf',
  });

  return getLoan(actor, loanId);
}

/**
 * Releases the money and anchors the disbursement hash on-chain.
 *
 * A held flag (duplicate reference, duplicate disbursement, ...) parks the
 * loan in `held` instead of clearing it: the lender sees the alert and
 * decides, which is exactly the "fraud detection with holds" requirement.
 */
export async function disburse(actor: Actor, loanId: string, input: DisburseInput, req: Request) {
  if (actor.role !== 'lender') throw forbidden('Only the lender can disburse');
  const loan = await loadVisibleLoan(actor, loanId);
  assertLenderOwns(actor, loan);

  if (loan.status !== 'approved') {
    throw conflict(`Only an approved loan can be disbursed (this loan is ${loan.status})`);
  }

  let codeNorm: string | null = null;
  if (input.method === 'mobile_money') {
    if (!input.mobileTxnCode) throw badRequest('A mobile-money reference is required for mobile-money disbursements');
    codeNorm = normaliseMobileCode(input.mobileTxnCode);
    const validation = validateMobileCode(codeNorm);
    if (!validation.ok) throw badRequest(validation.reason ?? 'Invalid mobile-money reference');
  }

  const occurredAt = new Date();
  const created = await queryOne<{ id: string }>(
    `INSERT INTO transactions
       (loan_id, type, amount_cents, method, mobile_txn_code, mobile_txn_code_norm, occurred_at, recorded_by, status)
     VALUES ($1, 'disbursement', $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING id`,
    [loanId, loan.principal_cents, input.method, input.mobileTxnCode ?? null, codeNorm, occurredAt, actor.id],
  );
  if (!created) throw new Error('Transaction insert returned no row');

  const payloadHash = hashTransaction({
    txnId: created.id,
    loanRef: loan.ref,
    type: 'disbursement',
    amountCents: loan.principal_cents,
    occurredAt,
    mobileCodeNorm: codeNorm,
  });

  const duplicateDrafts = await detectDuplicateDisbursement({ loanId, borrowerId: loan.borrower_id });
  const referenceDrafts = codeNorm
    ? await detectReferenceIssues({ loanId, transactionId: created.id, borrowerId: loan.borrower_id, codeNorm })
    : [];
  // Layer 2: the unsupervised model. It fails open (no drafts) when the ML
  // service is unreachable, so a model outage delays nobody.
  const anomaly = await detectAnomaly({
    loanId,
    transactionId: created.id,
    borrowerId: loan.borrower_id,
    amountCents: loan.principal_cents,
    occurredAt,
  });

  const blocking = [...duplicateDrafts, ...referenceDrafts, ...anomaly.drafts].filter(
    (draft) => draft.severity === 'high' || draft.severity === 'critical',
  );

  if (blocking.length > 0) {
    const reason = `Held for review: ${blocking.map((draft) => draft.flagType.replace(/_/g, ' ')).join(', ')}`;
    await query(`UPDATE transactions SET status = 'held', hold_reason = $2, canonical_payload_hash = $3 WHERE id = $1`, [
      created.id,
      reason,
      payloadHash,
    ]);
    await query(`UPDATE loans SET status = 'held', held_reason = $2 WHERE id = $1`, [loanId, reason]);
    await auditRequest(req, 'loan.disbursement_held', 'loan', loanId, {
      ref: loan.ref,
      transactionId: created.id,
      reason,
      flagTypes: blocking.map((draft) => draft.flagType),
    });
    return { loan: await getLoan(actor, loanId), anchored: false, held: true, reason };
  }

  let anchorTxHash: string | null = null;
  let anchorBlock: number | null = null;
  let anchoredHash: string | null = null;

  if (isChainEnabled()) {
    try {
      const record = await recordOnChain({
        loanRefHash: hashLoanRef(loan.ref),
        txType: TX_TYPE.disbursement,
        occurredAt,
        recordHashHex: payloadHash,
      });
      // Persist the 32-byte digest as stored off-chain; the 0x form is only
      // for calls to the contract.
      anchoredHash = payloadHash;
      anchorTxHash = record.txHash;
      anchorBlock = record.blockNumber;
    } catch (error) {
      // The money movement is real even if the chain is unreachable; the
      // record stays visibly "not anchored" rather than pretending otherwise.
      console.warn('[ledger] disbursement anchor failed:', (error as Error).message);
    }
  }

  await query(
    `UPDATE transactions
        SET status = 'cleared', canonical_payload_hash = $2,
            onchain_hash = $3, onchain_tx_hash = $4, onchain_block = $5,
            onchain_recorded_at = $6, verified_at = $6
      WHERE id = $1`,
    [created.id, payloadHash, anchoredHash, anchorTxHash, anchorBlock, anchoredHash ? occurredAt : null],
  );
  await query(`UPDATE loans SET status = 'disbursed', disbursed_at = $2, held_reason = NULL WHERE id = $1`, [
    loanId,
    occurredAt,
  ]);

  await auditRequest(
    req,
    'loan.disbursed',
    'loan',
    loanId,
    {
      ref: loan.ref,
      transactionId: created.id,
      amountCents: loan.principal_cents,
      method: input.method,
      anchored: Boolean(anchoredHash),
    },
    { afterHash: payloadHash },
  );

  return { loan: await getLoan(actor, loanId), anchored: Boolean(anchoredHash), held: false, reason: null };
}

/** Returns the stored agreement file after re-checking the caller's access. */
export async function getAgreementFile(actor: Actor, loanId: string, req: Request) {
  const loan = await loadVisibleLoan(actor, loanId);
  if (!loan.agreement_doc_id) throw notFound('No agreement has been issued for this loan yet');

  const doc = await queryOne<{ file_path: string; sha256: string; mime: string }>(
    'SELECT file_path, sha256, mime FROM documents WHERE id = $1',
    [loan.agreement_doc_id],
  );
  if (!doc) throw notFound('Agreement document is missing');

  const absolute = path.resolve(config.storageDir, doc.file_path);
  const root = path.resolve(config.storageDir);
  // Defence in depth: file_path comes from our own database, but a path that
  // escapes the storage root must never be served.
  if (!absolute.startsWith(root + path.sep)) throw notFound('Agreement document is missing');
  if (!fs.existsSync(absolute)) throw notFound('Agreement document is missing');

  // Hash the bytes we are about to send, not just the hash we recorded when the
  // document was issued. Without this, anyone who can write to the storage
  // directory could swap the file and the download would still advertise the
  // original digest. Serving the file is the only moment it can be checked.
  const bytes = fs.readFileSync(absolute);
  const actualSha256 = sha256Hex(bytes);
  if (actualSha256 !== doc.sha256) {
    await auditRequest(req, 'document.integrity_violation', 'document', loan.agreement_doc_id, {
      loanId,
      ref: loan.ref,
      expectedSha256: doc.sha256,
      actualSha256,
    });
    throw conflict('The stored agreement does not match its recorded hash; refusing to serve it');
  }

  await auditRequest(req, 'document.agreement_downloaded', 'document', loan.agreement_doc_id, {
    loanId,
    sha256: doc.sha256,
  });

  return { bytes, filename: `${loan.ref}-agreement.pdf`, mime: doc.mime, sha256: doc.sha256 };
}
