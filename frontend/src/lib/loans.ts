import { api, getAccessToken, refreshAccessToken } from './api';

/** Typed access to the loan endpoints (M2). */

export type LoanStatus =
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

export type Frequency = 'daily' | 'weekly' | 'monthly';

export interface Party {
  id: string;
  fullName: string;
  email?: string;
  institutionName?: string | null;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export interface ScoreFactor {
  feature: string;
  impact: number;
  direction: 'risk' | 'protective';
}

/** Advisory credit score snapshot. Never a decision, only an input to one. */
export interface LoanScore {
  id: string;
  score: number;
  riskLevel: RiskLevel;
  defaultProbability: number | null;
  modelVersion: string;
  modelSource: 'ml_service' | 'fallback_heuristic';
  features: Record<string, number>;
  explanation: ScoreFactor[];
  latencyMs: number;
  advisoryOnly: boolean;
  createdAt: string;
}

/** Row-level summary used by the queue and the borrower list. */
export interface ScoreSummary {
  score: number;
  riskLevel: RiskLevel | null;
  source: string | null;
}

export interface LoanSummary {
  id: string;
  ref: string;
  status: LoanStatus;
  principalCents: number;
  rateBps: number;
  termCount: number;
  frequency: Frequency;
  totalRepayableCents: number;
  purpose: string;
  outstandingCents: number | null;
  borrower: Party;
  lender: Party;
  identityVerified: boolean;
  agreementSha256: string | null;
  heldReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  disbursedAt: string | null;
  score: ScoreSummary | null;
}

export interface Installment {
  id: string;
  seq: number;
  dueDate: string;
  principalDueCents: number;
  interestDueCents: number;
  penaltyAccruedCents: number;
  paidCents: number;
  dueCents: number;
  status: 'pending' | 'partial' | 'paid' | 'overdue' | 'waived';
}

export interface LoanTransaction {
  id: string;
  type: 'disbursement' | 'repayment';
  amountCents: number;
  method: 'cash' | 'mobile_money' | 'bank';
  mobileTxnCode: string | null;
  status: 'pending' | 'held' | 'cleared' | 'rejected';
  holdReason: string | null;
  hash: string | null;
  onchain: { anchored: boolean; hash: string | null; txHash: string | null; block: number | null; verified: boolean };
  occurredAt: string;
  createdAt: string;
}

export interface LoanFlag {
  id: string;
  flag_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'cleared' | 'confirmed';
  detected_at: string;
}

/** The detail view carries the full snapshot, not just the three list columns. */
export interface LoanDetail extends Omit<LoanSummary, 'score'> {
  collateralDesc: string | null;
  guarantor: { name: string | null; phoneMasked: string | null; credit: number | null } | null;
  decisionNote: string | null;
  identityVerifiedAt: string | null;
  agreement: { docId: string; sha256: string } | null;
  scoreSnapshotId: string | null;
  score: LoanScore | null;
  installments: Installment[];
  transactions: LoanTransaction[];
  flags: LoanFlag[];
  summary: {
    totalRepayableCents: number;
    paidCents: number;
    accruedPenaltyCents: number;
    outstandingCents: number | null;
    installmentsPaid: number;
    installmentsTotal: number;
  };
}

export interface LenderOption {
  id: string;
  fullName: string;
  institutionName: string | null;
  defaultRateBps: number;
  maxPrincipalCents: number;
}

export interface LoanPage {
  items: LoanSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export const STATUS_LABEL: Record<LoanStatus, string> = {
  pending: 'Awaiting review',
  under_review: 'Under review',
  approved: 'Approved',
  rejected: 'Rejected',
  held: 'Held for fraud review',
  disbursed: 'Disbursed',
  active: 'Repaying',
  settled: 'Settled',
  defaulted: 'Defaulted',
  cancelled: 'Cancelled',
};

export const STATUS_TONE: Record<LoanStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  pending: 'warning',
  under_review: 'info',
  approved: 'info',
  rejected: 'danger',
  held: 'danger',
  disbursed: 'success',
  active: 'success',
  settled: 'success',
  defaulted: 'danger',
  cancelled: 'neutral',
};

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

export const RISK_TONE: Record<RiskLevel, 'success' | 'warning' | 'danger'> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
};

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
};

/** Human labels for the model's feature names. */
export const FEATURE_LABEL: Record<string, string> = {
  principal_to_income: 'Principal vs income',
  installment_to_income: 'Installment vs income',
  term_count: 'Number of periods',
  rate_bps: 'Interest rate',
  is_daily: 'Daily repayments',
  prior_loans: 'Previous loans',
  prior_settled: 'Loans fully repaid',
  prior_defaults: 'Previous defaults',
  arrears_ratio: 'Past arrears',
  active_loans: 'Loans still open',
  has_collateral: 'Collateral offered',
  has_guarantor: 'Guarantor provided',
  guarantor_credit: 'Guarantor credit',
  account_age_days: 'Account age',
};

export async function rescoreLoan(loanId: string): Promise<LoanScore> {
  const response = await api<{ score: LoanScore }>(`/loans/${loanId}/score`, { method: 'POST', body: {} });
  return response.score;
}

export async function listLenders(): Promise<LenderOption[]> {
  const response = await api<{ items: LenderOption[] }>('/lenders');
  return response.items;
}

export async function listLoans(params: { status?: LoanStatus; q?: string; pageSize?: number } = {}): Promise<LoanPage> {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.q) search.set('q', params.q);
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  const suffix = search.size > 0 ? `?${search.toString()}` : '';
  return api<LoanPage>(`/loans${suffix}`);
}

export async function getLoan(loanId: string): Promise<LoanDetail> {
  const response = await api<{ loan: LoanDetail }>(`/loans/${loanId}`);
  return response.loan;
}

export interface ApplyLoanPayload {
  lenderId: string;
  principalCents: number;
  termCount: number;
  frequency: Frequency;
  purpose: string;
  collateralDesc?: string;
  guarantorName?: string;
  guarantorPhone?: string;
  guarantorCredit?: number;
}

export async function applyLoan(payload: ApplyLoanPayload): Promise<LoanDetail> {
  const response = await api<{ loan: LoanDetail }>('/loans', { method: 'POST', body: payload });
  return response.loan;
}

export async function verifyLoan(loanId: string, note?: string): Promise<LoanDetail> {
  const response = await api<{ loan: LoanDetail }>(`/loans/${loanId}/verify`, {
    method: 'POST',
    body: { note },
  });
  return response.loan;
}

export async function decideLoan(
  loanId: string,
  payload: { decision: 'approve' | 'reject'; rateBps?: number; note?: string },
): Promise<LoanDetail> {
  const response = await api<{ loan: LoanDetail }>(`/loans/${loanId}/decision`, {
    method: 'POST',
    body: payload,
  });
  return response.loan;
}

export async function disburseLoan(
  loanId: string,
  payload: { method: 'cash' | 'mobile_money' | 'bank'; mobileTxnCode?: string },
): Promise<{ loan: LoanDetail; anchored: boolean; held: boolean; reason: string | null }> {
  return api(`/loans/${loanId}/disburse`, { method: 'POST', body: payload });
}

export interface RepaymentPayload {
  amountCents: number;
  method: 'cash' | 'mobile_money' | 'bank';
  mobileTxnCode?: string;
  occurredAt?: string;
  note?: string;
}

export async function recordRepayment(
  loanId: string,
  payload: RepaymentPayload,
): Promise<{ loan: LoanDetail; held: boolean; anchored: boolean; reason: string | null }> {
  return api(`/loans/${loanId}/repayments`, { method: 'POST', body: payload });
}

/** Authenticated file download shared by agreements, statements and reports. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const request = () =>
    fetch(`/api/v1${path}`, {
      headers: getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {},
      credentials: 'include',
    });

  let response = await request();
  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) response = await request();
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? 'Download failed');
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function downloadStatement(loanId: string, ref: string, format: 'pdf' | 'csv'): Promise<void> {
  await downloadFile(`/loans/${loanId}/statement.${format}`, `${ref}-statement.${format}`);
}

/**
 * Downloads the agreement through authenticated fetch (the route needs the
 * Bearer token, so a plain <a href> would 401). The SHA-256 is returned by
 * the server in a response header and shown next to the download button.
 */
export async function downloadAgreement(loanId: string, ref: string): Promise<void> {
  await downloadFile(`/loans/${loanId}/agreement`, `${ref}-agreement.pdf`);
}
