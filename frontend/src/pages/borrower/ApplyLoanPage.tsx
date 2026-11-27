import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Badge, Card, Field, PageHeader, Select, Spinner, TextInput } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { PROFILE_COMPLETENESS_LABELS, useAuth } from '../../lib/auth';
import { formatMoney, percentFromBps } from '../../lib/format';
import { applyLoan, getLoanSettings, type Frequency, type InstitutionLoanSettings } from '../../lib/loans';

export interface LoanProductConfig {
  slug: 'emergency' | 'short-term' | 'long-term';
  name: string;
  badge: string;
  badgeTone: 'warning' | 'info' | 'success';
  icon: string;
  tagline: string;
  description: string;
  typicalRange: string;
  defaultPrincipal: number;
  minPrincipal: number;
  maxPrincipal: number;
  defaultTerm: number;
  maxTerm: number;
  defaultFrequency: Frequency;
  allowedFrequencies: Frequency[];
  purposePlaceholder: string;
  purposeHint: string;
  features: string[];
}

export const LOAN_PRODUCTS: Record<string, LoanProductConfig> = {
  emergency: {
    slug: 'emergency',
    name: 'Emergency Loan',
    badge: 'Express 24h Review',
    badgeTone: 'warning',
    icon: '⚡',
    tagline: 'Urgent financial relief for unexpected emergencies & medical needs',
    description:
      'Fast-track financing designed for urgent unforeseen expenses including medical bills, family emergencies, or critical equipment repairs.',
    typicalRange: 'KES 1,000 – KES 15,000',
    defaultPrincipal: 5000,
    minPrincipal: 1000,
    maxPrincipal: 20000,
    defaultTerm: 4,
    maxTerm: 6,
    defaultFrequency: 'weekly',
    allowedFrequencies: ['daily', 'weekly'],
    purposePlaceholder: 'e.g. Urgent prescription medication and hospital admission deposit',
    purposeHint: 'Detail the emergency clearly to expedite verification review',
    features: [
      'Fast-track review priority',
      'Flexible short-duration repayment (daily or weekly)',
      'No physical collateral strictly required',
      'Instant blockchain hash verification',
    ],
  },
  'short-term': {
    slug: 'short-term',
    name: 'Short-Term Loan',
    badge: 'Working Capital',
    badgeTone: 'info',
    icon: '💼',
    tagline: 'Working capital to restock business inventory & manage cash flow',
    description:
      'Flexible credit tailored for market traders, retail shops, and small businesses needing quick inventory turnover and operating liquidity.',
    typicalRange: 'KES 5,000 – KES 50,000',
    defaultPrincipal: 20000,
    minPrincipal: 5000,
    maxPrincipal: 50000,
    defaultTerm: 8,
    maxTerm: 12,
    defaultFrequency: 'weekly',
    allowedFrequencies: ['weekly', 'monthly'],
    purposePlaceholder: 'e.g. Restock fast-moving wholesale retail goods for upcoming market days',
    purposeHint: 'Describe the inventory or business operational purpose',
    features: [
      'Tailored for merchants and seasonal business stock',
      'Flexible weekly or monthly installments',
      'Informal business collateral accepted',
      'Builds verified repayment score on-chain',
    ],
  },
  'long-term': {
    slug: 'long-term',
    name: 'Long-Term Loan',
    badge: 'Asset & Growth',
    badgeTone: 'success',
    icon: '🚀',
    tagline: 'Capital expansion for business equipment & development investments',
    description:
      'Substantial funding for capital asset acquisition, commercial premise renovations, farm machinery, or multi-month growth projects.',
    typicalRange: 'KES 20,000 – KES 150,000',
    defaultPrincipal: 60000,
    minPrincipal: 20000,
    maxPrincipal: 150000,
    defaultTerm: 12,
    maxTerm: 24,
    defaultFrequency: 'monthly',
    allowedFrequencies: ['monthly', 'weekly'],
    purposePlaceholder: 'e.g. Purchase commercial display refrigerator and expand retail store space',
    purposeHint: 'Detail the equipment or long-term growth plan',
    features: [
      'Higher borrowing limits for growth investments',
      'Extended repayment schedules up to 24 installments',
      'Guarantor and structured asset backing options',
      'Transparent flat rates with blockchain-anchored contracts',
    ],
  },
};

/**
 * Loan application portal:
 * - Hub (/borrower/apply): Card selector for Emergency, Short-Term, and Long-Term loans.
 * - Form (/borrower/apply/:loanType): Dedicated application page for the selected product.
 */
export function ApplyLoanPage() {
  const { loanType } = useParams<{ loanType?: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();

  const [settings, setSettings] = useState<InstitutionLoanSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLoanSettings()
      .then((current) => {
        if (!cancelled) setSettings(current);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : 'Could not load loan settings');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const missingProfileFields =
    profile?.completeness?.missing.map((field) => PROFILE_COMPLETENESS_LABELS[field]) ?? [];

  const product = loanType ? LOAN_PRODUCTS[loanType] : undefined;

  // If no loan type or an unknown loan type is given, show the product selector page.
  if (!product) {
    return (
      <div>
        <PageHeader
          title="Apply for a loan"
          subtitle="Select a loan product below to open its application form. Terms are tailored to your financing needs."
        />

        {profile?.completeness && !profile.completeness.complete ? (
          <Alert tone="warning" className="mb-6">
            <div>
              <p className="font-semibold">Complete your profile before applying for a loan.</p>
              <p className="mt-1">Missing: {missingProfileFields.join(', ')}.</p>
              <Link to="/profile" className="mt-2 inline-block font-semibold underline">
                Update your profile
              </Link>
            </div>
          </Alert>
        ) : null}

        {loadError ? (
          <Alert className="mb-6">{loadError}</Alert>
        ) : !settings ? (
          <Spinner label="Loading loan terms" />
        ) : (
          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              <span className="font-semibold text-slate-900">Institution Interest Rate:</span>{' '}
              {percentFromBps(settings.interestRateBps)} per period • Allowed loan amounts from Ksh{' '}
              {(settings.minPrincipalCents / 100).toLocaleString('en-KE')} to Ksh{' '}
              {(settings.maxPrincipalCents / 100).toLocaleString('en-KE')}.
            </div>

            <div className="grid gap-6 md:grid-cols-3">
              {(Object.values(LOAN_PRODUCTS) as LoanProductConfig[]).map((item) => (
                <div
                  key={item.slug}
                  className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-brand-500 hover:shadow-md"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-3xl">{item.icon}</span>
                      <Badge tone={item.badgeTone}>{item.badge}</Badge>
                    </div>

                    <h2 className="mt-4 text-lg font-bold text-slate-900">{item.name}</h2>
                    <p className="mt-1 text-xs font-medium text-brand-700">{item.typicalRange}</p>
                    <p className="mt-3 text-sm text-slate-600">{item.description}</p>

                    <div className="mt-5 space-y-2 border-t border-slate-100 pt-4 text-xs text-slate-600">
                      {item.features.map((feature) => (
                        <div key={feature} className="flex items-start gap-2">
                          <span className="text-emerald-600 font-bold">✓</span>
                          <span>{feature}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-6 pt-4 border-t border-slate-100">
                    <Link
                      to={`/borrower/apply/${item.slug}`}
                      className="btn-brand block w-full text-center py-2.5 text-sm"
                    >
                      Apply for {item.name} →
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Render the dedicated application form for the chosen loan product
  return (
    <LoanApplicationForm
      product={product}
      settings={settings}
      loadError={loadError}
      missingProfileFields={missingProfileFields}
      onNavigateBack={() => navigate('/borrower/apply')}
    />
  );
}

function LoanApplicationForm({
  product,
  settings,
  loadError,
  missingProfileFields,
  onNavigateBack,
}: {
  product: LoanProductConfig;
  settings: InstitutionLoanSettings | null;
  loadError: string | null;
  missingProfileFields: string[];
  onNavigateBack: () => void;
}) {
  const navigate = useNavigate();

  // Derived limits constrained by both product template and institution config
  const minPrincipal = settings
    ? Math.max(product.minPrincipal, Math.round(settings.minPrincipalCents / 100))
    : product.minPrincipal;
  const maxPrincipal = settings
    ? Math.min(product.maxPrincipal, Math.round(settings.maxPrincipalCents / 100))
    : product.maxPrincipal;
  const maxInstallments = settings
    ? Math.min(product.maxTerm, settings.maxInstallments)
    : product.maxTerm;

  // Available frequencies: intersection of product's allowed frequencies and institution settings
  const availableFrequencies = useMemo(() => {
    if (!settings) return product.allowedFrequencies;
    const common = product.allowedFrequencies.filter((f) => settings.allowedFrequencies.includes(f));
    return common.length > 0 ? common : settings.allowedFrequencies;
  }, [product, settings]);

  const [principal, setPrincipal] = useState(String(product.defaultPrincipal));
  const [termCount, setTermCount] = useState(String(product.defaultTerm));
  const [frequency, setFrequency] = useState<Frequency>(
    availableFrequencies.includes(product.defaultFrequency)
      ? product.defaultFrequency
      : availableFrequencies[0] ?? 'weekly',
  );
  const [purpose, setPurpose] = useState('');
  const [collateralDesc, setCollateralDesc] = useState('');
  const [guarantorName, setGuarantorName] = useState('');
  const [guarantorPhone, setGuarantorPhone] = useState('');
  const [guarantorCredit, setGuarantorCredit] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync frequency if available frequencies change after settings load
  useEffect(() => {
    if (!availableFrequencies.includes(frequency) && availableFrequencies.length > 0) {
      setFrequency(availableFrequencies[0]);
    }
  }, [availableFrequencies, frequency]);

  const estimate = useMemo(() => {
    const principalCents = Math.round(Number(principal || '0') * 100);
    const periods = Number(termCount || '0');
    if (!settings || !Number.isFinite(principalCents) || principalCents <= 0 || periods <= 0) return null;
    const interest = Math.round((principalCents * settings.interestRateBps * periods) / 10_000);
    return { principalCents, interestCents: interest, totalCents: principalCents + interest };
  }, [principal, termCount, settings]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const principalCents = Math.round(Number(principal) * 100);
    if (
      !settings ||
      !Number.isFinite(principalCents) ||
      principalCents < settings.minPrincipalCents ||
      principalCents > settings.maxPrincipalCents
    ) {
      setError(
        `Enter an amount between Ksh ${(settings?.minPrincipalCents ?? 0) / 100} and Ksh ${(settings?.maxPrincipalCents ?? 0) / 100}`,
      );
      return;
    }

    if (Number(termCount) > (settings?.maxInstallments ?? 365) || Number(termCount) < 1) {
      setError(`Installments must be between 1 and ${settings?.maxInstallments ?? 365}`);
      return;
    }

    setSubmitting(true);
    try {
      const loan = await applyLoan({
        principalCents,
        termCount: Number(termCount),
        frequency,
        purpose: `[${product.name}] ${purpose.trim()}`,
        collateralDesc: collateralDesc.trim() || undefined,
        guarantorName: guarantorName.trim() || undefined,
        guarantorPhone: guarantorPhone.trim() || undefined,
        guarantorCredit: guarantorCredit ? Number(guarantorCredit) : undefined,
      });
      navigate(`/borrower/loans/${loan.id}`, { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not submit the application');
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="mb-4">
        <button
          type="button"
          onClick={onNavigateBack}
          className="inline-flex items-center text-sm font-semibold text-brand-700 hover:text-brand-900"
        >
          ← Back to loan products
        </button>
      </div>

      <PageHeader
        title={`${product.name} Application`}
        subtitle={product.tagline}
        actions={<Badge tone={product.badgeTone}>{product.badge}</Badge>}
      />

      {missingProfileFields.length > 0 ? (
        <Alert tone="warning" className="mb-5">
          <div>
            <p className="font-semibold">Complete your profile before applying for a loan.</p>
            <p className="mt-1">Missing: {missingProfileFields.join(', ')}.</p>
            <Link to="/profile" className="mt-2 inline-block font-semibold underline">
              Update your profile
            </Link>
          </div>
        </Alert>
      ) : null}

      {loadError ? (
        <Alert className="mb-5">{loadError}</Alert>
      ) : !settings ? (
        <Spinner label="Loading loan settings" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-3">
          <form className="lg:col-span-2" onSubmit={onSubmit} noValidate>
            <Card title={`${product.name} Details`}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-700" aria-live="polite">
                  Flat interest rate of {percentFromBps(settings.interestRateBps)} per period. Recommended amount for{' '}
                  {product.name}: Ksh {minPrincipal.toLocaleString('en-KE')} to Ksh{' '}
                  {maxPrincipal.toLocaleString('en-KE')}.
                </div>

                <Field
                  label="Amount (KES)"
                  htmlFor="principal"
                  hint={`Ksh ${minPrincipal.toLocaleString('en-KE')} to Ksh ${maxPrincipal.toLocaleString('en-KE')}`}
                >
                  <TextInput
                    id="principal"
                    type="number"
                    min={minPrincipal}
                    max={maxPrincipal}
                    step={50}
                    value={principal}
                    onChange={(event) => setPrincipal(event.target.value)}
                    required
                  />
                </Field>

                <Field
                  label="Number of installments"
                  htmlFor="term"
                  hint={`1 to ${maxInstallments} periods`}
                >
                  <TextInput
                    id="term"
                    type="number"
                    min={1}
                    max={maxInstallments}
                    value={termCount}
                    onChange={(event) => setTermCount(event.target.value)}
                    required
                  />
                </Field>

                <Field label="Repayment frequency" htmlFor="frequency">
                  <Select
                    id="frequency"
                    value={frequency}
                    onChange={(event) => setFrequency(event.target.value as Frequency)}
                  >
                    {availableFrequencies.map((allowed) => (
                      <option key={allowed} value={allowed}>
                        {allowed[0].toUpperCase() + allowed.slice(1)}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Guarantor credit (optional)" htmlFor="guarantorCredit" hint="0–100, estimate if known">
                  <TextInput
                    id="guarantorCredit"
                    type="number"
                    min={0}
                    max={100}
                    value={guarantorCredit}
                    onChange={(event) => setGuarantorCredit(event.target.value)}
                  />
                </Field>

                <div className="sm:col-span-2">
                  <Field label="Purpose of loan" htmlFor="purpose" hint={product.purposeHint}>
                    <TextInput
                      id="purpose"
                      value={purpose}
                      onChange={(event) => setPurpose(event.target.value)}
                      placeholder={product.purposePlaceholder}
                      required
                    />
                  </Field>
                </div>

                <div className="sm:col-span-2">
                  <Field
                    label="Collateral (optional)"
                    htmlFor="collateral"
                    hint="Describe informal security, e.g. shop merchandise or equipment"
                  >
                    <TextInput
                      id="collateral"
                      value={collateralDesc}
                      onChange={(event) => setCollateralDesc(event.target.value)}
                      placeholder="e.g. Business stock or equipment valued at KES 50,000"
                    />
                  </Field>
                </div>

                <Field label="Guarantor name (optional)" htmlFor="guarantor">
                  <TextInput
                    id="guarantor"
                    value={guarantorName}
                    onChange={(event) => setGuarantorName(event.target.value)}
                  />
                </Field>

                <Field label="Guarantor phone (optional)" htmlFor="guarantorPhone" hint="Stored encrypted">
                  <TextInput
                    id="guarantorPhone"
                    inputMode="tel"
                    value={guarantorPhone}
                    onChange={(event) => setGuarantorPhone(event.target.value)}
                    placeholder="0712 345 678"
                  />
                </Field>
              </div>

              {error ? (
                <div className="mt-4">
                  <Alert>{error}</Alert>
                </div>
              ) : null}

              <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-slate-500">
                  Guarantor details are encrypted at rest. Your national ID and phone are already on file and shown
                  masked to our staff.
                </p>
                <button type="submit" className="btn-brand" disabled={submitting}>
                  {submitting ? 'Submitting…' : `Submit ${product.name} application`}
                </button>
              </div>
            </Card>
          </form>

          <div className="space-y-5">
            <Card title="Loan Estimate">
              {estimate ? (
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Principal</dt>
                    <dd className="font-medium">{formatMoney(estimate.principalCents)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">
                      Interest ({percentFromBps(settings.interestRateBps)} × {termCount})
                    </dt>
                    <dd className="font-medium">{formatMoney(estimate.interestCents)}</dd>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-3">
                    <dt className="font-semibold text-slate-700">Total repayable</dt>
                    <dd className="font-semibold text-brand-700">{formatMoney(estimate.totalCents)}</dd>
                  </div>
                  <div className="flex justify-between text-xs text-slate-500">
                    <dt>Per {frequency.replace('ly', '')} installment</dt>
                    <dd>{formatMoney(Math.round(estimate.totalCents / Math.max(1, Number(termCount))))}</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-sm text-slate-500">Enter an amount and term to see the estimate.</p>
              )}
              <p className="mt-4 text-xs text-slate-400">
                Our staff confirm the final terms when approving.
              </p>
            </Card>

            <Card title={`${product.name} Highlights`}>
              <ul className="space-y-2 text-xs text-slate-600">
                {product.features.map((item) => (
                  <li key={item} className="flex items-start gap-2">
                    <span className="text-emerald-600 font-bold">✓</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="What happens next">
              <ol className="space-y-3 text-sm text-slate-600">
                <li>1. Staff verify your identity against the ID on file.</li>
                <li>2. Staff confirm final terms and issue an agreement PDF sealed with SHA-256 fingerprint.</li>
                <li>3. Disbursement and every repayment are hashed and anchored on the ledger.</li>
              </ol>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
