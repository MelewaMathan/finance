import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../../components/AppShell';
import { Alert, Field, Spinner, TextInput } from '../../components/ui';
import { homeFor, useAuth } from '../../lib/auth';
import { fieldErrors } from '../../lib/errors';
import { AwaitingApprovalScreen } from './AwaitingApprovalScreen';
import type { AwaitingApprovalResponse } from '../../lib/loginApproval';

// ---------------------------------------------------------------------------
// Env-controlled demo panel
// ---------------------------------------------------------------------------
const SHOW_DEMO = import.meta.env.VITE_SHOW_DEMO_ACCOUNTS === 'true';
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD as string | undefined;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type RoleView = 'borrower' | 'staff' | 'admin';

const ROLE_META: Record<RoleView, { heading: string; tagline: string; demoEmail: string }> = {
  borrower: {
    heading: 'Sign in',
    tagline: 'Sign in to apply for loans and track your repayments.',
    demoEmail: 'borrower@smf.demo',
  },
  staff: {
    heading: 'Staff sign in',
    tagline: 'Sign in to review applications and manage repayments.',
    demoEmail: 'staff@smf.demo',
  },
  admin: {
    heading: 'Admin sign in',
    tagline: 'Sign in for read-only forensic access to the audit trail.',
    demoEmail: 'admin@smf.demo',
  },
};

// ---------------------------------------------------------------------------
// Hamburger menu
// ---------------------------------------------------------------------------
export function RoleMenu({ currentRole }: { currentRole: RoleView }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  function go(role: RoleView) {
    setOpen(false);
    navigate(role === 'borrower' ? '/login' : `/login?role=${role}`);
  }

  const items: { role: RoleView; label: string }[] = [
    { role: 'borrower', label: 'Borrower sign in' },
    { role: 'staff', label: 'Staff sign in' },
    { role: 'admin', label: 'Admin sign in' },
  ];

  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/30 bg-white/10 text-white transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor" aria-hidden="true">
          <rect x="2" y="4"  width="16" height="2" rx="1" />
          <rect x="2" y="9"  width="16" height="2" rx="1" />
          <rect x="2" y="14" width="16" height="2" rx="1" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-50 min-w-[13rem] rounded-2xl border border-slate-200 bg-white py-1 shadow-lg"
        >
          {items.map((item) => {
            const active = currentRole === item.role;
            return (
              <button
                key={item.role}
                role="menuitem"
                type="button"
                onClick={() => go(item.role)}
                className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-slate-50 ${
                  active ? 'font-semibold text-brand-700' : 'text-slate-700'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-brand-600' : 'bg-transparent'}`}
                  aria-hidden="true"
                />
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo panel — shows only the account relevant to the current role view
// ---------------------------------------------------------------------------
function DemoPanel({ role, onUse }: { role: RoleView; onUse: (email: string) => void }) {
  if (!SHOW_DEMO || !DEMO_PASSWORD) return null;
  const { demoEmail } = ROLE_META[role];
  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white/70 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Demo account</p>
      <p className="mt-1 text-xs text-slate-500">
        Password: <code className="font-mono">{DEMO_PASSWORD}</code>
      </p>
      <div className="mt-3">
        <button
          type="button"
          onClick={() => onUse(demoEmail)}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-xs hover:border-brand-400"
        >
          <span className="block font-semibold text-slate-800">
            {role.charAt(0).toUpperCase() + role.slice(1)}
          </span>
          <span className="block truncate text-slate-500">{demoEmail}</span>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main login page
// ---------------------------------------------------------------------------
export function LoginPage() {
  const { login, status, user } = useAuth();
  const [searchParams] = useSearchParams();

  const rawRole = searchParams.get('role') ?? 'borrower';
  // Support legacy ?role=auditor links by silently upgrading to admin.
  const normalised = rawRole === 'auditor' ? 'admin' : rawRole;
  const roleView: RoleView = normalised === 'staff' || normalised === 'admin' ? normalised : 'borrower';
  const meta = ROLE_META[roleView];

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AwaitingApprovalResponse | null>(null);

  useEffect(() => {
    setEmail('');
    setPassword('');
    setError(null);
    setErrors({});
    setPending(null);
  }, [roleView]);

  if (status === 'authenticated' && user) {
    return <Navigate to={homeFor(user.role)} replace />;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const result = await login(email, password);
      if (result && 'awaitingApproval' in result) {
        setPending(result as AwaitingApprovalResponse);
        return;
      }
      // Borrower/Admin — Navigate above fires on re-render.
    } catch (caught) {
      setError('Invalid email or password');
      setErrors(fieldErrors(caught));
    } finally {
      setBusy(false);
    }
  }

  function fillDemo(demoEmail: string) {
    setEmail(demoEmail);
    setPassword(DEMO_PASSWORD ?? '');
  }

  return (
    <AuthLayout headerRight={<RoleMenu currentRole={roleView} />}>
      <div className="w-full max-w-md">
        {pending ? (
          <AwaitingApprovalScreen
            pending={pending}
            onCancel={() => { setPending(null); setEmail(''); setPassword(''); }}
          />
        ) : (
          <>
            <div className="card p-6 sm:p-8">
              <h1 className="text-xl font-semibold text-slate-900">{meta.heading}</h1>
              <p className="mt-1 text-sm text-slate-500">{meta.tagline}</p>

              <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
                {error ? <Alert>{error}</Alert> : null}

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

                <Field label="Password" htmlFor="password" error={errors.password}>
                  <TextInput
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••"
                  />
                </Field>

                <button type="submit" className="btn-primary w-full" disabled={busy}>
                  {busy ? <Spinner label="Signing in" /> : 'Sign in'}
                </button>
              </form>

              {roleView === 'borrower' && (
                <p className="mt-4 text-center text-sm text-slate-500">
                  New borrower?{' '}
                  <Link to="/register" className="font-semibold text-brand-700 hover:underline">
                    Create an account
                  </Link>
                </p>
              )}
              {roleView === 'staff' && (
                <p className="mt-4 text-center text-sm text-slate-500">
                  Have an invite code?{' '}
                  <Link to="/register?role=staff" className="font-semibold text-brand-700 hover:underline">
                    Register as staff
                  </Link>
                </p>
              )}
              {roleView === 'admin' && (
                <p className="mt-4 text-center text-sm text-slate-500 italic">
                  Admin accounts are provisioned by an administrator.
                </p>
              )}
            </div>

            <DemoPanel role={roleView} onUse={fillDemo} />
          </>
        )}
      </div>
    </AuthLayout>
  );
}
