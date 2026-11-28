import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, PageHeader, Spinner, TextInput } from '../../components/ui';
import { STAFF_TIER_LABEL, useAuth } from '../../lib/auth';
import { formatDate, formatMoney, percentFromBps } from '../../lib/format';
import { listLoans, RISK_LABEL, RISK_TONE, STATUS_LABEL, STATUS_TONE, type LoanStatus, type LoanSummary } from '../../lib/loans';

const TABS: Array<{ key: LoanStatus | 'all'; label: string }> = [
  { key: 'pending', label: 'New' },
  { key: 'under_review', label: 'Identity Verified' },
  { key: 'supervisor_review', label: 'Supervisor Review' },
  { key: 'manager_review', label: 'Manager Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'held', label: 'Held' },
  { key: 'disbursed', label: 'Disbursed' },
  { key: 'all', label: 'All' },
];

/** Institution-wide staff application queue. */
export function ApplicationsPage() {
  const { user } = useAuth();
  const staffTier = user?.staffTier ?? 'regular';
  const defaultTab: LoanStatus =
    staffTier === 'supervisor'
      ? 'supervisor_review'
      : staffTier === 'finance_manager'
        ? 'manager_review'
        : 'pending';
  const [tab, setTab] = useState<LoanStatus | 'all'>(defaultTab);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loans, setLoans] = useState<LoanSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoans(null);
    setError(null);
    listLoans({
      status: tab === 'all' ? undefined : tab,
      q: query.trim() || undefined,
      page,
      pageSize: 50,
    })
      .then((page) => {
        if (!cancelled) {
          setLoans(page.items);
          setTotal(page.total);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load applications');
      });
    return () => {
      cancelled = true;
    };
  }, [tab, query, page]);

  return (
    <div>
      <PageHeader
        title="Applications"
        subtitle={`Signed in as ${STAFF_TIER_LABEL[staffTier]}. Review applications in your queue and track multi-stage approvals.`}
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Application status">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => {
                setTab(item.key);
                setPage(1);
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                tab === item.key ? 'bg-ink-900 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="w-full sm:w-64">
          <TextInput
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Search reference or purpose"
            aria-label="Search applications"
          />
        </div>
      </div>

      {error ? <EmptyState title="Could not load applications" description={error} /> : null}
      {!loans && !error ? <Spinner label="Loading applications" /> : null}

      {loans && loans.length === 0 ? (
        <EmptyState
          title={tab === 'all' ? 'No institution applications' : 'Nothing in this queue'}
          description={
            tab === 'pending'
              ? 'New applications from borrowers will appear here.'
              : 'Switch tabs to see loans in other states.'
          }
        />
      ) : null}

      {loans && loans.length > 0 ? (
        <div>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Borrower</th>
                  <th className="px-4 py-3 font-semibold">Loan</th>
                  <th className="px-4 py-3 font-semibold">Terms</th>
                  <th className="px-4 py-3 font-semibold">Applied</th>
                  <th className="px-4 py-3 font-semibold">Risk</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loans.map((loan) => (
                  <tr key={loan.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{loan.borrower.fullName}</p>
                      <p className="text-xs text-slate-500">{loan.borrower.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs text-slate-700">{loan.ref}</p>
                      <p className="text-xs text-slate-500">{loan.purpose}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{formatMoney(loan.principalCents)}</p>
                      <p className="text-xs text-slate-500">
                        {percentFromBps(loan.rateBps)} × {loan.termCount} {loan.frequency}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">{formatDate(loan.createdAt)}</td>
                    <td className="px-4 py-3">
                      {loan.score ? (
                        <span className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">{loan.score.score}</span>
                          <Badge tone={loan.score.riskLevel ? RISK_TONE[loan.score.riskLevel] : 'neutral'}>
                            {loan.score.riskLevel ? RISK_LABEL[loan.score.riskLevel] : 'not scored'}
                          </Badge>
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[loan.status]}>{STATUS_LABEL[loan.status]}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/staff/loans/${loan.id}`} className="text-sm font-semibold text-brand-700 hover:underline">
                        Review →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
            <span>
              Showing {(page - 1) * 50 + 1}–{Math.min(page * 50, total)} of {total} applications
            </span>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary" disabled={page === 1} onClick={() => setPage((current) => current - 1)}>
                Previous
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={page * 50 >= total}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
