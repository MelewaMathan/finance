import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Card, PageHeader, ShieldIcon, StatCard } from '../../components/ui';
import {
  PROFILE_COMPLETENESS_LABELS,
  useAuth,
  type ProfileCompletenessField,
} from '../../lib/auth';
import { formatMoney } from '../../lib/format';
import { listLoans, STATUS_LABEL, STATUS_TONE, type LoanSummary } from '../../lib/loans';

/**
 * Borrower dashboard: identity completeness plus the live state of their
 * loan book.
 */
export function BorrowerDashboard() {
  const { user, profile } = useAuth();
  const [loans, setLoans] = useState<LoanSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listLoans({ pageSize: 50 })
      .then((page) => {
        if (!cancelled) setLoans(page.items);
      })
      .catch(() => {
        if (!cancelled) setLoans([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!user) return null;

  const active = (loans ?? []).filter((loan) => loan.status === 'disbursed' || loan.status === 'active');
  const outstanding = active.reduce((sum, loan) => sum + (loan.outstandingCents ?? 0), 0);
  const awaiting = (loans ?? []).filter((loan) => loan.status === 'pending' || loan.status === 'under_review');

  const checks: Array<{ key: ProfileCompletenessField; label: string }> = [
    { key: 'nationalId', label: 'National ID on file' },
    { key: 'phone', label: 'Phone number on file' },
    { key: 'occupation', label: 'Occupation recorded' },
    { key: 'monthlyIncomeCents', label: 'Monthly income recorded' },
    { key: 'kraPin', label: 'KRA PIN on file' },
  ];
  const completeness = profile?.completeness;
  const completed = completeness?.completed ?? 0;
  const checksWithStatus = checks.map((check) => ({
    ...check,
    done: completeness ? !completeness.missing.includes(check.key) : false,
  }));
  const missingLabels = completeness?.missing.map((field) => PROFILE_COMPLETENESS_LABELS[field]) ?? [];

  return (
    <div>
      <PageHeader
        title={`Karibu, ${user.fullName.split(' ')[0]}`}
        subtitle="Your borrowing record, repayment schedule and blockchain-verified receipts."
        actions={
          <Link to="/borrower/apply" className="btn-brand">
            Apply for a loan
          </Link>
        }
      />

      {completeness && !completeness.complete ? (
        <Alert tone="warning" className="mb-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold">Complete your profile</p>
              <p className="mt-1">
                Add the missing details before applying: {missingLabels.join(', ')}.
              </p>
            </div>
            <Link to="/profile" className="shrink-0 font-semibold underline">
              Update your profile
            </Link>
          </div>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Profile complete" value={`${completed}/${completeness?.total ?? 5}`} hint="Staff verify identity before approving" tone="brand" />
        <StatCard label="Monthly income" value={formatMoney(profile?.monthlyIncomeCents ?? null)} hint="Used as alternative credit data" />
        <StatCard
          label="Outstanding"
          value={formatMoney(outstanding)}
          hint={active.length > 0 ? `${active.length} active loan${active.length === 1 ? '' : 's'}` : 'No active loans'}
        />
      </div>

      {loans && loans.length > 0 ? (
        <div className="mt-5">
          <Card
            title="Recent applications"
            actions={
              <Link to="/borrower/loans" className="text-sm font-semibold text-brand-700 hover:underline">
                View all →
              </Link>
            }
          >
            <ul className="divide-y divide-slate-100">
              {loans.slice(0, 4).map((loan) => (
                <li key={loan.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <Link to={`/borrower/loans/${loan.id}`} className="font-mono text-sm font-semibold text-slate-900 hover:underline">
                      {loan.ref}
                    </Link>
                    <p className="truncate text-xs text-slate-500">{loan.purpose}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {loan.status === 'pending' || loan.status === 'under_review' ? (
                      <span className="text-xs text-slate-500">{awaiting.length} awaiting</span>
                    ) : null}
                    <Badge tone={STATUS_TONE[loan.status]}>{STATUS_LABEL[loan.status]}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Verification checklist" description="Complete these before your first application.">
          <ul className="space-y-3">
            {checksWithStatus.map((check) => (
              <li key={check.label} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-slate-700">{check.label}</span>
                {check.done ? <Badge tone="success">Complete</Badge> : <Badge tone="warning">Missing</Badge>}
              </li>
            ))}
          </ul>
          <Link to="/profile" className="mt-4 inline-block text-sm font-semibold text-brand-700 hover:underline">
            Update your profile →
          </Link>
        </Card>

        <Card title="How your records are protected">
          <ul className="space-y-3 text-sm text-slate-600">
            <li className="flex gap-2">
              <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
              Every repayment is hashed and anchored on a public ledger, so a receipt cannot be quietly altered later.
            </li>
            <li className="flex gap-2">
              <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
              Your ID, phone number and KRA PIN are encrypted in the database; sensitive values are masked.
            </li>
            <li className="flex gap-2">
              <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
              A duplicate payment code or a forged reference is flagged automatically and held for review.
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
