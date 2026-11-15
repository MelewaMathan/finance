import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Card, EmptyState, PageHeader, Select, Spinner, StatCard, TextInput } from '../../components/ui';
import { messageOf } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import {
  flagTypeLabel,
  getFraudSummary,
  listAlerts,
  listFlags,
  markAlertRead,
  resolveFlag,
  resolveHold,
  SEVERITY_TONE,
  STATUS_TONE,
  type AlertItem,
  type FlagSeverity,
  type FlagStatus,
  type FraudFlag,
  type FraudSummary,
} from '../../lib/fraud';

/**
 * Fraud review queue (M6).
 *
 * The page is built around one rule: a flag is a judgement, a hold is money
 * that has not moved. So the card shows both, and the two buttons that matter
 * -- "release" and "reject" -- only appear when a payment is actually parked.
 */
type StatusFilter = FlagStatus | 'all';

const STATUS_TABS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'cleared', label: 'Cleared' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'all', label: 'All' },
];

/** One readable line per flag type, using only the fields that rule stores. */
function detailLines(flag: FraudFlag): string[] {
  const detail = flag.detail ?? {};
  const lines: string[] = [];

  if (flag.flagType === 'duplicate_txn_code' && detail.code) {
    lines.push(`Receipt ${String(detail.code)} already used elsewhere.`);
    if (detail.crossLoan) lines.push('It was used on a different loan: possible double claim.');
  }
  if (flag.flagType === 'malformed_reference') {
    lines.push(`Reference ${String(detail.code ?? '')} — ${String(detail.reason ?? 'failed format checks')}.`);
  }
  if (flag.flagType === 'identity_conflict') {
    const accounts = detail.duplicateAccounts?.length ?? 0;
    lines.push(`Same ${String(detail.field ?? 'identifier')} appears on ${accounts} other account(s).`);
    const masked = detail.duplicateEmailsMasked ?? [];
    if (masked.length > 0) lines.push(`Matches: ${masked.join(', ')}.`);
  }
  if (flag.flagType === 'rapid_applications') {
    lines.push(
      `${String(detail.applicationsInWindow ?? '?')} applications within ${String(detail.windowHours ?? '?')} hours.`,
    );
  }
  if (flag.flagType === 'duplicate_disbursement') {
    lines.push('A disbursement already exists for this loan.');
  }
  if (flag.flagType === 'ml_anomaly') {
    const risk = typeof detail.risk === 'number' ? Math.round(detail.risk * 100) : null;
    if (risk !== null) lines.push(`Model risk ${risk}% (version ${String(detail.modelVersion ?? 'unknown')}).`);
    for (const item of (detail.unusual ?? []).slice(0, 3)) {
      lines.push(`${item.feature.replace(/_/g, ' ')}: ${item.value} vs typical ${item.typical} (${item.deviation}σ).`);
    }
  }

  if (lines.length === 0) lines.push(flag.ruleId ?? 'No extra detail recorded.');
  return lines;
}

export function FraudQueuePage() {
  const [summary, setSummary] = useState<FraudSummary | null>(null);
  const [alerts, setAlerts] = useState<{ items: AlertItem[]; unread: number }>({ items: [], unread: 0 });
  const [flags, setFlags] = useState<FraudFlag[]>([]);
  const [status, setStatus] = useState<StatusFilter>('open');
  const [severity, setSeverity] = useState<FlagSeverity | ''>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSummary, nextFlags, inbox] = await Promise.all([
        getFraudSummary(),
        listFlags({ status, severity: severity || undefined }),
        listAlerts(false),
      ]);
      setSummary(nextSummary);
      setFlags(nextFlags);
      setAlerts({ items: inbox.alerts, unread: inbox.unread });
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, [status, severity]);

  useEffect(() => {
    void load();
  }, [load]);

  const heldCount = useMemo(() => flags.filter((flag) => flag.transactionStatus === 'held').length, [flags]);

  async function run(id: string, action: () => Promise<string>) {
    setBusy(id);
    setError(null);
    try {
      setFlash(await action());
      await load();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  function noteFor(id: string): string {
    return notes[id] ?? '';
  }

  return (
    <div>
      <PageHeader
        title="Fraud review"
        subtitle="Rules and the anomaly model raise flags. A person decides — and money stays parked until they do."
        actions={
          <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        }
      />

      {error ? (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      {flash ? (
        <div className="mb-4">
          <Alert tone="info">{flash}</Alert>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Open flags"
          value={summary ? summary.openFlags : '—'}
          hint={summary ? `${summary.bySeverity.critical} critical · ${summary.bySeverity.high} high` : undefined}
          tone={summary && summary.bySeverity.critical > 0 ? 'danger' : summary && summary.openFlags > 0 ? 'warning' : 'default'}
        />
        <StatCard
          label="Held payments"
          value={summary ? summary.heldMovements : '—'}
          hint="Money not moved until you release it"
          tone={summary && summary.heldMovements > 0 ? 'warning' : 'default'}
        />
        <StatCard label="New in 24h" value={summary ? summary.newLast24h : '—'} hint="Detections from all layers" />
        <StatCard
          label="Flagged by model"
          value={summary ? summary.mlFlags : '—'}
          hint="Isolation Forest, unsupervised"
          tone="brand"
        />
      </div>

      {alerts.unread > 0 ? (
        <div className="mt-5">
          <Card
            title={`Alerts (${alerts.unread} unread)`}
            description="In-app notifications raised when a payment was held."
          >
            <ul className="divide-y divide-slate-100">
              {alerts.items.slice(0, 5).map((alert) => (
                <li key={alert.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={SEVERITY_TONE[alert.severity]}>{alert.severity}</Badge>
                      <p className="text-sm font-medium text-slate-900">{alert.title}</p>
                      {alert.readAt ? <span className="text-xs text-slate-400">read</span> : null}
                    </div>
                    <p className="mt-1 text-sm text-slate-600">{alert.body}</p>
                    <p className="mt-1 text-xs text-slate-400">{formatDateTime(alert.createdAt)}</p>
                  </div>
                  {alert.readAt ? null : (
                    <button
                      type="button"
                      className="text-xs font-semibold text-brand-700 hover:underline"
                      onClick={() =>
                        void run(alert.id, async () => {
                          await markAlertRead(alert.id);
                          return 'Alert marked as read.';
                        })
                      }
                      disabled={busy === alert.id}
                    >
                      Mark read
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setStatus(tab.value)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                status === tab.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="sm:w-52">
          <Select
            aria-label="Filter by severity"
            value={severity}
            onChange={(event) => setSeverity(event.target.value as FlagSeverity | '')}
          >
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
        </div>
      </div>

      <div className="mt-4 space-y-4">
        {loading ? <Spinner label="Loading the queue" /> : null}

        {!loading && flags.length === 0 ? (
          <EmptyState
            title={status === 'open' ? 'Nothing waiting for review' : 'No flags match this filter'}
            description={
              status === 'open'
                ? 'Every detection so far has been reviewed. New flags appear here automatically.'
                : 'Try a different status or severity.'
            }
          />
        ) : null}

        {flags.map((flag) => {
          const heldHere = flag.transactionStatus === 'held';
          const canAct = flag.status === 'open';
          const note = noteFor(flag.id);
          const noteTooShort = note.trim().length < 5;
          const isBusy = busy === flag.id;

          return (
            <Card key={flag.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEVERITY_TONE[flag.severity]}>{flag.severity}</Badge>
                    <Badge tone={STATUS_TONE[flag.status]}>{flag.status}</Badge>
                    <Badge tone={flag.source === 'ml' ? 'info' : 'neutral'}>
                      {flag.source === 'ml' ? 'model' : 'rule'}
                    </Badge>
                    {heldHere ? <Badge tone="warning">money on hold</Badge> : null}
                  </div>
                  <h3 className="mt-2 text-base font-semibold text-slate-900">{flagTypeLabel(flag.flagType)}</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    {flag.borrowerName ?? 'Unknown borrower'}
                    {flag.loanRef ? (
                      <>
                        {' · '}
                        <Link className="font-medium text-brand-700 hover:underline" to={`/enterprise/loans/${flag.loanId}`}>
                          {flag.loanRef}
                        </Link>
                      </>
                    ) : null}
                    <span className="text-slate-400"> · detected {formatDateTime(flag.createdAt)}</span>
                  </p>
                </div>
                <p className="shrink-0 text-xs text-slate-400">{flag.ruleId}</p>
              </div>

              <ul className="mt-3 space-y-1 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
                {detailLines(flag).map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>

              {heldHere ? (
                <p className="mt-3 text-sm text-amber-800">
                  {flag.transactionHoldReason ?? 'The movement is held.'} Nothing has been allocated to the schedule yet.
                </p>
              ) : null}

              {flag.status !== 'open' ? (
                <p className="mt-3 text-sm text-slate-600">
                  <span className="font-medium text-slate-800">
                    {flag.status === 'cleared' ? 'Cleared' : 'Confirmed'}
                  </span>{' '}
                  by {flag.reviewedBy ?? 'a reviewer'} on {formatDateTime(flag.reviewedAt)}
                  {flag.resolutionNote ? ` — “${flag.resolutionNote}”` : ''}
                </p>
              ) : null}

              {canAct ? (
                <div className="mt-4 border-t border-slate-100 pt-4">
                  <TextInput
                    aria-label="Reviewer note"
                    placeholder="Why? (required — this is what an auditor will read)"
                    value={note}
                    onChange={(event) => setNotes((current) => ({ ...current, [flag.id]: event.target.value }))}
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={noteTooShort || isBusy}
                      onClick={() =>
                        void run(flag.id, async () => {
                          await resolveFlag(flag.id, 'cleared', note.trim());
                          return 'Flag cleared. The payment stays held until you release it.';
                        })
                      }
                    >
                      Clear flag
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={noteTooShort || isBusy}
                      onClick={() =>
                        void run(flag.id, async () => {
                          await resolveFlag(flag.id, 'confirmed', note.trim());
                          return 'Flag confirmed as fraud.';
                        })
                      }
                    >
                      Confirm fraud
                    </button>

                    {heldHere && flag.loanId ? (
                      <>
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={noteTooShort || isBusy}
                          onClick={() =>
                            void run(flag.id, async () => {
                              await resolveHold(flag.loanId as string, 'release', note.trim());
                              return 'Money released. The payment is now applied to the schedule.';
                            })
                          }
                        >
                          Release money
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={noteTooShort || isBusy}
                          onClick={() =>
                            void run(flag.id, async () => {
                              await resolveHold(flag.loanId as string, 'reject', note.trim());
                              return 'Movement rejected. The row stays visible as rejected.';
                            })
                          }
                        >
                          Reject movement
                        </button>
                      </>
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    A note of at least 5 characters is required. Clearing a flag does not move money — releasing it does.
                  </p>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      {heldCount > 0 ? (
        <p className="mt-4 text-xs text-slate-500">
          {heldCount} of the flags shown have money parked. Held rows are excluded from the schedule until released.
        </p>
      ) : null}
    </div>
  );
}
