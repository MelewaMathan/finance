import { query, queryOne } from '../../db/pool';
import { config } from '../../config/env';

/**
 * Rule-based fraud detection (layer 1).
 *
 * Every rule is deterministic, explainable and cheap: a forensic auditor can
 * read the flag detail and see exactly why it fired. The Isolation Forest
 * layer (layer 2) lives in anomaly.client.ts.
 */
export type FlagType =
  | 'duplicate_txn_code'
  | 'malformed_reference'
  | 'identity_conflict'
  | 'rapid_applications'
  | 'ml_anomaly'
  | 'duplicate_disbursement'
  | 'hash_mismatch';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface FlagDraft {
  flagType: FlagType;
  severity: Severity;
  source: 'rule' | 'ml';
  ruleId: string;
  loanId?: string | null;
  transactionId?: string | null;
  borrowerId?: string | null;
  detail: Record<string, unknown>;
  dedupeKey: string;
}

/** M-Pesa style receipt: 10 uppercase alphanumerics, e.g. SJ21AB3XYZ. */
export const MOBILE_CODE_PATTERN = /^[A-Z0-9]{10}$/;

/** Obvious fabricated references seen in real disputes. */
const FORGED_PATTERNS = [/^0+$/, /^1+$/, /^X+$/, /^TEST/i, /^FAKE/i, /^(1234567890)$/];

export function normaliseMobileCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

export function validateMobileCode(code: string): { ok: boolean; reason?: string } {
  if (!MOBILE_CODE_PATTERN.test(code)) {
    return { ok: false, reason: 'Reference must be 10 alphanumeric characters (M-Pesa style)' };
  }
  if (FORGED_PATTERNS.some((pattern) => pattern.test(code))) {
    return { ok: false, reason: 'Reference matches a known forged/test pattern' };
  }
  return { ok: true };
}

/** Inserts a flag unless the same (dedupeKey) already exists. */
export async function raiseFlag(draft: FlagDraft): Promise<{ id: string; created: boolean }> {
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO fraud_flags
       (loan_id, transaction_id, borrower_id, flag_type, severity, source, rule_id, detail, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      draft.loanId ?? null,
      draft.transactionId ?? null,
      draft.borrowerId ?? null,
      draft.flagType,
      draft.severity,
      draft.source,
      draft.ruleId,
      JSON.stringify(draft.detail),
      draft.dedupeKey,
    ],
  );

  if (inserted) return { id: inserted.id, created: true };

  const existing = await queryOne<{ id: string }>('SELECT id FROM fraud_flags WHERE dedupe_key = $1', [
    draft.dedupeKey,
  ]);
  return { id: existing?.id ?? '', created: false };
}

/** Sends an in-app alert to institution staff. */
export async function alertStaff(loanId: string, title: string, body: string, severity: Severity): Promise<void> {
  await query(
    `INSERT INTO alerts (user_id, type, severity, title, body, entity_type, entity_id)
     SELECT id, $1, $2, $3, $4, 'loan', $5
       FROM users
      WHERE role = 'staff' AND status = 'active'`,
    ['fraud_flag', severity, title, body, loanId],
  );
}

/**
 * R3 -- identity inconsistency.
 * Compares blind indexes; no decryption is involved.
 */
export async function detectIdentityConflicts(input: {
  userId: string;
  nationalIdBi?: string;
  phoneBi?: string;
}): Promise<FlagDraft[]> {
  const drafts: FlagDraft[] = [];

  const checks: Array<{ column: 'national_id_bi' | 'phone_bi'; value: string; type: FlagType; label: string }> = [];
  if (input.nationalIdBi) {
    checks.push({ column: 'national_id_bi', value: input.nationalIdBi, type: 'identity_conflict', label: 'national ID' });
  }
  if (input.phoneBi) {
    checks.push({ column: 'phone_bi', value: input.phoneBi, type: 'identity_conflict', label: 'phone number' });
  }

  for (const check of checks) {
    const duplicates = await query<{ user_id: string; email: string }>(
      `SELECT bp.user_id, u.email
         FROM borrower_profiles bp
         JOIN users u ON u.id = bp.user_id
        WHERE bp.${check.column} = $1 AND bp.user_id <> $2`,
      [check.value, input.userId],
    );

    if (duplicates.length > 0) {
      const draft: FlagDraft = {
        flagType: check.type,
        severity: 'critical',
        source: 'rule',
        ruleId: `R3_identity_conflict_${check.column}`,
        borrowerId: input.userId,
        detail: {
          field: check.label,
          duplicateAccounts: duplicates.map((row) => row.user_id),
          // Emails are partially masked: enough to investigate, not a data dump.
          duplicateEmailsMasked: duplicates.map((row) => row.email.replace(/(.{2}).*(@.*)/, '$1***$2')),
        },
        dedupeKey: `identity:${check.column}:${check.value}`,
      };
      const result = await raiseFlag(draft);
      if (result.created) drafts.push(draft);
    }
  }

  return drafts;
}

/**
 * R1/R2 -- payment reference checks for a repayment or disbursement.
 */
export async function detectReferenceIssues(input: {
  loanId: string;
  transactionId: string;
  borrowerId: string;
  codeNorm: string;
}): Promise<FlagDraft[]> {
  const drafts: FlagDraft[] = [];

  const validation = validateMobileCode(input.codeNorm);
  if (!validation.ok) {
    const draft: FlagDraft = {
      flagType: 'malformed_reference',
      severity: 'high',
      source: 'rule',
      ruleId: 'R2_malformed_reference',
      loanId: input.loanId,
      transactionId: input.transactionId,
      borrowerId: input.borrowerId,
      detail: { code: input.codeNorm, reason: validation.reason },
      dedupeKey: `malformed:${input.transactionId}`,
    };
    const result = await raiseFlag(draft);
    if (result.created) drafts.push(draft);
  }

  // Reuse of the same mobile-money receipt is the classic double-claim fraud.
  const duplicates = await query<{ id: string; loan_id: string; amount_cents: number }>(
    `SELECT id, loan_id, amount_cents
       FROM transactions
      WHERE mobile_txn_code_norm = $1
        AND id <> $2
        AND status <> 'rejected'`,
    [input.codeNorm, input.transactionId],
  );

  if (duplicates.length > 0) {
    const crossLoan = duplicates.some((row) => row.loan_id !== input.loanId);
    const draft: FlagDraft = {
      flagType: 'duplicate_txn_code',
      severity: crossLoan ? 'critical' : 'high',
      source: 'rule',
      ruleId: 'R1_duplicate_txn_code',
      loanId: input.loanId,
      transactionId: input.transactionId,
      borrowerId: input.borrowerId,
      detail: {
        code: input.codeNorm,
        reusedOnLoans: duplicates.map((row) => row.loan_id),
        otherTransactionIds: duplicates.map((row) => row.id),
        crossLoan,
      },
      dedupeKey: `dupcode:${input.codeNorm}`,
    };
    const result = await raiseFlag(draft);
    if (result.created) drafts.push(draft);
    if (result.created && crossLoan) {
      await alertStaff(
        input.loanId,
        'Duplicate mobile-money reference',
        `Receipt ${input.codeNorm} has already been used on another loan. Disbursement/repayment is held for review.`,
        'critical',
      );
    }
  }

  return drafts;
}

/** R4 -- rapid repeated applications by the same borrower. */
export async function detectRapidApplications(input: {
  loanId: string;
  borrowerId: string;
}): Promise<FlagDraft[]> {
  const windowHours = config.RAPID_APPLICATION_WINDOW_HOURS;
  const maxLoans = config.RAPID_APPLICATION_MAX_LOANS;

  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM loans
      WHERE borrower_id = $1
        AND created_at > now() - ($2 || ' hours')::interval
        AND id <> $3`,
    [input.borrowerId, String(windowHours), input.loanId],
  );

  const count = row?.count ?? 0;
  if (count < maxLoans) return [];

  const draft: FlagDraft = {
    flagType: 'rapid_applications',
    severity: count >= maxLoans * 2 ? 'high' : 'medium',
    source: 'rule',
    ruleId: 'R4_rapid_applications',
    loanId: input.loanId,
    borrowerId: input.borrowerId,
    detail: { applicationsInWindow: count + 1, windowHours, threshold: maxLoans },
    dedupeKey: `rapid:${input.borrowerId}:${Math.floor(Date.now() / (windowHours * 3600 * 1000))}`,
  };
  const result = await raiseFlag(draft);
  return result.created ? [draft] : [];
}

/** R5 -- a second disbursement attempt for the same loan. */
export async function detectDuplicateDisbursement(input: {
  loanId: string;
  borrowerId: string;
}): Promise<FlagDraft[]> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM transactions
      WHERE loan_id = $1 AND type = 'disbursement' AND status IN ('cleared','held')`,
    [input.loanId],
  );
  if (existing.length === 0) return [];

  const draft: FlagDraft = {
    flagType: 'duplicate_disbursement',
    severity: 'critical',
    source: 'rule',
    ruleId: 'R5_duplicate_disbursement',
    loanId: input.loanId,
    borrowerId: input.borrowerId,
    detail: { existingTransactionIds: existing.map((row) => row.id) },
    dedupeKey: `dupdisb:${input.loanId}`,
  };
  const result = await raiseFlag(draft);
  return result.created ? [draft] : [];
}
