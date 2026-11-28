import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, PageHeader, StatCard } from '../../components/ui';
import { STAFF_TIER_LABEL, useAuth } from '../../lib/auth';
import { formatMoney } from '../../lib/format';
import { listLoans } from '../../lib/loans';

/** Institution-wide staff dashboard. */
export function StaffDashboard() {
  const { user } = useAuth();
  const [counts, setCounts] = useState<{ pending: number; held: number; active: number; outstanding: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    listLoans({ pageSize: 100 })
      .then((page) => {
        if (cancelled) return;
        const active = page.items.filter((loan) => loan.status === 'disbursed' || loan.status === 'active');
        setCounts({
          pending: page.items.filter(
            (loan) =>
              loan.status === 'pending' ||
              loan.status === 'under_review' ||
              loan.status === 'supervisor_review' ||
              loan.status === 'manager_review',
          ).length,
          held: page.items.filter((loan) => loan.status === 'held').length,
          active: active.length,
          outstanding: active.reduce((sum, loan) => sum + (loan.outstandingCents ?? 0), 0),
        });
      })
      .catch(() => {
        if (!cancelled) setCounts({ pending: 0, held: 0, active: 0, outstanding: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!user) return null;

  return (
    <div>
      <PageHeader
        title={`Karibu, ${user.fullName.split(' ')[0]}`}
        subtitle={`Signed in as ${STAFF_TIER_LABEL[user.staffTier ?? 'regular']} · 3-tier loan approval security workflow active.`}
        actions={
          <Link to="/staff/applications" className="btn-primary">
            Review applications
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Awaiting decision"
          value={counts ? counts.pending : '—'}
          hint={counts && counts.held > 0 ? `${counts.held} held for fraud review` : 'Institution applications'}
          tone={counts && counts.held > 0 ? 'warning' : 'default'}
        />
        <StatCard label="Active loans" value={counts ? counts.active : '—'} hint={`Outstanding ${formatMoney(counts?.outstanding ?? 0)}`} tone="brand" />
        <StatCard label="Loan terms" value="Institution-wide" hint="Managed by administrators" />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="What the platform does for you">
          <ul className="space-y-3 text-sm text-slate-600">
            <li>Advisory credit score per application, computed from alternative data — you make the final call.</li>
            <li>Digital loan agreement generated with a SHA-256 fingerprint you can re-verify at any time.</li>
            <li>Disbursement and repayment hash written to the Polygon ledger with the transaction reference.</li>
            <li>Fraud queue holds suspicious payments until you clear or confirm them.</li>
          </ul>
        </Card>

        <Card title="Controls you own">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-900">Institution loan terms</p>
                <p className="text-xs text-slate-500">Applications use the current rate and limits set by an administrator.</p>
              </div>
              <Badge tone="info">Shared</Badge>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-900">Fraud review</p>
                <p className="text-xs text-slate-500">High and critical flags block clearing automatically.</p>
              </div>
              <Link to="/staff/fraud" className="text-sm font-semibold text-brand-700 hover:underline">
                Open queue →
              </Link>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-900">Audit visibility</p>
                <p className="text-xs text-slate-500">Every action you take is written to the hash-chained log.</p>
              </div>
              <Badge tone="success">Enforced</Badge>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
