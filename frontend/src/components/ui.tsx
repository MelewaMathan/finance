import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

/**
 * Small presentational primitives. Pages compose these instead of repeating
 * Tailwind class strings, which keeps the JSX readable and the UI consistent.
 */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
        {subtitle ? <p className="mt-1 max-w-2xl text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className = '',
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card p-5 ${className}`}>
      {(title || actions) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title ? <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2> : null}
            {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'brand' | 'warning' | 'danger';
}) {
  const tones: Record<string, string> = {
    default: 'text-slate-900',
    brand: 'text-brand-700',
    warning: 'text-amber-600',
    danger: 'text-red-600',
  };
  return (
    <div className="card p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${tones[tone]}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  success: 'bg-emerald-100 text-emerald-800',
  warning: 'bg-amber-100 text-amber-800',
  danger: 'bg-red-100 text-red-800',
  info: 'bg-sky-100 text-sky-800',
};

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge ${BADGE_TONES[tone]}`}>{children}</span>;
}

/** On-chain proof badge: green only when the chain actually verified it. */
export function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <Badge tone="success">
      <ShieldIcon /> Verified on-chain
    </Badge>
  ) : (
    <Badge tone="neutral">Not anchored</Badge>
  );
}

export function Field({
  label,
  error,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <p className="error-text">{error}</p> : hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input className={`input ${className}`} {...rest} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', children, ...rest } = props;
  return (
    <select className={`input ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Alert({ tone = 'danger', children }: { tone?: 'danger' | 'warning' | 'info'; children: ReactNode }) {
  const tones = {
    danger: 'border-red-200 bg-red-50 text-red-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
  };
  return (
    <div role="alert" className={`rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-10 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {description ? <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-slate-500" role="status" aria-live="polite">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
      {label}
    </div>
  );
}

export function FullPageLoader({ label = 'Loading SecureMicrofinance' }: { label?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-4">
        <LogoMark className="h-10 w-10" />
        <Spinner label={label} />
      </div>
    </div>
  );
}

export function ShieldIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 1.5l6.5 2.6v5.2c0 4.2-2.7 7.4-6.5 9.2-3.8-1.8-6.5-5-6.5-9.2V4.1L10 1.5zm3.1 6.7a.9.9 0 10-1.3-1.3L9.2 9.6 8 8.4a.9.9 0 10-1.3 1.3l1.9 1.9a.9.9 0 001.3 0l3.2-3.4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function LogoMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#0f172a" />
      <path d="M16 6.5l7.5 3v6c0 4.8-3.1 8.5-7.5 10.5-4.4-2-7.5-5.7-7.5-10.5v-6l7.5-3z" fill="#10b981" />
      <path d="M16 11v8" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
