import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthLayout } from '../../components/AppShell';
import { Alert, Field, TextInput } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { messageOf } from '../../lib/errors';

export function SetPasswordPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setBusy(true);
    try {
      await api('/auth/password/force', { method: 'POST', body: { newPassword } });
      await logout();
      navigate('/login', { replace: true });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div className="card w-full max-w-md p-6 sm:p-8">
        <h1 className="text-xl font-semibold text-slate-900">Set a new password</h1>
        <p className="mt-1 text-sm text-slate-500">
          Choose a new password to continue. You will need to sign in again afterward.
        </p>

        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="New password" htmlFor="newPassword" hint="At least 10 characters, with a letter and a number.">
            <TextInput
              id="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          <Field label="Confirm new password" htmlFor="confirmPassword">
            <TextInput
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </Field>
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      </div>
    </AuthLayout>
  );
}
