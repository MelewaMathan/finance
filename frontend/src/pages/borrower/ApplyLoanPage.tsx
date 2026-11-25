import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Card, Field, PageHeader, Select, Spinner, TextInput } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { PROFILE_COMPLETENESS_LABELS, useAuth } from '../../lib/auth';
import { formatMoney, percentFromBps } from '../../lib/format';
import { applyLoan, getLoanSettings, type Frequency, type InstitutionLoanSettings } from '../../lib/loans';

/**
 * Loan application form.
 *
 * The borrower chooses the amount, term and structure; institution terms are
 * read-only and loaded from the settings endpoint.
 */
export function ApplyLoanPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [settings, setSettings] = useState<InstitutionLoanSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [principal, setPrincipal] = useState('5000');
  const [termCount, setTermCount] = useState('8');
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [purpose, setPurpose] = useState('');
  const [collateralDesc, setCollateralDesc] = useState('');
  const [guarantorName, setGuarantorName] = useState('');
  const [guarantorPhone, setGuarantorPhone] = useState('');
  const [guarantorCredit, setGuarantorCredit] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLoanSettings()
      .then((current) => {
        if (cancelled) return;
        setSettings(current);
        setFrequency((previous) =>
          current.allowedFrequencies.includes(previous) ? previous : current.allowedFrequencies[0] ?? previous,
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : 'Could not load loan settings');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const missingProfileFields = profile?.completeness?.missing.map(
    (field) => PROFILE_COMPLETENESS_LABELS[field],
  ) ?? [];

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
    if (!settings || !Number.isFinite(principalCents) || principalCents < settings.minPrincipalCents ||
        principalCents > settings.maxPrincipalCents) {
      setError('Enter an amount within the institution loan limits');
      return;
    }

    setSubmitting(true);
    try {
      const loan = await applyLoan({
        principalCents,
        termCount: Number(termCount),
        frequency,
        purpose: purpose.trim(),
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
      <PageHeader
        title="Apply for a loan"
        subtitle="Our staff review every application. Identity data stays encrypted."
      />

      {profile?.completeness && !profile.completeness.complete ? (
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
        <Alert>{loadError}</Alert>
      ) : !settings ? (
        <Spinner label="Loading loan settings" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-3">
          <form className="lg:col-span-2" onSubmit={onSubmit} noValidate>
            <Card title="Loan request">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-700" aria-live="polite">
                  Interest {percentFromBps(settings.interestRateBps)} per period. Loans from Ksh{' '}
                  {(settings.minPrincipalCents / 100).toLocaleString('en-KE')} to Ksh{' '}
                  {(settings.maxPrincipalCents / 100).toLocaleString('en-KE')}.
                </div>

                <Field label="Amount (KES)" htmlFor="principal" hint={`From Ksh ${(settings.minPrincipalCents / 100).toLocaleString('en-KE')} to Ksh ${(settings.maxPrincipalCents / 100).toLocaleString('en-KE')}`}>
                  <TextInput
                    id="principal"
                    type="number"
                    min={settings.minPrincipalCents / 100}
                    max={settings.maxPrincipalCents / 100}
                    step={50}
                    value={principal}
                    onChange={(event) => setPrincipal(event.target.value)}
                    required
                  />
                </Field>

                <Field label="Number of installments" htmlFor="term" hint={`1 to ${settings.maxInstallments} periods`}>
                  <TextInput
                    id="term"
                    type="number"
                    min={1}
                    max={settings.maxInstallments}
                    value={termCount}
                    onChange={(event) => setTermCount(event.target.value)}
                    required
                  />
                </Field>

                <Field label="Repayment frequency" htmlFor="frequency">
                  <Select id="frequency" value={frequency} onChange={(event) => setFrequency(event.target.value as Frequency)}>
                    {settings.allowedFrequencies.map((allowed) => (
                      <option key={allowed} value={allowed}>
                        {allowed[0].toUpperCase() + allowed.slice(1)}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Guarantor credit (optional)" htmlFor="guarantorCredit" hint="0–100, your estimate">
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
                  <Field label="Purpose" htmlFor="purpose" hint="At least 5 characters, visible to institution staff">
                    <TextInput
                      id="purpose"
                      value={purpose}
                      onChange={(event) => setPurpose(event.target.value)}
                      placeholder="Restock my shop for the school season"
                      required
                    />
                  </Field>
                </div>

                <div className="sm:col-span-2">
                  <Field label="Collateral (optional)" htmlFor="collateral" hint="Describe informal security, e.g. shop stock">
                    <TextInput
                      id="collateral"
                      value={collateralDesc}
                      onChange={(event) => setCollateralDesc(event.target.value)}
                      placeholder="Business stock valued at KES 40,000"
                    />
                  </Field>
                </div>

                <Field label="Guarantor name (optional)" htmlFor="guarantor">
                  <TextInput id="guarantor" value={guarantorName} onChange={(event) => setGuarantorName(event.target.value)} />
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
                  {submitting ? 'Submitting…' : 'Submit application'}
                </button>
              </div>
            </Card>
          </form>

          <div className="space-y-5">
            <Card title="Estimate">
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

            <Card title="What happens next">
              <ol className="space-y-3 text-sm text-slate-600">
                <li>1. Our staff verify your identity against the ID on file.</li>
                <li>2. Our staff confirm the final terms and issue an agreement PDF sealed with a SHA-256 fingerprint.</li>
                <li>3. Disbursement and every repayment are hashed and anchored on the ledger.</li>
              </ol>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
