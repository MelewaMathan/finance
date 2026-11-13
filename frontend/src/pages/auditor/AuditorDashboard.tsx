import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, PageHeader, StatCard } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface HealthPayload {
  status: string;
  service: string;
  chainMode: string;
  time: string;
}

/** Auditor overview: platform state and the evidence they can inspect. */
export function AuditorDashboard() {
  const { user } = useAuth();
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('unhealthy'))))
      .then((data: HealthPayload) => {
        if (!cancelled) setHealth(data);
      })
      .catch(() => {
        if (!cancelled) setUnreachable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!user) return null;

  return (
    <div>
      <PageHeader
        title="Forensic overview"
        subtitle="Read-only access to the immutable audit trail, integrity checks and ledger proofs."
        actions={<Badge tone="info">Read-only role</Badge>}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="API status"
          value={unreachable ? 'Unreachable' : health ? 'Online' : '…'}
          hint={health?.service ?? 'Checking service health'}
          tone={unreachable ? 'danger' : 'brand'}
        />
        <StatCard label="Ledger mode" value={health?.chainMode ?? '—'} hint="local = Hardhat; amoy = testnet" />
        <StatCard label="Audit chain" value="Hash-chained" hint="Append-only with per-row SHA-256" />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Evidence you can rely on">
          <ul className="space-y-3 text-sm text-slate-600">
            <li>A row inserted cannot be updated or deleted: database triggers reject both.</li>
            <li>Each row stores the previous row's hash, so editing history breaks every later hash.</li>
            <li>Disbursements and repayments are anchored on-chain; recomputing the hash proves nothing moved.</li>
            <li>Identity documents exist only as AES-256-GCM ciphertext plus a blind index.</li>
          </ul>
        </Card>

        <Card title="Start an investigation">
          <div className="space-y-3">
            <Link to="/auditor/audit" className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 hover:border-brand-400">
              <span className="text-sm font-medium text-slate-900">Search the audit log</span>
              <span className="text-slate-400">→</span>
            </Link>
            <Link to="/auditor/timeline" className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 hover:border-brand-400">
              <span className="text-sm font-medium text-slate-900">Rebuild a loan timeline</span>
              <span className="text-slate-400">→</span>
            </Link>
            <Link to="/auditor/integrity" className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 hover:border-brand-400">
              <span className="text-sm font-medium text-slate-900">Run an integrity check</span>
              <span className="text-slate-400">→</span>
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
