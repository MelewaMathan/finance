import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../../components/AppShell';
import { Alert, Field, TextInput } from '../../components/ui';
import { homeFor, useAuth } from '../../lib/auth';
import { fieldErrors, messageOf } from '../../lib/errors';

/**
 * Registration page.
 *
 * Default (/register):        Borrower-only form.
 * Staff entry (/register?role=staff): adds Staff ID + invite code fields
 *                              and is reachable only via the Staff sign-in view.
 *
 * The backend still enforces the invite-code check regardless of which URL
 * was used, so there is no security reliance on the URL parameter alone.
 */
export function RegisterPage() {
  const { register, status, user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Only 'staff' elevates the form; everything else stays as borrower.
  const isStaffMode = searchParams.get('role') === 'staff';

  const [fullName, setFullName] = useState('');
  const [staffId, setStaffId] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated' && user) {
    return <Navigate to={homeFor(user.role)} replace />;
  }

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
        role: isStaffMode ? 'staff' : 'borrower',
        inviteCode: isStaffMode ? inviteCode || undefined : undefined,
        staffId: isStaffMode ? staffId || undefined : undefined,
      });
      navigate(isStaffMode ? '/enterprise' : '/borrower', { replace: true });
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
          <h1 className="text-xl font-semibold text-slate-900">
            {isStaffMode ? 'Create a staff account' : 'Create an account'}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {isStaffMode
              ? 'You need an invite code from an administrator to register as staff.'
              : 'Apply for loans and track your repayments.'}
          </p>

          <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
            {error ? <Alert>{error}</Alert> : null}

            <Field label="Full name" htmlFor="fullName" error={errors.fullName}>
              <TextInput
                id="fullName"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Jane Wanjiku"
              />
            </Field>

            {isStaffMode ? (
              <>
                <Field
                  label="Staff ID"
                  htmlFor="staffId"
                  error={errors.staffId}
                  hint="Optional — leave blank if not assigned yet."
                >
                  <TextInput
                    id="staffId"
                    value={staffId}
                    onChange={(e) => setStaffId(e.target.value)}
                    placeholder="SMF-STAFF-001"
                  />
                </Field>

                <Field label="Invite code" htmlFor="inviteCode" error={errors.inviteCode}>
                  <TextInput
                    id="inviteCode"
                    required
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
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
                onChange={(e) => setEmail(e.target.value)}
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
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            <Field label="Confirm password" htmlFor="confirm" error={errors.confirm}>
              <TextInput
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>

            <button type="submit" className="btn-brand w-full" disabled={busy}>
              {busy ? 'Creating account…' : isStaffMode ? 'Create staff account' : 'Create account'}
            </button>
          </form>

          <p className="mt-4 text-center text-sm text-slate-500">
            Already registered?{' '}
            <Link
              to={isStaffMode ? '/login?role=staff' : '/login'}
              className="font-semibold text-brand-700 hover:underline"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </AuthLayout>
  );
}
