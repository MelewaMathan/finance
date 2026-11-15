import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../../components/AppShell';
import { Alert, Field, TextInput } from '../../components/ui';
import { homeFor, useAuth } from '../../lib/auth';
import { fieldErrors, messageOf } from '../../lib/errors';

type Role = 'borrower' | 'staff';

export function RegisterPage() {
  const { register, status, user } = useAuth();
  const navigate = useNavigate();
  const [role, setRole] = useState<Role>('borrower');
  const [fullName, setFullName] = useState('');
  const [staffId, setStaffId] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated' && user) return <Navigate to={homeFor(user.role)} replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setErrors({});

    if (password !== confirm) {
      setErrors({ confirm: 'Passwords do not match' });
      return;
    }

    setBusy(true);
    try {
      await register({
        email,
        password,
        fullName,
        role,
        inviteCode: role === 'staff' ? inviteCode || undefined : undefined,
        staffId: role === 'staff' ? staffId || undefined : undefined,
      });
      navigate(role === 'staff' ? '/enterprise' : '/borrower', { replace: true });
    } catch (caught) {
      setError(messageOf(caught));
      setErrors(fieldErrors(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div className="w-full max-w-lg">
        <div className="card p-6 sm:p-8">
          <h1 className="text-xl font-semibold text-slate-900">Create an account</h1>
          <p className="mt-1 text-sm text-slate-500">
            Borrowers apply for loans. Staff review applications and manage repayments.
          </p>

          <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
            {error ? <Alert>{error}</Alert> : null}

            <fieldset>
              <legend className="label">I am a</legend>
              <div className="grid grid-cols-2 gap-3">
                {(['borrower', 'staff'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setRole(option)}
                    aria-pressed={role === option}
                    className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold transition-colors ${
                      role === option
                        ? 'border-brand-600 bg-brand-50 text-brand-800'
                        : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                    }`}
                  >
                    {option === 'borrower' ? 'Borrower' : 'Staff'}
                    <span className="mt-0.5 block text-xs font-normal text-slate-500">
                      {option === 'borrower'
                        ? 'Apply and repay loans'
                        : 'Review applications and manage loans'}
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>

            <Field label="Full name" htmlFor="fullName" error={errors.fullName}>
              <TextInput
                id="fullName"
                required
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                placeholder="Jane Wanjiku"
              />
            </Field>

            {role === 'staff' ? (
              <>
                <Field label="Staff ID" htmlFor="staffId" error={errors.staffId} hint="Optional — leave blank if not assigned yet.">
                  <TextInput
                    id="staffId"
                    value={staffId}
                    onChange={(event) => setStaffId(event.target.value)}
                    placeholder="SMF-STAFF-001"
                  />
                </Field>

                <Field label="Invite code" htmlFor="inviteCode" error={errors.inviteCode}>
                  <TextInput
                    id="inviteCode"
                    required
                    value={inviteCode}
                    onChange={(event) => setInviteCode(event.target.value)}
                    placeholder="Provided by your administrator"
                  />
                </Field>
              </>
            ) : null}

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

            <Field
              label="Password"
              htmlFor="password"
              error={errors.password}
              hint="At least 10 characters, with a letter and a number."
            >
              <TextInput
                id="password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>

            <Field label="Confirm password" htmlFor="confirm" error={errors.confirm}>
              <TextInput
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </Field>

            <button type="submit" className="btn-brand w-full" disabled={busy}>
              {busy ? 'Creating account…' : 'Create account'}
            </button>
          </form>

          <p className="mt-4 text-center text-sm text-slate-500">
            Already registered?{' '}
            <Link to="/login" className="font-semibold text-brand-700 hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </AuthLayout>
  );
}
