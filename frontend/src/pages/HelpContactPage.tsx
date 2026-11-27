import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Card, Field, PageHeader, TextInput } from '../components/ui';
import { useAuth } from '../lib/auth';

interface TicketSummary {
  ticketNumber: string;
  category: string;
  createdAt: string;
}

export function HelpContactPage() {
  const { user } = useAuth();

  const [name, setName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [category, setCategory] = useState('loan_application');
  const [loanRef, setLoanRef] = useState('');
  const [message, setMessage] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submittedTicket, setSubmittedTicket] = useState<TicketSummary | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!message.trim()) return;

    setSubmitting(true);
    // Simulate support ticket creation
    setTimeout(() => {
      const randomId = Math.floor(100000 + Math.random() * 900000);
      setSubmittedTicket({
        ticketNumber: `SMF-SUP-${randomId}`,
        category,
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
      setMessage('');
      setLoanRef('');
      setSubmitting(false);
    }, 600);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Help & Customer Support"
        subtitle="Need assistance with an application, M-Pesa repayment, or account verification? Our team is here to assist."
      />

      {/* Quick Contact Cards */}
      <div className="grid gap-5 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-xl text-brand-700">
            📞
          </div>
          <h2 className="mt-3 text-base font-semibold text-slate-900">Phone Support</h2>
          <p className="mt-1 text-xs text-slate-500">Mon – Fri: 8:00 AM – 5:00 PM EAT</p>
          <div className="mt-3 space-y-1 text-sm font-medium text-slate-800">
            <p>
              <a href="tel:+254700123456" className="text-brand-700 hover:underline">
                +254 700 123 456
              </a>
            </p>
            <p>
              <a href="tel:+254722987654" className="text-brand-700 hover:underline">
                +254 722 987 654
              </a>
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-xl text-sky-700">
            ✉️
          </div>
          <h2 className="mt-3 text-base font-semibold text-slate-900">Email Desk</h2>
          <p className="mt-1 text-xs text-slate-500">Average response time: &lt; 2 hours</p>
          <div className="mt-3 space-y-1 text-sm font-medium">
            <p>
              <a href="mailto:support@securemicrofinance.co.ke" className="text-brand-700 hover:underline">
                support@securemicrofinance.co.ke
              </a>
            </p>
            <p className="text-xs text-slate-500">Inquiries, loans & repayments</p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50 text-xl text-red-600">
            🛡️
          </div>
          <h2 className="mt-3 text-base font-semibold text-slate-900">Fraud & Security Desk</h2>
          <p className="mt-1 text-xs text-slate-500">24/7 Urgent assistance line</p>
          <div className="mt-3 space-y-1 text-sm font-medium">
            <p>
              <a href="tel:+254711999888" className="text-red-700 hover:underline">
                +254 711 999 888
              </a>
            </p>
            <p>
              <a href="mailto:fraud-desk@securemicrofinance.co.ke" className="text-xs text-red-600 hover:underline">
                fraud-desk@securemicrofinance.co.ke
              </a>
            </p>
          </div>
        </div>
      </div>

      {/* Main Form and Instructions Layout */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Contact Form */}
        <div className="lg:col-span-2">
          <Card title="Submit an Inquiry or Request">
            {submittedTicket ? (
              <div className="my-2 rounded-2xl bg-emerald-50 p-5 text-emerald-900 border border-emerald-200">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">✅</span>
                  <div>
                    <h3 className="text-base font-bold text-emerald-950">Inquiry Submitted Successfully</h3>
                    <p className="text-xs text-emerald-800">
                      Ticket Reference: <strong className="font-mono">{submittedTicket.ticketNumber}</strong>
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-sm text-emerald-800">
                  Our customer support team has received your ticket and will follow up with you directly via email
                  shortly.
                </p>
                <button
                  type="button"
                  onClick={() => setSubmittedTicket(null)}
                  className="mt-4 rounded-xl bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800"
                >
                  Submit another message
                </button>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Your Name" htmlFor="name">
                    <TextInput
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Jane Doe"
                      required
                    />
                  </Field>
                  <Field label="Email Address" htmlFor="email">
                    <TextInput
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="e.g. jane@example.com"
                      required
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="category" className="field-label">
                      Inquiry Category
                    </label>
                    <select
                      id="category"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      className="field-input"
                    >
                      <option value="loan_application">Loan Application Status</option>
                      <option value="repayment">Repayments & M-Pesa Confirmation</option>
                      <option value="profile_kyc">Profile & KRA PIN Verification</option>
                      <option value="fraud_alert">Suspicious Activity / Fraud Alert</option>
                      <option value="login_access">Login & Account Access</option>
                      <option value="other">General Inquiry</option>
                    </select>
                  </div>

                  <Field label="Loan Reference (optional)" htmlFor="loanRef" hint="e.g. SMF-2026-000123">
                    <TextInput
                      id="loanRef"
                      value={loanRef}
                      onChange={(e) => setLoanRef(e.target.value)}
                      placeholder="SMF-2026-000123"
                    />
                  </Field>
                </div>

                <div>
                  <label htmlFor="message" className="field-label">
                    Describe your issue or question
                  </label>
                  <textarea
                    id="message"
                    rows={4}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Provide full details so we can resolve your issue quickly..."
                    className="field-input w-full"
                    required
                  />
                </div>

                <div className="flex justify-end pt-2">
                  <button type="submit" className="btn-brand" disabled={submitting}>
                    {submitting ? 'Sending ticket…' : 'Send Inquiry'}
                  </button>
                </div>
              </form>
            )}
          </Card>
        </div>

        {/* Support Guides and Details */}
        <div className="space-y-5">
          <Card title="How to Make M-Pesa Repayments">
            <ol className="space-y-2 text-xs text-slate-600">
              <li>
                <strong>1. Go to M-Pesa</strong> on your phone.
              </li>
              <li>
                <strong>2. Select Lipa na M-Pesa</strong> &gt; <strong>Paybill</strong>.
              </li>
              <li>
                <strong>3. Enter Business No:</strong> <span className="font-mono font-bold text-slate-800">4081230</span>.
              </li>
              <li>
                <strong>4. Enter Account No:</strong> Your exact loan reference (e.g.{' '}
                <span className="font-mono font-semibold">SMF-2026-000123</span>).
              </li>
              <li>
                <strong>5. Enter Amount &amp; PIN</strong>, then confirm payment.
              </li>
              <li>
                <strong>6. Log your M-Pesa code</strong> on your loan details page for instant ledger verification.
              </li>
            </ol>
          </Card>

          <Card title="Physical Headquarters">
            <div className="text-xs text-slate-600 space-y-1.5">
              <p className="font-semibold text-slate-900">SecureMicrofinance Ltd</p>
              <p>SecureMicrofinance Tower, 4th Floor</p>
              <p>Upper Hill Road, Nairobi, Kenya</p>
              <p>P.O. Box 45210 - 00100, Nairobi</p>
              <p className="pt-2 text-slate-500">Business Hours: Mon–Fri, 8:00 AM – 5:00 PM</p>
            </div>
          </Card>

          <div className="rounded-2xl border border-slate-200 bg-brand-50 p-4 text-xs text-brand-900">
            <p className="font-bold">Looking for fast answers?</p>
            <p className="mt-1 text-brand-800">
              Check our Frequently Asked Questions page for details on rates, limits, and approval processes.
            </p>
            <Link to="/faqs" className="mt-2 inline-block font-bold text-brand-700 underline">
              Browse FAQs &rarr;
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
