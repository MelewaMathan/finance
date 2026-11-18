import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Card, Field, PageHeader, Spinner, TextInput } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { messageOf } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';

interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  status: 'active' | 'suspended' | string;
  createdAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}

interface AdminListResponse {
  items: AdminUser[];
}

interface CreateAdminResponse {
  userId: string;
  temporaryPassword: string;
  message: string;
}

export function AdminsPage() {
  const { user } = useAuth();
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadAdmins = useCallback(async () => {
    setError(null);
    try {
      const data = await api<AdminListResponse>('/admin/users');
      setAdmins(data.items);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAdmins();
  }, [loadAdmins]);

  async function createAdmin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setTemporaryPassword(null);
    try {
      const result = await api<CreateAdminResponse>('/admin/users', {
        method: 'POST',
        body: { fullName, email },
      });
      setTemporaryPassword(result.temporaryPassword);
      setNotice(`Admin account created for ${email}. Copy the temporary password now; it will not be shown again.`);
      setFullName('');
      setEmail('');
      await loadAdmins();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(admin: AdminUser) {
    const action = admin.status === 'active' ? 'suspend' : 'reactivate';
    setBusy(true);
    setError(null);
    setNotice(null);
    setTemporaryPassword(null);
    try {
      await api(`/admin/users/${encodeURIComponent(admin.id)}/status`, {
        method: 'POST',
        body: { action },
      });
      setNotice(`${admin.fullName} has been ${action === 'suspend' ? 'suspended' : 'reactivated'}.`);
      await loadAdmins();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  const activeAdmins = admins.filter((admin) => admin.status === 'active').length;

  return (
    <div>
      <PageHeader title="Admins" subtitle="Create administrator accounts and manage their access." />
      {error ? <Alert className="mb-4">{error}</Alert> : null}
      {notice ? <Alert tone="info" className="mb-4">{notice}</Alert> : null}
      {temporaryPassword ? (
        <Alert tone="warning" className="mb-4">
          Temporary password: <code className="ml-1 break-all font-mono font-semibold">{temporaryPassword}</code>
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]">
        <Card title="Create an admin" description="The new admin must set a personal password on first sign-in.">
          <form className="space-y-4" onSubmit={createAdmin}>
            <Field label="Full name" htmlFor="adminFullName">
              <TextInput
                id="adminFullName"
                required
                minLength={2}
                maxLength={120}
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                autoComplete="name"
              />
            </Field>
            <Field label="Email address" htmlFor="adminEmail">
              <TextInput
                id="adminEmail"
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
              />
            </Field>
            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? 'Saving…' : 'Create admin'}
            </button>
          </form>
        </Card>

        <Card title="Administrator accounts">
          {loading ? (
            <Spinner label="Loading admins" />
          ) : admins.length === 0 ? (
            <p className="text-sm text-slate-500">No admin accounts found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Admin</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Last sign-in</th>
                    <th className="py-2 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {admins.map((admin) => {
                    const isSelf = admin.id === user?.id;
                    const isLastActive = admin.status === 'active' && activeAdmins <= 1;
                    return (
                      <tr key={admin.id}>
                        <td className="py-3 pr-4">
                          <p className="font-medium text-slate-900">{admin.fullName}</p>
                          <p className="text-xs text-slate-500">{admin.email}</p>
                          {admin.mustChangePassword ? (
                            <p className="mt-1 text-xs text-amber-700">Must set a new password</p>
                          ) : null}
                        </td>
                        <td className="py-3 pr-4">
                          <Badge tone={admin.status === 'active' ? 'success' : 'danger'}>{admin.status}</Badge>
                        </td>
                        <td className="py-3 pr-4 text-slate-600">
                          {admin.lastLoginAt ? formatDateTime(admin.lastLoginAt) : 'Never'}
                        </td>
                        <td className="py-3">
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy || isSelf || isLastActive}
                            title={
                              isSelf
                                ? 'You cannot suspend your own account'
                                : isLastActive
                                  ? 'The last active admin cannot be suspended'
                                  : undefined
                            }
                            onClick={() => void changeStatus(admin)}
                          >
                            {admin.status === 'active' ? 'Suspend' : 'Reactivate'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
