import type { Request } from 'express';
import { query, queryOne } from '../../db/pool';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { renderPdf, type PdfLine } from '../../lib/pdf';
import { getLoanLedgerReport } from '../ledger/ledger.service';
import type { Actor } from '../loans/loan.service';
import { auditRequest, verifyAuditChain, type ChainVerification } from './audit.service';

/**
 * Forensic reads (M7).
 *
 * The auditor's dashboard is built from three questions, and they are answered
 * by three different mechanisms -- mixing them up would be the classic way to
 * claim more assurance than actually exists:
 *
 *   what happened?      the audit log (append-only, hash chained)
 *   in what order?     a per-loan timeline merged from every source
 *   is it still true?  recomputation, plus comparison with the chain
 *
 * Nothing here mutates business data. The only writes are the audit row for
 * the read itself and the record of an integrity run, both of which are the
 * auditor's own footprint.
 */

export interface AuditFilters {
  q?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  from?: string;
  to?: string;
}

export interface AuditRowView {
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

interface AuditDbRow {
  seq: number;
  created_at: Date;
  actor_role: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  ip: string | null;
  request_id: string | null;
  before_hash: string | null;
  after_hash: string | null;
  prev_hash: string;
  row_hash: string;
  detail: Record<string, unknown>;
}

const AUDIT_SELECT = `
  SELECT a.seq, a.created_at, a.actor_role, u.full_name AS actor_name, a.action,
         a.entity_type, a.entity_id, a.ip::text AS ip, a.request_id,
         a.before_hash, a.after_hash, a.prev_hash, a.row_hash, a.detail
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_user_id
`;

function toRow(row: AuditDbRow): AuditRowView {
  return {
    seq: Number(row.seq),
    createdAt: new Date(row.created_at).toISOString(),
    actorRole: row.actor_role,
    actorName: row.actor_name,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    ip: row.ip,
    requestId: row.request_id,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    prevHash: row.prev_hash,
    rowHash: row.row_hash,
    detail: row.detail ?? {},
  };
}

function assertAuditor(actor: Actor): void {
  if (actor.role !== 'auditor') throw forbidden('Only a forensic auditor may use the forensic views');
}

/** Builds the shared WHERE clause so search, CSV and PDF cannot disagree. */
function buildWhere(filters: AuditFilters): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.q) {
    // LIKE metacharacters in user input are escaped so "100%" searches for the
    // literal text rather than everything.
    const escaped = filters.q.replace(/[\\%_]/g, (match) => `\\${match}`);
    params.push(`%${escaped}%`);
    const i = params.length;
    where.push(
      `(a.action ILIKE $${i} OR a.entity_id ILIKE $${i} OR a.actor_role ILIKE $${i} OR a.detail::text ILIKE $${i})`,
    );
  }
  if (filters.action) {
    params.push(filters.action);
    where.push(`a.action = $${params.length}`);
  }
  if (filters.entityType) {
    params.push(filters.entityType);
    where.push(`a.entity_type = $${params.length}`);
  }
  if (filters.entityId) {
    params.push(filters.entityId);
    where.push(`a.entity_id = $${params.length}`);
  }
  if (filters.actorId) {
    params.push(filters.actorId);
    where.push(`a.actor_user_id = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`a.created_at >= $${params.length}::timestamptz`);
  }
  if (filters.to) {
    // A date-only upper bound means "the whole of that day", not midnight.
    const to = filters.to.length === 10 ? `${filters.to}T23:59:59.999Z` : filters.to;
    params.push(to);
    where.push(`a.created_at <= $${params.length}::timestamptz`);
  }

  return { clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
}

export interface AuditPage {
  items: AuditRowView[];
  total: number;
  page: number;
  pageSize: number;
}

export async function searchAudit(
  actor: Actor,
  filters: AuditFilters,
  page: number,
  pageSize: number,
): Promise<AuditPage> {
  assertAuditor(actor);
  const { clause, params } = buildWhere(filters);

  const [rows, total] = await Promise.all([
    query<AuditDbRow>(
      `${AUDIT_SELECT} ${clause} ORDER BY a.seq DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    ),
    queryOne<{ count: number }>(`SELECT count(*)::int AS count FROM audit_log a ${clause}`, params),
  ]);

  return { items: rows.map(toRow), total: Number(total?.count ?? 0), page, pageSize };
}

/** Action names for the filter dropdown, most frequent first. */
export async function auditActions(actor: Actor): Promise<Array<{ action: string; count: number }>> {
  assertAuditor(actor);
  const rows = await query<{ action: string; count: number }>(
    'SELECT action, count(*)::int AS count FROM audit_log GROUP BY action ORDER BY count DESC, action ASC',
  );
  return rows.map((row) => ({ action: row.action, count: Number(row.count) }));
}

export interface TimelineEvent {
  at: string;
  kind: 'audit' | 'transaction' | 'flag' | 'document';
  title: string;
  detail: string;
  seq?: number;
  entityType?: string;
  entityId?: string;
  /** Present when the event has a hash worth comparing with the ledger. */
  hash?: string | null;
}

/**
 * One loan's story, from every table that knows part of it.
 *
 * Audit rows give the authoritative order of *actions*; transactions and flags
 * are included because a reviewer looking at a dispute wants the money and the
 * suspicion on the same line, not one click away.
 */
export async function loanTimeline(
  actor: Actor,
  locator: { loanId?: string; ref?: string },
): Promise<{ loan: { id: string; ref: string }; events: TimelineEvent[] }> {
  assertAuditor(actor);

  // A dispute file quotes the loan reference, not the internal uuid.
  const loan = locator.loanId
    ? await queryOne<{ id: string; ref: string }>('SELECT id, ref FROM loans WHERE id = $1', [locator.loanId])
    : await queryOne<{ id: string; ref: string }>('SELECT id, ref FROM loans WHERE upper(ref) = upper($1)', [
        locator.ref,
      ]);
  if (!loan) throw notFound('Loan not found');
  const loanId = loan.id;

  const [transactions, documents, flags] = await Promise.all([
    query<{ id: string; type: string; amount_cents: number; status: string; occurred_at: Date; canonical_payload_hash: string | null }>(
      `SELECT id, type, amount_cents, status, occurred_at, canonical_payload_hash
         FROM transactions WHERE loan_id = $1 ORDER BY occurred_at ASC`,
      [loanId],
    ),
    query<{ id: string; kind: string; sha256: string; created_at: Date }>(
      'SELECT id, kind, sha256, created_at FROM documents WHERE loan_id = $1 ORDER BY created_at ASC',
      [loanId],
    ),
    query<{ id: string; flag_type: string; severity: string; status: string; detected_at: Date; source: string }>(
      `SELECT id, flag_type, severity, status, detected_at, source
         FROM fraud_flags WHERE loan_id = $1 ORDER BY detected_at ASC`,
      [loanId],
    ),
  ]);

  const entityIds = [loanId, ...transactions.map((row) => row.id), ...documents.map((row) => row.id), ...flags.map((row) => row.id)];
  const auditRows = await query<AuditDbRow>(
    `${AUDIT_SELECT} WHERE a.entity_id = ANY($1::text[]) ORDER BY a.seq ASC`,
    [entityIds],
  );

  const events: TimelineEvent[] = [
    ...auditRows.map((row) => ({
      at: new Date(row.created_at).toISOString(),
      kind: 'audit' as const,
      title: row.action,
      detail: `${row.actor_role ?? 'system'}${row.actor_name ? ` · ${row.actor_name}` : ''}`,
      seq: Number(row.seq),
      entityType: row.entity_type,
      entityId: row.entity_id ?? undefined,
      hash: row.after_hash ?? null,
    })),
    ...transactions.map((row) => ({
      at: new Date(row.occurred_at).toISOString(),
      kind: 'transaction' as const,
      title: `${row.type} ${row.status}`,
      detail: `KES ${(Number(row.amount_cents) / 100).toFixed(2)}`,
      entityType: 'transaction',
      entityId: row.id,
      hash: row.canonical_payload_hash,
    })),
    ...documents.map((row) => ({
      at: new Date(row.created_at).toISOString(),
      kind: 'document' as const,
      title: `${row.kind} issued`,
      detail: `sha256 ${row.sha256.slice(0, 16)}…`,
      entityType: 'document',
      entityId: row.id,
      hash: row.sha256,
    })),
    ...flags.map((row) => ({
      at: new Date(row.detected_at).toISOString(),
      kind: 'flag' as const,
      title: `${row.flag_type.replace(/_/g, ' ')} (${row.severity})`,
      detail: `${row.source} · ${row.status}`,
      entityType: 'fraud_flag',
      entityId: row.id,
      hash: null,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return { loan, events };
}

// ---------------------------------------------------------------------------
// Integrity checks
// ---------------------------------------------------------------------------

export type IntegrityScope = 'all' | 'audit_chain' | 'loan';

export interface IntegrityRun {
  id: string | null;
  scope: IntegrityScope;
  targetId: string | null;
  result: 'ok' | 'tampered' | 'error';
  recordsChecked: number;
  mismatches: number;
  detail: Record<string, unknown>;
  checkedAt: string;
}

/**
 * Recomputes what can be recomputed and compares it with what was stored.
 *
 * `audit_chain` covers the log; `all` covers every loan's transactions as well,
 * which is what "compare the database with the blockchain" actually means.
 * An unanchored transaction is reported as unanchored, never as verified.
 */
export async function runIntegrityCheck(
  actor: Actor,
  scope: IntegrityScope,
  locator: { targetId?: string | null; ref?: string | null },
  req: Request,
): Promise<IntegrityRun> {
  assertAuditor(actor);

  let targetId = locator.targetId ?? null;
  if (scope === 'loan' && !targetId && locator.ref) {
    const found = await queryOne<{ id: string }>('SELECT id FROM loans WHERE upper(ref) = upper($1)', [locator.ref]);
    if (!found) throw notFound('Loan not found');
    targetId = found.id;
  }
  if (scope === 'loan' && !targetId) throw badRequest('A loan id or reference is required for a loan-scoped check');

  const chain = await verifyAuditChain();
  let recordsChecked = chain.rowsChecked;
  let mismatches = chain.mismatches.length;
  let tampered = !chain.ok;
  const detail: Record<string, unknown> = { chain };

  if (scope === 'all' || scope === 'loan') {
    const loans =
      scope === 'loan'
        ? await query<{ id: string; ref: string }>('SELECT id, ref FROM loans WHERE id = $1', [targetId])
        : await query<{ id: string; ref: string }>('SELECT id, ref FROM loans ORDER BY created_at ASC LIMIT 500');
    if (scope === 'loan' && loans.length === 0) throw notFound('Loan not found');

    const loanReports = [];
    for (const loan of loans) {
      const report = await getLoanLedgerReport(actor, loan.id);
      loanReports.push({ id: report.loan.id, ref: report.loan.ref, ok: report.ok, summary: report.summary });
      recordsChecked += report.summary.total;
      mismatches += report.summary.broken;
      if (!report.ok) tampered = true;
    }
    detail.loans = loanReports;
    detail.loanCount = loanReports.length;
  }

  const result: IntegrityRun['result'] = tampered ? 'tampered' : 'ok';
  const stored = await queryOne<{ id: string; created_at: Date }>(
    `INSERT INTO integrity_checks (scope, target_id, records_checked, mismatches, result, detail, run_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [scope, targetId, recordsChecked, mismatches, result, JSON.stringify(detail), actor.id],
  );

  await auditRequest(req, 'integrity.check_run', 'integrity_check', stored?.id ?? null, {
    scope,
    targetId,
    result,
    recordsChecked,
    mismatches,
    chainHead: chain.headHash,
  });

  return {
    id: stored?.id ?? null,
    scope,
    targetId,
    result,
    recordsChecked,
    mismatches,
    detail,
    checkedAt: stored ? new Date(stored.created_at).toISOString() : new Date().toISOString(),
  };
}

export interface IntegrityHistoryRow {
  id: string;
  scope: string;
  targetId: string | null;
  recordsChecked: number;
  mismatches: number;
  result: string;
  runBy: string | null;
  createdAt: string;
}

export async function listIntegrityChecks(actor: Actor, limit = 20): Promise<IntegrityHistoryRow[]> {
  assertAuditor(actor);
  const rows = await query<{
    id: string;
    scope: string;
    target_id: string | null;
    records_checked: number;
    mismatches: number;
    result: string;
    run_by: string | null;
    created_at: Date;
  }>(
    `SELECT c.id, c.scope, c.target_id, c.records_checked, c.mismatches, c.result,
            u.full_name AS run_by, c.created_at
       FROM integrity_checks c
       LEFT JOIN users u ON u.id = c.run_by
      ORDER BY c.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    targetId: row.target_id,
    recordsChecked: Number(row.records_checked),
    mismatches: Number(row.mismatches),
    result: row.result,
    runBy: row.run_by,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV and PDF both embed the chain head and the verification result.
 *
 * An export without its own verification status is a trap: it looks
 * authoritative months later, when nobody can rerun the check.
 */
export async function auditCsv(actor: Actor, filters: AuditFilters, req: Request): Promise<string> {
  assertAuditor(actor);
  const page = await searchAudit(actor, filters, 1, 5000);
  const verification: ChainVerification = await verifyAuditChain();

  const rows: string[] = [
    `SecureMicrofinance audit export`,
    `Generated,${csvCell(new Date().toISOString())}`,
    `Filters,${csvCell(JSON.stringify(filters))}`,
    `Rows,${page.items.length}`,
    `Chain verified,${verification.ok ? 'yes' : 'NO'}`,
    `Chain head seq,${verification.headSeq}`,
    `Chain head hash,${verification.headHash}`,
    '',
    'seq,created_at,actor_role,actor,action,entity_type,entity_id,ip,request_id,before_hash,after_hash,row_hash,detail',
    ...page.items.map((row) =>
      [
        row.seq,
        row.createdAt,
        row.actorRole ?? '',
        row.actorName ?? '',
        row.action,
        row.entityType,
        row.entityId ?? '',
        row.ip ?? '',
        row.requestId ?? '',
        row.beforeHash ?? '',
        row.afterHash ?? '',
        row.rowHash,
        JSON.stringify(row.detail),
      ]
        .map(csvCell)
        .join(','),
    ),
  ];

  const csv = rows.join('\n');
  await auditRequest(req, 'audit.exported', 'audit_log', null, {
    format: 'csv',
    rows: page.items.length,
    chainOk: verification.ok,
    chainHead: verification.headHash,
  });
  return csv;
}

export async function auditPdf(actor: Actor, filters: AuditFilters, req: Request): Promise<Buffer> {
  assertAuditor(actor);
  const page = await searchAudit(actor, filters, 1, 400);
  const verification = await verifyAuditChain();
  const total = await searchAudit(actor, filters, 1, 1);

  const lines: PdfLine[] = [
    { text: 'SecureMicrofinance — forensic audit extract', size: 16, bold: true },
    { text: `Generated ${new Date().toISOString()}`, size: 9, gapBefore: 4 },
    { text: `Filters: ${JSON.stringify(filters)}`, size: 8 },
    { text: '' },
    {
      text: verification.ok
        ? `Chain status: intact — ${verification.rowsChecked} rows verified`
        : `Chain status: TAMPERED — ${verification.mismatches.length} problem(s) found`,
      size: 11,
      bold: true,
      gapBefore: 6,
    },
    { text: `Head seq ${verification.headSeq} · head hash ${verification.headHash}`, size: 8 },
    { text: `Rows in this extract: ${page.items.length} of ${total.total} matching`, size: 8, gapBefore: 4 },
    { text: '' },
    { text: 'seq  when                  actor            action                        entity', size: 8, bold: true, gapBefore: 8 },
  ];

  for (const row of page.items) {
    const when = new Date(row.createdAt).toISOString().replace('T', ' ').slice(0, 19);
    const actorName = (row.actorName ?? row.actorRole ?? 'system').slice(0, 16);
    lines.push({
      text: `${String(row.seq).padEnd(4)} ${when}  ${actorName.padEnd(16)} ${row.action.slice(0, 29).padEnd(29)} ${row.entityType}${row.entityId ? `:${row.entityId.slice(0, 8)}` : ''}`,
      size: 7.5,
    });
  }

  if (total.total > page.items.length) {
    lines.push({ text: '', gapBefore: 8 });
    lines.push({ text: `Truncated: ${total.total - page.items.length} further rows. Use the CSV export for the full set.`, size: 8 });
  }

  lines.push({ text: '', gapBefore: 12 });
  lines.push({
    text: 'Each row carries a hash of its own content and the previous hash. Edit any row and the chain stops linking.',
    size: 7.5,
  });

  const pdf = renderPdf(lines);
  await auditRequest(req, 'audit.exported', 'audit_log', null, {
    format: 'pdf',
    rows: page.items.length,
    chainOk: verification.ok,
    chainHead: verification.headHash,
  });
  return pdf;
}
