import { api } from './api';

/**
 * Fraud review client.
 *
 * Two separate concepts are kept separate here as well, because the UI must
 * never blur them: a *flag* is a judgement about a pattern, a *hold* means the
 * money has not moved. Clearing a flag does not release the money.
 */
export type FlagSeverity = 'low' | 'medium' | 'high' | 'critical';
export type FlagStatus = 'open' | 'cleared' | 'confirmed';
export type FlagSource = 'rule' | 'ml';

export interface FlagDetail {
  code?: string;
  reason?: string;
  field?: string;
  modelVersion?: string;
  risk?: number;
  decisionScore?: number;
  threshold?: number;
  duplicateAccounts?: string[];
  duplicateEmailsMasked?: string[];
  reusedOnLoans?: string[];
  applicationsInWindow?: number;
  windowHours?: number;
  crossLoan?: boolean;
  features?: Record<string, number>;
  unusual?: Array<{ feature: string; value: number; typical: number; deviation: number }>;
  [key: string]: unknown;
}

export interface FraudFlag {
  id: string;
  loanId: string | null;
  loanRef: string | null;
  transactionId: string | null;
  borrowerId: string | null;
  borrowerName: string | null;
  flagType: string;
  severity: FlagSeverity;
  status: FlagStatus;
  source: FlagSource;
  ruleId: string | null;
  detail: FlagDetail;
  transactionStatus: string | null;
  transactionHoldReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  resolutionNote: string | null;
}

export interface FraudSummary {
  openFlags: number;
  bySeverity: Record<FlagSeverity, number>;
  heldMovements: number;
  newLast24h: number;
  mlFlags: number;
}

export interface AlertItem {
  id: string;
  type: string;
  severity: FlagSeverity;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

export const FLAG_TYPE_LABEL: Record<string, string> = {
  duplicate_txn_code: 'Receipt reused',
  malformed_reference: 'Forged reference',
  identity_conflict: 'Identity conflict',
  rapid_applications: 'Rapid applications',
  ml_anomaly: 'Unusual pattern (model)',
  duplicate_disbursement: 'Duplicate disbursement',
  hash_mismatch: 'Hash mismatch',
};

export const SEVERITY_TONE: Record<FlagSeverity, 'neutral' | 'info' | 'warning' | 'danger'> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

export const STATUS_TONE: Record<FlagStatus, 'warning' | 'success' | 'danger'> = {
  open: 'warning',
  cleared: 'success',
  confirmed: 'danger',
};

export function flagTypeLabel(type: string): string {
  return FLAG_TYPE_LABEL[type] ?? type.replace(/_/g, ' ');
}

export async function getFraudSummary(): Promise<FraudSummary> {
  const body = await api<{ summary: FraudSummary }>('/fraud/summary');
  return body.summary;
}

export async function listFlags(params: { status: FlagStatus | 'all'; severity?: FlagSeverity }): Promise<FraudFlag[]> {
  const search = new URLSearchParams({ status: params.status });
  if (params.severity) search.set('severity', params.severity);
  const body = await api<{ flags: FraudFlag[]; count: number }>(`/fraud/flags?${search.toString()}`);
  return body.flags;
}

export async function listLoanFlags(loanId: string): Promise<FraudFlag[]> {
  const body = await api<{ flags: FraudFlag[] }>(`/loans/${loanId}/flags`);
  return body.flags;
}

export async function resolveFlag(
  flagId: string,
  resolution: 'cleared' | 'confirmed',
  note: string,
): Promise<FraudFlag> {
  const body = await api<{ flag: FraudFlag }>(`/fraud/flags/${flagId}/resolve`, {
    method: 'POST',
    body: { resolution, note },
  });
  return body.flag;
}

/** Release or reject the money movement parked by a hold. */
export async function resolveHold(
  loanId: string,
  decision: 'release' | 'reject',
  note: string,
): Promise<{ decision: string }> {
  return api<{ decision: string }>(`/loans/${loanId}/holds/resolve`, {
    method: 'POST',
    body: { decision, note },
  });
}

export async function listAlerts(unreadOnly = false): Promise<{ alerts: AlertItem[]; unread: number }> {
  return api<{ alerts: AlertItem[]; unread: number }>(`/alerts?unread=${unreadOnly ? 'true' : 'false'}`);
}

export async function markAlertRead(alertId: string): Promise<AlertItem> {
  const body = await api<{ alert: AlertItem }>(`/alerts/${alertId}/read`, { method: 'POST' });
  return body.alert;
}
