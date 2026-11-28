import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Card, PageHeader, Spinner } from '../../components/ui';
import { DEFAULT_STAFF_INVITE_CODES, STAFF_TIER_LABEL } from '../../lib/auth';
import type { StaffTier } from '../../lib/api';
import { messageOf } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import {
  decideRequest,
  fetchApprovalHistory,
  fetchPendingRequests,
  fetchStaffAccounts,
  setStaffAccountStatus,
  setStaffAccountTier,
  type ApprovalHistoryRow,
  type PendingRequest,
  type StaffAccount,
} from '../../lib/loginApproval';

type Tab = 'pending' | 'accounts' | 'history' | 'invites';

const STATUS_TONE: Record<string, 'neutral' | 'warning' | 'success' | 'danger' | 'info'> = {
  active: 'success',
  pending: 'warning',
  suspended: 'danger',
  approved: 'success',
  denied: 'danger',
  expired: 'neutral',
  used: 'info',
};

export function AccessRequestsPage() {
  const [tab, setTab] = useState<Tab>('pending');
  const [pendingReqs, setPendingReqs] = useState<PendingRequest[]>([]);
  const [history, setHistory] = useState<ApprovalHistoryRow[]>([]);
  const [staff, setStaff] = useState<StaffAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [denyTarget, setDenyTarget] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [reqs, hist, accounts] = await Promise.all([
        fetchPendingRequests(),
        fetchApprovalHistory(),
        fetchStaffAccounts(),
      ]);
      setPendingReqs(reqs);
      setHistory(hist);
      setStaff(accounts);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function decide(id: string, decision: 'approve' | 'deny', reason?: string) {
    try {
      await decideRequest(id, decision, reason);
      setNotice(`Request ${decision === 'approve' ? 'approved' : 'denied'}.`);
      setDenyTarget(null);
      setDenyReason('');
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function changeAccountStatus(id: string, action: 'approve-account' | 'suspend' | 'reactivate') {
    try {
      await setStaffAccountStatus(id, action);
      setNotice(
        action === 'approve-account'
          ? 'Account activated. The staff member can now log in — their login request will appear in the "Login requests" tab for your final approval.'
          : 'Account updated.',
      );
      if (action === 'approve-account') setTab('pending');
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function changeAccountTier(id: string, tier: StaffTier) {
    try {
      await setStaffAccountTier(id, tier);
      setNotice(`Staff tier updated to ${STAFF_TIER_LABEL[tier]}.`);
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  const pendingCount = pendingReqs.length;
  const pendingStaff = staff.filter((s) => s.status === 'pending').length;

  return (
    <div>
      <PageHeader
        title="Access requests"
        subtitle="Review staff login requests and manage staff account status."
      />

      {error && <Alert className="mb-4">{error}</Alert>}
      {notice && <Alert tone="info" className="mb-4">{notice}</Alert>}

      {/* Tabs */}
      <div className="mb-5 flex gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 w-fit">
        {([
          { key: 'pending', label: 'Login requests', count: pendingCount },
          { key: 'accounts', label: 'Staff accounts', count: pendingStaff },
          { key: 'history', label: 'History' },
          { key: 'invites', label: 'Invite codes', count: DEFAULT_STAFF_INVITE_CODES.length },
        ] as { key: Tab; label: string; count?: number }[]).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white">
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {busy && <Spinner label="Loading" />}

      {/* Pending login requests */}
      {tab === 'pending' && !busy && (
        <Card>
          <div className="mb-4 rounded-xl bg-blue-50 border border-blue-200 p-3.5 text-xs text-blue-900">
            <strong>How the two-step approval works:</strong> Staff members first register (account goes to <em>pending</em> under <strong>Staff accounts</strong>). Once you <strong>approve the account</strong> there, the staff member can log in — their login attempt then appears here as a <em>login request</em> for your final approval before they can access the dashboard.
          </div>
          {pendingReqs.length === 0 ? (
            <p className="text-sm text-slate-500">No pending login requests. If a staff member just registered, go to <strong>Staff accounts</strong> and approve their account first.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {pendingReqs.map((r) => (
                <div key={r.id} className="py-4">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{r.staffName}</p>
                      <p className="text-xs text-slate-500">{r.staffEmail}</p>
                      <p className="mt-1 text-xs text-slate-400">
                        Requested {formatDateTime(r.requestedAt)} · expires {formatDateTime(r.expiresAt)}
                      </p>
                      {r.ipAddress && (
                        <p className="text-xs text-slate-400">IP: {r.ipAddress}</p>
                      )}
                      {r.userAgent && (
                        <p className="truncate max-w-xs text-xs text-slate-400">{r.userAgent}</p>
                      )}
                    </div>

                    {denyTarget === r.id ? (
                      <div className="mt-3 flex flex-col gap-2 sm:mt-0 sm:min-w-[16rem]">
                        <input
                          className="input text-sm"
                          placeholder="Reason for denial (required)"
                          value={denyReason}
                          onChange={(e) => setDenyReason(e.target.value)}
                          autoFocus
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="btn-danger flex-1 text-xs"
                            disabled={!denyReason.trim()}
                            onClick={() => decide(r.id, 'deny', denyReason)}
                          >
                            Confirm deny
                          </button>
                          <button
                            type="button"
                            className="btn-ghost flex-1 text-xs"
                            onClick={() => { setDenyTarget(null); setDenyReason(''); }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 flex gap-2 sm:mt-0">
                        <button
                          type="button"
                          className="btn-brand text-xs"
                          onClick={() => decide(r.id, 'approve')}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn-danger text-xs"
                          onClick={() => setDenyTarget(r.id)}
                        >
                          Deny
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Staff accounts */}
      {tab === 'accounts' && !busy && (
        <Card>
          {staff.length === 0 ? (
            <p className="text-sm text-slate-500">No staff accounts found.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {staff.map((s) => (
                <div key={s.id} className="flex flex-col gap-1 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{s.fullName}</p>
                    <p className="text-xs text-slate-500">{s.email}</p>
                    <p className="mt-1 text-xs text-slate-400">
                      Created {formatDateTime(s.createdAt)}
                      {s.lastLoginAt ? ` · last login ${formatDateTime(s.lastLoginAt)}` : ''}
                    </p>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3 sm:mt-0">
                    <select
                      aria-label={`Staff tier for ${s.fullName}`}
                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700"
                      value={s.staffTier ?? 'regular'}
                      onChange={(e) => void changeAccountTier(s.id, e.target.value as StaffTier)}
                    >
                      <option value="regular">Regular Staff</option>
                      <option value="supervisor">Supervisor</option>
                      <option value="finance_manager">Finance Manager</option>
                    </select>
                    <Badge tone={STATUS_TONE[s.status] ?? 'neutral'}>{s.status}</Badge>
                    {s.status === 'pending' && (
                      <button
                        type="button"
                        className="btn-brand text-xs"
                        onClick={() => changeAccountStatus(s.id, 'approve-account')}
                      >
                        Approve account
                      </button>
                    )}
                    {s.status === 'active' && (
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() => changeAccountStatus(s.id, 'suspend')}
                      >
                        Suspend
                      </button>
                    )}
                    {s.status === 'suspended' && (
                      <button
                        type="button"
                        className="btn-brand text-xs"
                        onClick={() => changeAccountStatus(s.id, 'reactivate')}
                      >
                        Reactivate
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* History */}
      {tab === 'history' && !busy && (
        <Card>
          {history.length === 0 ? (
            <p className="text-sm text-slate-500">No decision history yet.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {history.map((h) => (
                <div key={h.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{h.staff_full_name}</p>
                    <p className="text-xs text-slate-500">{h.staff_email}</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {formatDateTime(h.requested_at)}
                      {h.decided_at ? ` → decided ${formatDateTime(h.decided_at)}` : ''}
                      {h.decided_by_name ? ` by ${h.decided_by_name}` : ''}
                    </p>
                    {h.decision_reason && (
                      <p className="text-xs text-slate-500 italic">"{h.decision_reason}"</p>
                    )}
                  </div>
                  <Badge tone={STATUS_TONE[h.status] ?? 'neutral'}>{h.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Invite Codes */}
      {tab === 'invites' && (
        <Card title="Active Staff Registration Invite Codes">
          <p className="text-sm text-slate-600 mb-4">
            Distribute any of these official invite codes to authorized staff members so they can register at{' '}
            <strong className="text-slate-900 font-mono">/register</strong>. After registration, their account will be
            placed on hold under <span className="font-semibold text-slate-900">Staff accounts</span> until you approve
            it.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            {DEFAULT_STAFF_INVITE_CODES.map((code, index) => (
              <div
                key={code}
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/50 p-3"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
                    {index + 1}
                  </span>
                  <span className="font-mono text-sm font-bold text-slate-800">{code}</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(code);
                    setCopiedCode(code);
                    setTimeout(() => setCopiedCode(null), 2000);
                  }}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  {copiedCode === code ? 'Copied! ✓' : 'Copy'}
                </button>
              </div>
            ))}
          </div>

          <div className="mt-5 rounded-xl bg-amber-50 p-3.5 text-xs text-amber-900 border border-amber-200">
            <strong>Security Notice:</strong> Staff accounts cannot log in immediately after registration. Every new
            staff user must first be reviewed and approved by an administrator under the{' '}
            <em>Staff accounts</em> tab.
          </div>
        </Card>
      )}
    </div>
  );
}
