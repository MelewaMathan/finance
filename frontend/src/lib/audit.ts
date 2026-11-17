import { api } from './api';
import { downloadFile } from './loans';

/**
 * Forensic dashboard client (M7).
 *
 * The admin reads, never writes business data. The two writes here -- an
 * integrity run and an export -- are recorded as the admin's own actions,
 * which is why the server returns them instead of hiding them.
 */
export interface AuditRow {
  seq: number;
  createdAt: string;
  actorRole: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  ip: string | null;
  requestId: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  prevHash: string;
  rowHash: string;
  detail: Record<string, unknown>;
}

export interface AuditPage {
  items: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditFilters {
  q?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  from?: string;
  to?: string;
}

export type TimelineKind = 'audit' | 'transaction' | 'flag' | 'document';

export interface TimelineEvent {
  at: string;
  kind: TimelineKind;
  title: string;
  detail: string;
  seq?: number;
  entityType?: string;
  entityId?: string;
  hash?: string | null;
}

export interface Timeline {
  loan: { id: string; ref: string };
  events: TimelineEvent[];
}

export type IntegrityScope = 'all' | 'audit_chain' | 'loan';
export type IntegrityResult = 'ok' | 'tampered' | 'error';

export interface ChainMismatch {
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
  mismatches: ChainMismatch[];
}

export interface LoanIntegrityLine {
  id: string;
  ref: string;
  ok: boolean;
  summary: { total: number; verified: number; anchoredUnchecked: number; unanchored: number; broken: number };
}

export interface IntegrityRun {
  id: string | null;
  scope: IntegrityScope;
  targetId: string | null;
  result: IntegrityResult;
  recordsChecked: number;
  mismatches: number;
  detail: { chain?: ChainVerification; loans?: LoanIntegrityLine[]; loanCount?: number };
  checkedAt: string;
}

export interface IntegrityHistoryRow {
  id: string;
  scope: string;
  targetId: string | null;
  recordsChecked: number;
  mismatches: number;
  result: IntegrityResult;
  runBy: string | null;
  createdAt: string;
}

export const INTEGRITY_TONE: Record<IntegrityResult, 'success' | 'danger' | 'warning'> = {
  ok: 'success',
  tampered: 'danger',
  error: 'warning',
};

export const SCOPE_LABEL: Record<string, string> = {
  audit_chain: 'Audit chain',
  all: 'Chain + all ledgers',
  loan: 'Single loan',
  entity: 'Single entity',
};

export const KIND_TONE: Record<TimelineKind, 'neutral' | 'info' | 'warning' | 'success'> = {
  audit: 'info',
  transaction: 'success',
  flag: 'warning',
  document: 'neutral',
};

/** The action's first segment: loan, repayment, auth, fraud, audit, integrity. */
export function actionFamily(action: string): string {
  return action.split('.')[0] ?? action;
}

function toSearch(filters: AuditFilters, extra: Record<string, string | number> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) search.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== '' && value !== undefined) search.set(key, String(value));
  }
  return search.toString();
}

export async function searchAudit(filters: AuditFilters, page = 1, pageSize = 50): Promise<AuditPage> {
  return api<AuditPage>(`/audit/logs?${toSearch(filters, { page, pageSize })}`);
}

export async function auditActions(): Promise<Array<{ action: string; count: number }>> {
  const body = await api<{ actions: Array<{ action: string; count: number }> }>('/audit/actions');
  return body.actions;
}

/** Look a loan up by id or by the reference printed on the agreement. */
export async function loadTimeline(locator: { loanId?: string; ref?: string }): Promise<Timeline> {
  const search = new URLSearchParams();
  if (locator.loanId) search.set('loanId', locator.loanId);
  if (locator.ref) search.set('ref', locator.ref);
  return api<Timeline>(`/audit/timeline?${search.toString()}`);
}

export async function runIntegrityCheck(
  scope: IntegrityScope,
  locator?: { targetId?: string; ref?: string },
): Promise<IntegrityRun> {
  const body = await api<{ check: IntegrityRun }>('/integrity/check', {
    method: 'POST',
    body: { scope, targetId: locator?.targetId, ref: locator?.ref },
  });
  return body.check;
}

export async function listIntegrityChecks(limit = 20): Promise<IntegrityHistoryRow[]> {
  const body = await api<{ checks: IntegrityHistoryRow[] }>(`/integrity/checks?limit=${limit}`);
  return body.checks;
}

/** Downloads the current filter selection, not the current page. */
export async function exportAudit(format: 'csv' | 'pdf', filters: AuditFilters): Promise<void> {
  const query = toSearch(filters);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  await downloadFile(`/audit/export.${format}${query ? `?${query}` : ''}`, `audit-log-${stamp}.${format}`);
}
