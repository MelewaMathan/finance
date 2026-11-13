import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { formatDate, formatMoney, percentFromBps } from '../../lib/format';
import { listLoans, STATUS_LABEL, STATUS_TONE, type LoanSummary } from '../../lib/loans';

/** Borrower view of every application and active loan. */
export function MyLoansPage() {
  const [loans, setLoans] = useState<LoanSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listLoans({ pageSize: 50 })
      .then((page) => {
        if (!cancelled) setLoans(page.items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load your loans');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <PageHeader
        title="My loans"
        subtitle="Every application, its decision, and what is still outstanding."
        actions={
          <Link to="/borrower/apply" className="btn-brand">
            New application
          </Link>
        }
      />

      {error ? <Card title="Error">{error}</Card> : null}

      {!loans && !error ? <Spinner label="Loading your loans" /> : null}

      {loans && loans.length === 0 ? (
        <EmptyState
          title="No applications yet"
          description="Apply for your first loan; your lender will verify your identity before approving."
          action={
            <Link to="/borrower/apply" className="btn-brand">
              Apply for a loan
            </Link>
          }
        />
      ) : null}

      {loans && loans.length > 0 ? (
        <div className="space-y-3">
          {loans.map((loan) => (
            <Link
              key={loan.id}
              to={`/borrower/loans/${loan.id}`}
              className="card block p-5 transition hover:border-brand-300 hover:shadow-md"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-sm font-semibold text-slate-900">{loan.ref}</p>
                    <Badge tone={STATUS_TONE[loan.status]}>{STATUS_LABEL[loan.status]}</Badge>
                    {loan.agreementSha256 ? <Badge tone="info">Agreement sealed</Badge> : null}
                  </div>
                  <p className="mt-1 truncate text-sm text-slate-600">{loan.purpose}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {loan.lender.businessName ?? loan.lender.fullName} · applied {formatDate(loan.createdAt)} ·{' '}
                    {percentFromBps(loan.rateBps)} × {loan.termCount} {loan.frequency}
                  </p>
                </div>
                <div className="shrink-0 text-left sm:text-right">
                  <p className="text-lg font-semibold text-slate-900">{formatMoney(loan.principalCents)}</p>
                  <p className="text-xs text-slate-500">
                    {loan.outstandingCents === null
                      ? `Total ${formatMoney(loan.totalRepayableCents)}`
                      : `Outstanding ${formatMoney(loan.outstandingCents)}`}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
