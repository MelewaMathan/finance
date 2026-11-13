import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { homeFor, ROLE_LABEL, useAuth } from '../lib/auth';
import { initials } from '../lib/format';
import { LogoMark } from './ui';

/**
 * Application shell: responsive sidebar on desktop, slide-over menu on
 * mobile. Navigation is derived from the authenticated role, so a borrower
 * never sees lender or auditor destinations (the API enforces the same rule).
 */
type IconName = 'home' | 'file' | 'cash' | 'shield' | 'clock' | 'check' | 'report' | 'user' | 'bell';

const ICON_PATHS: Record<IconName, string> = {
  home: 'M3 10.5L12 3l9 7.5V21a1 1 0 01-1 1h-5v-7H9v7H4a1 1 0 01-1-1v-10.5z',
  file: 'M6 2h7l5 5v15H6V2zm7 1.5V8h4.5',
  cash: 'M2 6h20v12H2V6zm10 2.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z',
  shield: 'M12 2l8 3.2v6.3c0 5.2-3.4 9.2-8 11.5-4.6-2.3-8-6.3-8-11.5V5.2L12 2z',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zm.75 4.5v5.1l3.6 2.1-.75 1.3-4.35-2.55V7.5h1.5z',
  check: 'M9 16.2l-3.5-3.5-1.4 1.4L9 19 20 8l-1.4-1.4z',
  report: 'M5 3h14v18H5V3zm3 4h8v1.5H8V7zm0 4h8v1.5H8V11zm0 4h5v1.5H8V15z',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z',
  bell: 'M12 2a6 6 0 00-6 6v3.6L4 15v2h16v-2l-2-3.4V8a6 6 0 00-6-6zm0 20a2.5 2.5 0 002.45-2h-4.9A2.5 2.5 0 0012 22z',
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="currentColor" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

const NAV_BY_ROLE: Record<'borrower' | 'lender' | 'auditor', NavItem[]> = {
  borrower: [
    { to: '/borrower', label: 'Dashboard', icon: 'home', end: true },
    { to: '/borrower/apply', label: 'Apply for a loan', icon: 'file' },
    { to: '/borrower/loans', label: 'My loans', icon: 'cash' },
    { to: '/profile', label: 'My profile', icon: 'user' },
  ],
  lender: [
    { to: '/lender', label: 'Dashboard', icon: 'home', end: true },
    { to: '/lender/applications', label: 'Applications', icon: 'file' },
    { to: '/lender/fraud', label: 'Fraud queue', icon: 'shield' },
    { to: '/profile', label: 'My profile', icon: 'user' },
  ],
  auditor: [
    { to: '/auditor', label: 'Overview', icon: 'home', end: true },
    { to: '/auditor/audit', label: 'Audit log', icon: 'report' },
    { to: '/auditor/timeline', label: 'Timeline', icon: 'clock' },
    { to: '/auditor/integrity', label: 'Integrity checks', icon: 'check' },
  ],
};

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user, logout } = useAuth();
  if (!user) return null;

  return (
    <div className="flex h-full flex-col">
      <Link to={homeFor(user.role)} className="flex items-center gap-3 px-2 py-1" onClick={onNavigate}>
        <LogoMark className="h-9 w-9" />
        <span>
          <span className="block text-sm font-semibold text-slate-900">SecureMicrofinance</span>
          <span className="block text-xs text-slate-500">Verified lending ledger</span>
        </span>
      </Link>

      <nav className="mt-8 flex-1 space-y-1" aria-label="Main navigation">
        {NAV_BY_ROLE[user.role].map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`}
          >
            <Icon name={item.icon} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink-900 text-xs font-semibold text-white">
            {initials(user.fullName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-900">{user.fullName}</p>
            <p className="truncate text-xs text-slate-500">{ROLE_LABEL[user.role]}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            void logout();
          }}
          className="mt-3 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

export function AppShell() {
  const { user } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-72 border-r border-slate-200 bg-white px-4 py-6 lg:block">
        <SidebarContent />
      </aside>

      {/* Mobile header */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
        <Link to={user ? homeFor(user.role) : '/login'} className="flex items-center gap-2">
          <LogoMark className="h-8 w-8" />
          <span className="text-sm font-semibold">SecureMicrofinance</span>
        </Link>
        <button
          type="button"
          aria-expanded={menuOpen}
          aria-label="Toggle navigation menu"
          onClick={() => setMenuOpen((open) => !open)}
          className="rounded-xl border border-slate-300 p-2 text-slate-700"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
            <path d={menuOpen ? ICON_PATHS.check : 'M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z'} />
          </svg>
        </button>
      </header>

      {/* Mobile drawer */}
      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation menu"
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-72 bg-white px-4 py-6 shadow-xl">
            <SidebarContent onNavigate={() => setMenuOpen(false)} />
          </div>
        </div>
      ) : null}

      <main className="lg:pl-72">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/** Wraps a page in a consistent shell for the auth screens. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="flex items-center gap-3 px-6 py-5">
        <LogoMark className="h-9 w-9" />
        <div>
          <p className="text-sm font-semibold text-slate-900">SecureMicrofinance</p>
          <p className="text-xs text-slate-500">Blockchain-verified microfinance</p>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-12">{children}</main>
      <footer className="px-6 py-4 text-center text-xs text-slate-400">
        Demo deployment · synthetic data only · no real personal information
      </footer>
    </div>
  );
}
