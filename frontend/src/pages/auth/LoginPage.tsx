import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../../components/AppShell';
import { Alert, Field, Spinner, TextInput } from '../../components/ui';
import { homeFor, useAuth } from '../../lib/auth';
import { AwaitingApprovalScreen } from './AwaitingApprovalScreen';
import type { AwaitingApprovalResponse } from '../../lib/loginApproval';

export function LoginPage() {
  const { login, status, user, mustChangePassword } = useAuth();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AwaitingApprovalResponse | null>(null);

  if (searchParams.has('role')) return <Navigate to="/login" replace />;
  if (status === 'authenticated' && user) {
    return <Navigate to={mustChangePassword ? '/set-password' : homeFor(user.role)} replace />;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email, password);
      if (result && 'awaitingApproval' in result) setPending(result);
    } catch {
      setError('Invalid email or password');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div className="w-full max-w-md">
        {pending ? (
          <AwaitingApprovalScreen
            pending={pending}
            onCancel={() => {
              setPending(null);
              setEmail('');
              setPassword('');
            }}
          />
        ) : (
          <div className="card p-6 sm:p-8">
            <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>
            <p className="mt-1 text-sm text-slate-500">Sign in to continue to your SecureMicrofinance account.</p>

            <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
              {error ? <Alert>{error}</Alert> : null}
              <Field label="Email address" htmlFor="email">
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
              <Field label="Password" htmlFor="password">
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
              New here?{' '}
              <Link to="/register" className="font-semibold text-brand-700 hover:underline">
                Create an account
              </Link>
            </p>
          </div>
        )}
      </div>
    </AuthLayout>
  );
}
