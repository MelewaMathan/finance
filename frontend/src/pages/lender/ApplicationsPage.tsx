import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, PageHeader, Spinner, TextInput } from '../../components/ui';
import { formatDate, formatMoney, percentFromBps } from '../../lib/format';
import { listLoans, RISK_LABEL, RISK_TONE, STATUS_LABEL, STATUS_TONE, type LoanStatus, type LoanSummary } from '../../lib/loans';

const TABS: Array<{ key: LoanStatus | 'all'; label: string }> = [
  { key: 'pending', label: 'New' },
  { key: 'under_review', label: 'Verified' },
  { key: 'approved', label: 'Approved' },
  { key: 'held', label: 'Held' },
  { key: 'disbursed', label: 'Disbursed' },
  { key: 'all', label: 'All' },
];

/** Lender application queue, scoped to the signed-in lender's book by the API. */
export function ApplicationsPage() {
  const [tab, setTab] = useState<LoanStatus | 'all'>('pending');
  const [query, setQuery] = useState('');
  const [loans, setLoans] = useState<LoanSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoans(null);
    setError(null);
    listLoans({
      status: tab === 'all' ? undefined : tab,
      q: query.trim() || undefined,
      pageSize: 50,
    })
      .then((page) => {
        if (!cancelled) setLoans(page.items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load applications');
      });
    return () => {
      cancelled = true;
    };
  }, [tab, query]);

  return (
    <div>
      <PageHeader
        title="Applications"
        subtitle="Verify identity, set the final rate, and seal the agreement. Only your own book is shown."
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Application status">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
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
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search reference or purpose"
            aria-label="Search applications"
          />
        </div>
      </div>

      {error ? <EmptyState title="Could not load applications" description={error} /> : null}
      {!loans && !error ? <Spinner label="Loading applications" /> : null}

      {loans && loans.length === 0 ? (
        <EmptyState
          title={tab === 'all' ? 'No loans in your book' : 'Nothing in this queue'}
          description={
            tab === 'pending'
              ? 'New applications from borrowers will appear here.'
              : 'Switch tabs to see loans in other states.'
          }
        />
      ) : null}

      {loans && loans.length > 0 ? (
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
                    <Link to={`/lender/loans/${loan.id}`} className="text-sm font-semibold text-brand-700 hover:underline">
                      Review →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
