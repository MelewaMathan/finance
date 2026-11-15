import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../../components/AppShell';
import { Alert, Field, Spinner, TextInput } from '../../components/ui';
import { homeFor, useAuth } from '../../lib/auth';
import { fieldErrors, messageOf } from '../../lib/errors';

const SHOW_DEMO = import.meta.env.VITE_SHOW_DEMO_ACCOUNTS === 'true';
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD as string | undefined;

const DEMO_ACCOUNTS = [
  { role: 'Staff', email: 'staff@smf.demo' },
  { role: 'Borrower', email: 'borrower@smf.demo' },
  { role: 'Auditor', email: 'auditor@smf.demo' },
];

export function LoginPage() {
  const { login, status, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated' && user) return <Navigate to={homeFor(user.role)} replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await login(email, password);
      const role = email.includes('staff') ? '/enterprise' : email.includes('auditor') ? '/auditor' : '/borrower';
      navigate(role, { replace: true });
    } catch (caught) {
      setError(messageOf(caught));
      setErrors(fieldErrors(caught));
    } finally {
      setBusy(false);
    }
  }

  function useDemo(demoEmail: string) {
    setEmail(demoEmail);
    setPassword(DEMO_PASSWORD ?? '');
  }

  return (
    <AuthLayout>
      <div className="w-full max-w-md">
        <div className="card p-6 sm:p-8">
          <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500">
            Access the SecureMicrofinance ledger, repayments and audit trail.
          </p>

          <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
            {error ? <Alert>{error}</Alert> : null}

            <Field label="Email address" htmlFor="email" error={errors.email}>
              <TextInput
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </Field>

            <Field label="Password" htmlFor="password" error={errors.password}>
              <TextInput
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••••"
              />
            </Field>

            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? <Spinner label="Signing in" /> : 'Sign in'}
            </button>
          </form>

          <p className="mt-4 text-center text-sm text-slate-500">
            New borrower or staff member?{' '}
            <Link to="/register" className="font-semibold text-brand-700 hover:underline">
              Create an account
            </Link>
          </p>
        </div>

        {SHOW_DEMO && DEMO_PASSWORD ? (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-white/70 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Demo accounts</p>
            <p className="mt-1 text-xs text-slate-500">Password for all: <code className="font-mono">{DEMO_PASSWORD}</code></p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {DEMO_ACCOUNTS.map((account) => (
                <button
                  key={account.email}
                  type="button"
                  onClick={() => useDemo(account.email)}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-xs hover:border-brand-400"
                >
                  <span className="block font-semibold text-slate-800">{account.role}</span>
                  <span className="block truncate text-slate-500">{account.email}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </AuthLayout>
  );
}
