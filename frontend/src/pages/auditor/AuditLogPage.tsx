import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Badge, Card, EmptyState, PageHeader, Select, Spinner, TextInput } from '../../components/ui';
import { messageOf } from '../../lib/errors';
import { formatDateTime, shortHash } from '../../lib/format';
import {
  actionFamily,
  auditActions,
  exportAudit,
  searchAudit,
  type AuditFilters,
  type AuditPage,
  type AuditRow,
} from '../../lib/audit';

/**
 * Audit log (M7).
 *
 * The log is the primary evidence, so the page shows the raw row rather than a
 * prettified summary: who, what, on which entity, from which IP, under which
 * request id, and the two hashes that make the chain checkable by hand.
 */
const ENTITY_TYPES = ['loan', 'transaction', 'document', 'fraud_flag', 'integrity_check', 'audit_log', 'session', 'user'];

const EMPTY: AuditFilters = {};

const FAMILY_TONE: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  loan: 'info',
  document: 'neutral',
  repayment: 'success',
  fraud: 'danger',
  integrity: 'warning',
  audit: 'warning',
  auth: 'neutral',
  user: 'neutral',
  credit_score: 'info',
  ledger: 'success',
};

export function AuditLogPage() {
  const [params] = useSearchParams();
  // Deep links from the timeline and the integrity page arrive as query params.
  const initial = useMemo<AuditFilters>(() => {
    const fromUrl: AuditFilters = {};
    for (const key of ['q', 'action', 'entityType', 'entityId', 'actorId', 'from', 'to'] as const) {
      const value = params.get(key);
      if (value) fromUrl[key] = value;
    }
    return fromUrl;
  }, [params]);

  const [draft, setDraft] = useState<AuditFilters>(initial);
  const [applied, setApplied] = useState<AuditFilters>(initial);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState<AuditPage | null>(null);
  const [actions, setActions] = useState<Array<{ action: string; count: number }>>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await searchAudit(applied, page, pageSize);
      setData(result);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, [applied, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    auditActions()
      .then(setActions)
      .catch(() => setActions([]));
  }, []);

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, Math.ceil(data.total / data.pageSize));
  }, [data]);

  function apply(next: AuditFilters) {
    setApplied(next);
    setPage(1);
    setExpanded(null);
  }

  function reset() {
    setDraft(EMPTY);
    apply(EMPTY);
  }

  async function runExport(format: 'csv' | 'pdf') {
    setExporting(format);
    setError(null);
    try {
      await exportAudit(format, applied);
      setFlash(`Exported the current filter as ${format.toUpperCase()}. The export is itself in the log.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setExporting(null);
    }
  }

  const filterCount = Object.values(applied).filter(Boolean).length;

  return (
    <div>
      <PageHeader
        title="Audit log"
        subtitle="Append-only, hash-chained record of every action. Nothing here can be edited or deleted, and each row's hash covers the previous one."
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={() => void runExport('csv')} disabled={exporting !== null}>
              {exporting === 'csv' ? 'Exporting…' : 'Export CSV'}
            </button>
            <button type="button" className="btn-ghost" onClick={() => void runExport('pdf')} disabled={exporting !== null}>
              {exporting === 'pdf' ? 'Exporting…' : 'Export PDF'}
            </button>
          </div>
        }
      />

      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      {flash ? (
        <div className="mb-4">
          <Alert tone="info">{flash}</Alert>
        </div>
      ) : null}

      <Card title="Filters">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            apply(draft);
          }}
        >
          <label className="block text-sm">
            <span className="label">Contains</span>
            <TextInput
              value={draft.q ?? ''}
              placeholder="action, entity id, detail text"
              onChange={(event) => setDraft({ ...draft, q: event.target.value || undefined })}
            />
          </label>

          <label className="block text-sm">
            <span className="label">Action</span>
            <Select value={draft.action ?? ''} onChange={(event) => setDraft({ ...draft, action: event.target.value || undefined })}>
              <option value="">Any action</option>
              {actions.map((row) => (
                <option key={row.action} value={row.action}>
                  {row.action} ({row.count})
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm">
            <span className="label">Entity type</span>
            <Select
              value={draft.entityType ?? ''}
              onChange={(event) => setDraft({ ...draft, entityType: event.target.value || undefined })}
            >
              <option value="">Any entity</option>
              {ENTITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm">
            <span className="label">Entity id or loan ref</span>
            <TextInput
              value={draft.entityId ?? ''}
              placeholder="uuid"
              onChange={(event) => setDraft({ ...draft, entityId: event.target.value || undefined })}
            />
          </label>

          <label className="block text-sm">
            <span className="label">From</span>
            <TextInput type="date" value={draft.from ?? ''} onChange={(event) => setDraft({ ...draft, from: event.target.value || undefined })} />
          </label>

          <label className="block text-sm">
            <span className="label">To</span>
            <TextInput type="date" value={draft.to ?? ''} onChange={(event) => setDraft({ ...draft, to: event.target.value || undefined })} />
          </label>

          <label className="block text-sm">
            <span className="label">Rows per page</span>
            <Select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              {[25, 50, 100, 200].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </Select>
          </label>

          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary">
              Search
            </button>
            <button type="button" className="btn-ghost" onClick={reset}>
              Reset
            </button>
          </div>
        </form>
        {filterCount > 0 ? (
          <p className="mt-3 text-xs text-slate-500">
            {filterCount} filter(s) applied. Exports use the filters, not just this page.
          </p>
        ) : null}
      </Card>

      <div className="mt-5">
        <Card
          title={`${data?.total ?? 0} matching row(s)`}
          actions={
            data ? (
              <span className="text-xs text-slate-500">
                page {data.page} of {totalPages}
              </span>
            ) : null
          }
        >
          {loading ? (
            <Spinner label="Reading the chain" />
          ) : !data || data.items.length === 0 ? (
            <EmptyState title="No rows match" description="Widen the filters, or check that activity has happened yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th className="w-16">Seq</th>
                    <th>When</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th className="hidden lg:table-cell">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <RowGroup
                      key={row.seq}
                      row={row}
                      expanded={expanded === row.seq}
                      onToggle={() => setExpanded(expanded === row.seq ? null : row.seq)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between">
            <button type="button" className="btn-ghost" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span className="text-xs text-slate-500">
              Rows {data && data.items.length > 0 ? (data.page - 1) * data.pageSize + 1 : 0}–
              {data ? (data.page - 1) * data.pageSize + data.items.length : 0} of {data?.total ?? 0}
            </span>
            <button
              type="button"
              className="btn-ghost"
              disabled={loading || page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}

/** A row plus, when opened, the hashes and the stored detail payload. */
function RowGroup({ row, expanded, onToggle }: { row: AuditRow; expanded: boolean; onToggle: () => void }) {
  const family = actionFamily(row.action);

  return (
    <>
      <tr className="cursor-pointer align-top" onClick={onToggle}>
        <td className="font-mono text-xs text-slate-500">{row.seq}</td>
        <td className="whitespace-nowrap text-slate-700">{formatDateTime(row.createdAt)}</td>
        <td className="text-slate-700">
          <span className="block">{row.actorName ?? 'system'}</span>
          <span className="text-xs uppercase tracking-wide text-slate-400">{row.actorRole ?? '—'}</span>
        </td>
        <td>
          <Badge tone={FAMILY_TONE[family] ?? 'neutral'}>{family}</Badge>
          <span className="ml-2 font-mono text-xs text-slate-800">{row.action}</span>
        </td>
        <td className="text-slate-600">
          <span className="block text-xs uppercase tracking-wide text-slate-400">{row.entityType}</span>
          {row.entityId ? <span className="font-mono text-xs">{row.entityId}</span> : <span className="text-xs">—</span>}
        </td>
        <td className="hidden text-xs text-slate-500 lg:table-cell">
          <span className="block font-mono">{row.ip ?? '—'}</span>
          <span className="block">req {row.requestId ?? '—'}</span>
        </td>
      </tr>
      {expanded ? (
        <tr className="bg-slate-50/70">
          <td />
          <td colSpan={5} className="py-3">
            <dl className="grid gap-3 text-xs sm:grid-cols-2">
              <div>
                <dt className="font-semibold uppercase tracking-wide text-slate-400">This row's hash</dt>
                <dd className="font-mono break-all text-slate-700">{row.rowHash}</dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-slate-400">Previous row's hash</dt>
                <dd className="font-mono break-all text-slate-700">{row.prevHash}</dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-slate-400">Record hashes</dt>
                <dd className="font-mono text-slate-700">
                  before {shortHash(row.beforeHash)} · after {shortHash(row.afterHash)}
                </dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-slate-400">Detail</dt>
                <dd>
                  <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-white p-2 font-mono text-[11px] text-slate-700">
                    {JSON.stringify(row.detail, null, 2)}
                  </pre>
                </dd>
              </div>
            </dl>
            {row.entityType === 'loan' && row.entityId ? (
              <Link className="mt-3 inline-block text-xs font-medium text-brand-700 hover:underline" to={`/auditor/timeline?loanId=${row.entityId}`}>
                Rebuild this loan's timeline →
              </Link>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
