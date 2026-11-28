import { Link } from 'react-router-dom';
import { LogoMark } from '../components/ui';

const LOAN_PRODUCTS = [
  {
    name: 'Emergency Loans',
    badge: 'Fast relief',
    description:
      'Quick financial support when unexpected medical, family, or urgent household expenses come up.',
    highlights: ['Rapid review process', 'Clear repayment schedule', 'No hidden charges'],
  },
  {
    name: 'Short-Term Loans',
    badge: 'Business boost',
    description:
      'Flexible working capital designed for shopkeepers, traders, and growing micro-enterprises.',
    highlights: ['Daily, weekly, or monthly terms', 'Transparent flat rate', 'Track every shilling'],
  },
  {
    name: 'Long-Term Loans',
    badge: 'Scale up',
    description:
      'Structured financing to help you invest in equipment, stock expansion, or long-term projects.',
    highlights: ['Extended installment plans', 'Digital SHA-256 agreement', 'Tamper-proof receipts'],
  },
];

const TRUST_PILLARS = [
  {
    title: 'Transparent terms upfront',
    description:
      'See your exact installment amount, interest, and total repayable before you ever commit.',
  },
  {
    title: 'Fair, human-centered review',
    description:
      'AI-assisted credit scoring supports our dedicated team so every applicant gets a fair, timely review.',
  },
  {
    title: 'Bank-grade protection & receipts',
    description:
      'Your identity data is encrypted at rest and every payment generates a verifiable, tamper-proof receipt.',
  },
];

/**
 * Public customer-friendly landing page.
 * Tapping "Apply with us today" takes the visitor to the Sign In / second page (/login).
 */
export function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Top Navigation */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5 sm:px-6">
          <Link to="/" className="flex items-center gap-3">
            <LogoMark className="h-9 w-9" />
            <span>
              <span className="block text-sm font-bold tracking-tight text-slate-900">
                SecureMicrofinance
              </span>
              <span className="block text-xs text-slate-500">Verified lending ledger</span>
            </span>
          </Link>

          <nav className="flex items-center gap-2 sm:gap-4" aria-label="Primary">
            <Link
              to="/faqs"
              className="hidden sm:inline-block rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition"
            >
              FAQs
            </Link>
            <Link
              to="/help"
              className="hidden sm:inline-block rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition"
            >
              Help & Contact
            </Link>
            <Link
              to="/login"
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 transition"
            >
              Apply with us today
              <span aria-hidden="true">→</span>
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-ink-900 to-brand-900 text-white">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-7">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-400/30 bg-brand-500/15 px-3.5 py-1 text-xs font-semibold text-brand-200">
              Trusted microfinance · Transparent & verified
            </span>
            <h1 className="mt-5 text-3xl font-bold tracking-tight text-white sm:text-5xl sm:leading-tight">
              Simple, fair financing built to help you move forward.
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-slate-300 sm:text-lg">
              Whether you need quick emergency support, working capital for your business, or a
              long-term growth loan, SecureMicrofinance gives you clear terms, fast reviews, and
              verifiable receipts every step of the way.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                to="/login"
                className="inline-flex items-center gap-2 rounded-xl bg-brand-500 px-6 py-3.5 text-base font-semibold text-white shadow-lg shadow-brand-900/30 hover:bg-brand-400 transition"
              >
                Apply with us today
                <span aria-hidden="true">→</span>
              </Link>
              <Link
                to="/faqs"
                className="inline-flex items-center rounded-xl border border-white/20 bg-white/10 px-5 py-3.5 text-sm font-semibold text-white hover:bg-white/15 transition"
              >
                Read FAQs
              </Link>
            </div>

            <div className="mt-8 flex flex-wrap gap-6 text-xs text-slate-300">
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-brand-400" />
                Clear flat interest rates
              </span>
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-brand-400" />
                Encrypted customer profiles
              </span>
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-brand-400" />
                Blockchain-anchored receipts
              </span>
            </div>
          </div>

          {/* Friendly 3-Step Card */}
          <div className="lg:col-span-5">
            <div className="rounded-3xl border border-white/10 bg-white/10 p-6 backdrop-blur-md shadow-2xl">
              <p className="text-xs font-semibold uppercase tracking-wider text-brand-300">
                How it works
              </p>
              <h2 className="mt-1 text-lg font-semibold text-white">
                Get started in 3 easy steps
              </h2>

              <ol className="mt-5 space-y-4">
                <li className="flex gap-3.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white">
                    1
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white">Sign in or create an account</p>
                    <p className="mt-0.5 text-xs text-slate-300">
                      Tap <strong>Apply with us today</strong> to access your secure borrower portal.
                    </p>
                  </div>
                </li>
                <li className="flex gap-3.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white">
                    2
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white">Choose your loan plan</p>
                    <p className="mt-0.5 text-xs text-slate-300">
                      Pick Emergency, Short-Term, or Long-Term financing with instant schedule previews.
                    </p>
                  </div>
                </li>
                <li className="flex gap-3.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white">
                    3
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white">Receive funds & track repayments</p>
                    <p className="mt-0.5 text-xs text-slate-300">
                      Download your sealed agreement and track every payment in real time.
                    </p>
                  </div>
                </li>
              </ol>

              <Link
                to="/login"
                className="mt-6 block w-full rounded-xl bg-white px-4 py-3 text-center text-sm font-semibold text-slate-900 hover:bg-slate-100 transition"
              >
                Apply with us today →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Loan Products */}
      <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-wider text-brand-700">
            Loan products
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Financing tailored to your needs
          </h2>
          <p className="mt-2 text-sm text-slate-600 sm:text-base">
            Every loan comes with a clear repayment schedule and zero surprise charges.
          </p>
        </div>

        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {LOAN_PRODUCTS.map((product) => (
            <div
              key={product.name}
              className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-sm hover:border-brand-300 hover:shadow-md transition"
            >
              <div>
                <span className="inline-block rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
                  {product.badge}
                </span>
                <h3 className="mt-4 text-lg font-bold text-slate-900">{product.name}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{product.description}</p>
                <ul className="mt-4 space-y-2 text-xs text-slate-600">
                  {product.highlights.map((item) => (
                    <li key={item} className="flex items-center gap-2">
                      <span className="text-brand-600 font-bold">✓</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              <Link
                to="/login"
                className="mt-6 inline-flex items-center justify-center rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm font-semibold text-brand-700 hover:bg-brand-600 hover:text-white transition"
              >
                Apply with us today →
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* Why Customers Trust Us */}
      <section className="border-y border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <div className="text-center max-w-2xl mx-auto">
            <p className="text-xs font-semibold uppercase tracking-wider text-brand-700">
              Built for trust
            </p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              Why borrowers choose SecureMicrofinance
            </h2>
          </div>

          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {TRUST_PILLARS.map((pillar) => (
              <div key={pillar.title} className="rounded-2xl bg-slate-50 p-6 border border-slate-100">
                <h3 className="text-base font-semibold text-slate-900">{pillar.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{pillar.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-6 rounded-3xl bg-ink-900 p-8 text-white sm:flex-row sm:items-center sm:p-10">
          <div>
            <h2 className="text-2xl font-bold">Ready to apply?</h2>
            <p className="mt-1 text-sm text-slate-300">
              Sign in or create your free borrower account in under two minutes.
            </p>
          </div>
          <Link
            to="/login"
            className="shrink-0 inline-flex items-center gap-2 rounded-xl bg-brand-500 px-6 py-3.5 text-sm font-semibold text-white hover:bg-brand-400 transition"
          >
            Apply with us today
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-auto border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>© {new Date().getFullYear()} SecureMicrofinance · Verified lending ledger</p>
          <div className="flex flex-wrap gap-4">
            <Link to="/login" className="font-medium text-slate-700 hover:text-brand-700">
              Apply with us today
            </Link>
            <Link to="/faqs" className="hover:text-slate-900">
              FAQs
            </Link>
            <Link to="/help" className="hover:text-slate-900">
              Help & Contact
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

