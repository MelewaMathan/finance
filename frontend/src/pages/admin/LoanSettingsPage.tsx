import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Card, Field, PageHeader, Spinner, TextInput } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { messageOf } from '../../lib/errors';
import {
  getAdminLoanSettings,
  updateAdminLoanSettings,
  type Frequency,
  type InstitutionLoanSettings,
} from '../../lib/loans';

interface FormValues {
  institutionName: string;
  interestPercent: string;
  minAmount: string;
  maxAmount: string;
  maxInstallments: string;
  allowedFrequencies: Frequency[];
}

const FREQUENCIES: Frequency[] = ['daily', 'weekly', 'monthly'];

function toForm(settings: InstitutionLoanSettings): FormValues {
  return {
    institutionName: settings.institutionName,
    interestPercent: (settings.interestRateBps / 100).toFixed(2),
    minAmount: (settings.minPrincipalCents / 100).toString(),
    maxAmount: (settings.maxPrincipalCents / 100).toString(),
    maxInstallments: String(settings.maxInstallments),
    allowedFrequencies: settings.allowedFrequencies,
  };
}

export function LoanSettingsPage() {
  const [values, setValues] = useState<FormValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getAdminLoanSettings()
      .then((settings) => {
        if (active) setValues(toForm(settings));
      })
      .catch((cause: unknown) => {
        if (active) setError(messageOf(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => current ? { ...current, [key]: value } : current);
    setError(null);
    setNotice(null);
  }

  function validate(): InstitutionLoanSettings | null {
    if (!values) return null;
    const rate = Number(values.interestPercent);
    const minAmount = Number(values.minAmount);
    const maxAmount = Number(values.maxAmount);
    const installments = Number(values.maxInstallments);
    if (values.institutionName.trim().length < 2 || values.institutionName.trim().length > 120) {
      setError('Enter an institution name between 2 and 120 characters.');
      return null;
    }
    if (!Number.isFinite(rate) || rate < 0 || rate > 100 || !Number.isInteger(rate * 100)) {
      setError('Interest rate must be between 0 and 100%, with at most two decimal places.');
      return null;
    }
    if (!Number.isFinite(minAmount) || !Number.isFinite(maxAmount) || minAmount <= 0 ||
        maxAmount <= 0 || minAmount > maxAmount) {
      setError('Enter positive loan amounts; the minimum cannot exceed the maximum.');
      return null;
    }
    if (!Number.isInteger(installments) || installments < 1 || installments > 365) {
      setError('Maximum installments must be between 1 and 365.');
      return null;
    }
    if (values.allowedFrequencies.length === 0) {
      setError('Select at least one repayment frequency.');
      return null;
    }
    return {
      institutionName: values.institutionName.trim(),
      interestRateBps: Math.round(rate * 100),
      minPrincipalCents: Math.round(minAmount * 100),
      maxPrincipalCents: Math.round(maxAmount * 100),
      maxInstallments: installments,
      allowedFrequencies: values.allowedFrequencies,
    };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const settings = validate();
    if (!settings) return;
    if (!window.confirm('Save these institution-wide loan settings? New applications will use the updated terms.')) return;

    setSaving(true);
    try {
      const saved = await updateAdminLoanSettings(settings);
      setValues(toForm(saved));
      setNotice('Loan settings saved. The change has been recorded in the audit log.');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : messageOf(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Loan settings"
        subtitle="Manage institution-wide terms used for new applications. Existing loans keep their stored terms."
      />
      {error ? <Alert className="mb-4">{error}</Alert> : null}
      {notice ? <Alert tone="info" className="mb-4">{notice}</Alert> : null}
      {loading ? <Spinner label="Loading loan settings" /> : values ? (
        <Card title="Institution loan terms">
          <form onSubmit={save} className="space-y-5">
            <Field label="Institution name" htmlFor="institutionName">
              <TextInput
                id="institutionName"
                required
                minLength={2}
                maxLength={120}
                value={values.institutionName}
                onChange={(event) => update('institutionName', event.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Interest rate per period (%)" htmlFor="interestPercent">
                <TextInput
                  id="interestPercent"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  required
                  value={values.interestPercent}
                  onChange={(event) => update('interestPercent', event.target.value)}
                />
              </Field>
              <Field label="Maximum installments" htmlFor="maxInstallments">
                <TextInput
                  id="maxInstallments"
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  required
                  value={values.maxInstallments}
                  onChange={(event) => update('maxInstallments', event.target.value)}
                />
              </Field>
              <Field label="Minimum loan amount (Ksh)" htmlFor="minAmount">
                <TextInput
                  id="minAmount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={values.minAmount}
                  onChange={(event) => update('minAmount', event.target.value)}
                />
              </Field>
              <Field label="Maximum loan amount (Ksh)" htmlFor="maxAmount">
                <TextInput
                  id="maxAmount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={values.maxAmount}
                  onChange={(event) => update('maxAmount', event.target.value)}
                />
              </Field>
            </div>
            <fieldset>
              <legend className="label">Allowed repayment frequencies</legend>
              <div className="mt-2 flex flex-wrap gap-4">
                {FREQUENCIES.map((frequency) => (
                  <label key={frequency} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={values.allowedFrequencies.includes(frequency)}
                      onChange={(event) => update(
                        'allowedFrequencies',
                        event.target.checked
                          ? [...values.allowedFrequencies, frequency]
                          : values.allowedFrequencies.filter((item) => item !== frequency),
                      )}
                    />
                    {frequency[0].toUpperCase() + frequency.slice(1)}
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save loan settings'}
            </button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
