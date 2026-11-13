import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner, StatCard, TextInput } from '../../components/ui';
import { messageOf } from '../../lib/errors';
import { formatDateTime, shortHash } from '../../lib/format';
import { KIND_TONE, loadTimeline, type Timeline, type TimelineEvent } from '../../lib/audit';

/**
 * Loan timeline (M7).
 *
 * Two sources are merged on purpose. The audit log gives the authoritative
 * order of *actions*; the timeline also shows the transactions, documents and
 * flags those actions refer to, so a reviewer sees the money and the suspicion
 * on the same line. Where the two disagree, the audit row wins -- and the page
 * says so rather than silently sorting one source out.
 */
export function TimelinePage() {
  const [params, setParams] = useSearchParams();
  const loanId = params.get('loanId') ?? undefined;
  const ref = params.get('ref') ?? undefined;

  const [input, setInput] = useState(ref ?? loanId ?? '');
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!loanId && !ref) {
      setTimeline(null);
      return;
    }
    setLoading(true);
    try {
      setTimeline(await loadTimeline({ loanId, ref }));
      setError(null);
    } catch (caught) {
      setTimeline(null);
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, [loanId, ref]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setInput(ref ?? loanId ?? '');
  }, [loanId, ref]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    // A uuid goes in as an id, anything else as a reference.
    const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    setParams(isId ? { loanId: value } : { ref: value });
  }

  const counts = timeline
    ? timeline.events.reduce<Record<string, number>>((totals, event) => {
        totals[event.kind] = (totals[event.kind] ?? 0) + 1;
        return totals;
      }, {})
    : {};

  return (
    <div>
      <PageHeader
        title="Loan timeline"
        subtitle="Everything that happened to one loan, in order: actions from the audit log plus the payments, documents and flags they refer to."
        actions={
          loanId ? (
            <Link className="btn-ghost" to={`/auditor/audit?entityId=${loanId}`}>
              Rows in the log
            </Link>
          ) : null
        }
      />

      <Card title="Find a loan">
        <form className="flex flex-col gap-3 sm:flex-row" onSubmit={submit}>
          <div className="flex-1">
            <label className="label" htmlFor="loan-locator">
              Loan reference or id
            </label>
            <TextInput
              id="loan-locator"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="e.g. SMF-2026-0001"
            />
            <p className="hint">The reference is printed on the agreement and the statement; the id is what the log records.</p>
          </div>
          <div className="flex items-end">
            <button type="submit" className="btn-primary" disabled={loading || input.trim().length === 0}>
              Rebuild
            </button>
          </div>
        </form>
      </Card>

      {error ? (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      {loading ? (
        <div className="mt-5">
          <Spinner label="Merging sources" />
        </div>
      ) : null}

      {!loading && !timeline && !error ? (
        <div className="mt-5">
          <EmptyState
            title="Pick a loan"
            description="Enter a reference, or open a row in the audit log and follow the link from there."
          />
        </div>
      ) : null}

      {timeline ? (
        <>
          <div className="mt-5 grid gap-4 sm:grid-cols-4">
            <StatCard label="Loan" value={timeline.loan.ref} hint={timeline.loan.id} />
            <StatCard label="Events" value={timeline.events.length} hint="all sources merged" />
            <StatCard label="Payments" value={counts.transaction ?? 0} hint="disbursement + repayments" />
            <StatCard label="Flags" value={counts.flag ?? 0} hint="fraud review entries" tone={counts.flag ? 'warning' : 'default'} />
          </div>

          <div className="mt-5">
            <Card title="Chronology">
              {timeline.events.length === 0 ? (
                <EmptyState title="Nothing recorded yet" description="This loan exists but has no history." />
              ) : (
                <ol className="space-y-3">
                  {timeline.events.map((event, index) => (
                    <TimelineRow key={`${event.at}-${event.kind}-${event.entityId ?? index}`} event={event} />
                  ))}
                </ol>
              )}
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  return (
    <li className="flex gap-3 border-l-2 border-slate-200 pl-4">
      <div className="w-40 shrink-0 text-xs text-slate-500">
        <span className="block font-medium text-slate-700">{formatDateTime(event.at)}</span>
        {event.seq !== undefined ? <span className="font-mono">seq {event.seq}</span> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={KIND_TONE[event.kind]}>{event.kind}</Badge>
          <span className="text-sm font-medium text-slate-900">{event.title.replace(/_/g, ' ')}</span>
        </div>
        <p className="mt-0.5 text-sm text-slate-600">{event.detail}</p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-400">
          {event.entityType ?? '—'}
          {event.entityId ? `:${event.entityId.slice(0, 8)}` : ''} · hash {shortHash(event.hash)}
        </p>
      </div>
    </li>
  );
}
