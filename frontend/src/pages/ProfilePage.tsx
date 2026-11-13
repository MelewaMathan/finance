import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Card, Field, PageHeader, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { ROLE_LABEL, useAuth } from '../lib/auth';
import { fieldErrors, messageOf } from '../lib/errors';
import { formatDate, formatMoney, percentFromBps } from '../lib/format';

/**
 * Profile page.
 *
 * Only the borrower has editable PII. Values arrive already masked from the
 * API; saving re-encrypts and re-indexes them server-side.
 */
export function ProfilePage() {
  const { user, profile, refreshProfile } = useAuth();
  const [nationalId, setNationalId] = useState('');
  const [phone, setPhone] = useState('');
  const [occupation, setOccupation] = useState('');
  const [income, setIncome] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setOccupation(profile.occupation ?? '');
    setIncome(profile.monthlyIncomeCents ? String(profile.monthlyIncomeCents / 100) : '');
  }, [profile]);

  if (!user) return null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    setErrors({});

    // Send only what the user actually typed, so existing encrypted values
    // are not overwritten with empty strings.
    const body: Record<string, unknown> = {};
    if (nationalId.trim()) body.nationalId = nationalId.trim();
    if (phone.trim()) body.phone = phone.trim();
    if (occupation.trim()) body.occupation = occupation.trim();
    if (income.trim() && Number.isFinite(Number(income))) body.monthlyIncomeCents = Math.round(Number(income) * 100);
    if (dateOfBirth) body.dateOfBirth = dateOfBirth;
    if (address.trim()) body.address = address.trim();

    if (Object.keys(body).length === 0) {
      setBusy(false);
      setError('Nothing to save yet — fill in at least one field.');
      return;
    }

    try {
      await api('/me/profile', { method: 'PUT', body });
      await refreshProfile();
      setSaved(true);
      setNationalId('');
      setPhone('');
      setAddress('');
      setDateOfBirth('');
    } catch (caught) {
      setError(messageOf(caught));
      setErrors(fieldErrors(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="My profile" subtitle="Keep your details current — lenders rely on them for verification." />

      <div className="grid gap-5 lg:grid-cols-5">
        <Card title="Account" className="lg:col-span-2">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Name</dt>
              <dd className="mt-0.5 text-slate-900">{user.fullName}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Email</dt>
              <dd className="mt-0.5 break-all text-slate-900">{user.email}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Role</dt>
              <dd className="mt-1">
                <Badge tone="info">{ROLE_LABEL[user.role]}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Member since</dt>
              <dd className="mt-0.5 text-slate-900">{formatDate(user.createdAt)}</dd>
            </div>
          </dl>

          <div className="mt-5 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-semibold text-slate-700">Encrypted at rest</p>
            <p className="mt-1">
              National ID and phone number are encrypted with AES-256-GCM. The API only ever returns masked values.
            </p>
          </div>
        </Card>

        <Card title={user.role === 'borrower' ? 'Identity details' : 'Lending profile'} className="lg:col-span-3">
          {user.role === 'borrower' ? (
            <form className="space-y-4" onSubmit={onSubmit} noValidate>
              {error ? <Alert>{error}</Alert> : null}
              {saved ? <Alert tone="info">Profile updated and written to the audit trail.</Alert> : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="National ID"
                  htmlFor="nationalId"
                  error={errors.nationalId}
                  hint={profile?.nationalIdMasked ? `Stored: ${profile.nationalIdMasked}` : 'Not stored yet'}
                >
                  <TextInput
                    id="nationalId"
                    value={nationalId}
                    onChange={(event) => setNationalId(event.target.value)}
                    placeholder="Enter to update"
                    autoComplete="off"
                  />
                </Field>

                <Field
                  label="Phone number"
                  htmlFor="phone"
                  error={errors.phone}
                  hint={profile?.phoneMasked ? `Stored: ${profile.phoneMasked}` : 'Not stored yet'}
                >
                  <TextInput
                    id="phone"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder="0712 345 678"
                    inputMode="tel"
                  />
                </Field>

                <Field label="Occupation" htmlFor="occupation" error={errors.occupation}>
                  <TextInput
                    id="occupation"
                    value={occupation}
                    onChange={(event) => setOccupation(event.target.value)}
                    placeholder="Market trader"
                  />
                </Field>

                <Field label="Monthly income (KES)" htmlFor="income" error={errors.monthlyIncomeCents} hint="Used as alternative data for scoring.">
                  <TextInput
                    id="income"
                    value={income}
                    onChange={(event) => setIncome(event.target.value)}
                    placeholder="35000"
                    inputMode="decimal"
                  />
                </Field>

                <Field label="Date of birth" htmlFor="dob" error={errors.dateOfBirth}>
                  <TextInput
                    id="dob"
                    type="date"
                    value={dateOfBirth}
                    onChange={(event) => setDateOfBirth(event.target.value)}
                  />
                </Field>

                <Field label="Address" htmlFor="address" error={errors.address}>
                  <TextInput
                    id="address"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder="Kawangware, Nairobi"
                  />
                </Field>
              </div>

              <div className="flex justify-end">
                <button type="submit" className="btn-brand" disabled={busy}>
                  {busy ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          ) : (
            <dl className="space-y-3 text-sm">
              {user.role === 'lender' ? (
                <>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Business name</dt>
                    <dd className="mt-0.5 text-slate-900">{profile?.businessName ?? 'Not set'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Default rate per period</dt>
                    <dd className="mt-0.5 text-slate-900">{percentFromBps(profile?.defaultRateBps ?? 0)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Maximum principal</dt>
                    <dd className="mt-0.5 text-slate-900">{formatMoney(profile?.maxPrincipalCents ?? null)}</dd>
                  </div>
                </>
              ) : (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Access level</dt>
                  <dd className="mt-0.5 text-slate-900">Read-only forensic access to audit, fraud and ledger records.</dd>
                </div>
              )}
              <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
                These settings are managed by the platform administrator in this prototype.
              </div>
            </dl>
          )}
        </Card>
      </div>
    </div>
  );
}
