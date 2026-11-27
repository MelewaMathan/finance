import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, PageHeader } from '../components/ui';

interface FaqItem {
  id: string;
  category: 'eligibility' | 'loans' | 'repayments' | 'security';
  question: string;
  answer: string;
}

const FAQS_DATA: FaqItem[] = [
  // General & Eligibility
  {
    id: 'who-qualifies',
    category: 'eligibility',
    question: 'Who qualifies for a loan on SecureMicrofinance?',
    answer:
      'Any Kenyan citizen aged 18 and older with a valid National ID, an active Kenyan mobile number registered in their name, and a verified KRA PIN is eligible to register and apply.',
  },
  {
    id: 'why-profile-completeness',
    category: 'eligibility',
    question: 'Why do I need to complete my profile before applying for a loan?',
    answer:
      'Kenyan microfinance lending regulations and our risk model require verified customer identification. Having your National ID, phone number, occupation, monthly income, and KRA PIN on file allows our staff to verify your identity and generate an automated credit risk score quickly.',
  },
  {
    id: 'how-long-approval',
    category: 'eligibility',
    question: 'How long does the loan approval process take?',
    answer:
      'Emergency loans are reviewed on an express queue typically within 24 to 48 hours. Short-Term and Long-Term loans are usually reviewed and decided by institution staff within 1 to 3 business days.',
  },

  // Loan Types & Terms
  {
    id: 'loan-types-difference',
    category: 'loans',
    question: 'What is the difference between the 3 loan products?',
    answer:
      '1) Emergency Loan: Quick-turnaround relief (KES 1,000–15,000) with daily or weekly repayments for urgent unexpected expenses. 2) Short-Term Loan: Working capital (KES 5,000–50,000) for inventory restocking and small enterprise cash flow. 3) Long-Term Loan: Higher capital financing (KES 20,000–150,000) with up to 24 monthly installments for equipment or business expansion.',
  },
  {
    id: 'interest-rates',
    category: 'loans',
    question: 'How is interest calculated on loans?',
    answer:
      'SecureMicrofinance uses transparent flat interest per period set directly by institution administration. There are no hidden origination fees, ledger maintenance fees, or compound interest surprises. All total repayable amounts and installment schedules are fully computed and shown before you accept.',
  },
  {
    id: 'early-repayment',
    category: 'loans',
    question: 'Can I repay my loan early without penalties?',
    answer:
      'Yes! You can settle your installments or repay the full loan balance ahead of schedule with zero penalty fees. Early repayment strengthens your credit score on the platform.',
  },

  // Repayments & M-Pesa
  {
    id: 'how-disbursed',
    category: 'repayments',
    question: 'How do I receive my funds once approved?',
    answer:
      'Upon loan approval, institution staff disburse funds directly via Mobile Money (M-Pesa) to your registered phone number or to your verified bank account.',
  },
  {
    id: 'repay-via-mpesa',
    category: 'repayments',
    question: 'How do I make loan repayments via M-Pesa?',
    answer:
      'Go to Lipa na M-Pesa > Paybill > Enter Business Number 4081230 > Account Number: Your loan reference (e.g. SMF-2026-000123). After receiving the confirmation SMS, input your M-Pesa transaction code on your loan page to immediately clear your installment on our ledger.',
  },
  {
    id: 'held-payment',
    category: 'repayments',
    question: 'What does it mean if my transaction or loan shows "Held for Review"?',
    answer:
      'Our multi-layer fraud detection system automatically places transactions with duplicate reference codes, rapid submissions, or unusual patterns on a temporary hold. A human staff member reviews the hold promptly to verify the transfer and clear the funds safely.',
  },

  // Security & Blockchain
  {
    id: 'blockchain-verified',
    category: 'security',
    question: 'What does "Blockchain Verified" mean for my loan agreement?',
    answer:
      'When your loan is approved and disbursed, a deterministic cryptographic SHA-256 hash of the exact loan agreement and every transaction is anchored to an immutable smart contract ledger. Neither party can later alter amounts, dates, or terms without breaking the digital verification hash.',
  },
  {
    id: 'personal-data-encryption',
    category: 'security',
    question: 'Is my personal data (National ID, Phone, KRA PIN) secure?',
    answer:
      'Yes. Sensitive personal identity data is never published on-chain. All personal details are stored in the database with AES-256-GCM field-level encryption and are only shown masked to institution staff during formal identity verification.',
  },
  {
    id: 'statement-agreement-download',
    category: 'security',
    question: 'Can I download an official copy of my loan agreement and statements?',
    answer:
      'Yes. Every approved loan provides a downloadable sealed PDF agreement bearing its unique SHA-256 digital fingerprint, along with real-time PDF or CSV statements of your full transaction and installment history.',
  },
];

const CATEGORIES = [
  { id: 'all', label: 'All Questions' },
  { id: 'eligibility', label: 'Eligibility & Profile' },
  { id: 'loans', label: 'Loan Types & Terms' },
  { id: 'repayments', label: 'Repayments & M-Pesa' },
  { id: 'security', label: 'Security & Blockchain' },
] as const;

export function FaqsPage() {
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(FAQS_DATA[0].id);

  const filteredFaqs = useMemo(() => {
    return FAQS_DATA.filter((faq) => {
      const matchesCategory = activeCategory === 'all' || faq.category === activeCategory;
      const matchesQuery =
        searchQuery.trim() === '' ||
        faq.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
        faq.answer.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesQuery;
    });
  }, [activeCategory, searchQuery]);

  function toggleFaq(id: string) {
    setExpandedId((current) => (current === id ? null : id));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Frequently Asked Questions (FAQs)"
        subtitle="Learn about our loan types, eligibility, M-Pesa repayments, and how blockchain cryptographic receipts protect your records."
      />

      {/* Search Input */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="relative">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search questions (e.g. M-Pesa, KRA PIN, interest rate, emergency loan)..."
            className="field-input w-full pl-10"
          />
          <span className="absolute left-3 top-2.5 text-slate-400">🔍</span>
        </div>

        {/* Category Pills */}
        <div className="mt-4 flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setActiveCategory(cat.id)}
              className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                activeCategory === cat.id
                  ? 'bg-brand-700 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Accordion Questions List */}
      <div className="space-y-3">
        {filteredFaqs.length === 0 ? (
          <div className="card p-8 text-center text-slate-500">
            <p className="text-base font-semibold">No questions matched your search query.</p>
            <p className="mt-1 text-xs">Try different keywords or browse all categories.</p>
          </div>
        ) : (
          filteredFaqs.map((faq) => {
            const isExpanded = expandedId === faq.id;
            return (
              <div
                key={faq.id}
                className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition"
              >
                <button
                  type="button"
                  onClick={() => toggleFaq(faq.id)}
                  className="flex w-full items-center justify-between px-5 py-4 text-left font-semibold text-slate-900 hover:bg-slate-50"
                  aria-expanded={isExpanded}
                >
                  <span className="text-sm sm:text-base pr-4">{faq.question}</span>
                  <span className="text-lg font-bold text-slate-400 shrink-0">
                    {isExpanded ? '−' : '+'}
                  </span>
                </button>
                {isExpanded && (
                  <div className="border-t border-slate-100 px-5 py-4 text-sm leading-relaxed text-slate-600 bg-slate-50/50">
                    <p>{faq.answer}</p>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Still Need Help Banner */}
      <Card title="Still have questions?">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">Our customer care desk is ready to help.</p>
            <p className="mt-1 text-xs text-slate-500">
              Reach our support team via phone, email, or by filing an online inquiry ticket.
            </p>
          </div>
          <Link to="/help" className="btn-brand shrink-0 text-center">
            Contact Support &rarr;
          </Link>
        </div>
      </Card>
    </div>
  );
}
