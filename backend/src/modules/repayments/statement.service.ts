import { renderPdf, type PdfLine } from '../../lib/pdf';
import { formatMoneyForDocument } from '../../lib/format';
import { getLoan, type Actor } from '../loans/loan.service';

/**
 * Borrower and institution statements share
 * this shape: one immutable snapshot of terms, schedule, payments and totals
 * at the moment of generation.
 */
export async function getStatement(actor: Actor, loanId: string) {
  const loan = await getLoan(actor, loanId);
  return {
    generatedAt: new Date().toISOString(),
    ref: loan.ref,
    status: loan.status,
    borrower: { fullName: loan.borrower.fullName, email: loan.borrower.email },
    institution: { name: loan.institution.institutionName },
    terms: {
      principalCents: loan.principalCents,
      rateBps: loan.rateBps,
      termCount: loan.termCount,
      frequency: loan.frequency,
      totalRepayableCents: loan.totalRepayableCents,
      disbursedAt: loan.disbursedAt,
      createdAt: loan.createdAt,
    },
    summary: loan.summary,
    installments: loan.installments,
    payments: loan.transactions,
    agreementSha256: loan.agreementSha256,
  };
}

export type Statement = Awaited<ReturnType<typeof getStatement>>;

/** Renders the statement as a PDF; getLoan already refreshes penalties. */
export async function renderStatementPdf(actor: Actor, loanId: string): Promise<{ pdf: Buffer; statement: Statement }> {
  const statement = await getStatement(actor, loanId);
  const money = formatMoneyForDocument;

  const lines: PdfLine[] = [
    { text: 'LOAN STATEMENT', size: 18, bold: true },
    { text: `Reference ${statement.ref}`, size: 11, gapBefore: 4 },
    { text: `Status: ${statement.status} · Generated ${statement.generatedAt.slice(0, 19).replace('T', ' ')} UTC`, size: 9 },
    { text: '', gapBefore: 10 },
    { text: 'PARTIES', size: 10, bold: true },
    { text: `Institution: ${statement.institution.name}` },
    { text: `Borrower: ${statement.borrower.fullName}` },
    { text: '', gapBefore: 8 },
    { text: 'TERMS', size: 10, bold: true },
    { text: `Principal ${money(statement.terms.principalCents)} · ${(statement.terms.rateBps / 100).toFixed(2)}% per ${statement.terms.frequency.replace('ly', '')} period · ${statement.terms.termCount} installments` },
    { text: `Total repayable ${money(statement.terms.totalRepayableCents)}` },
    { text: '', gapBefore: 8 },
    { text: 'POSITION', size: 10, bold: true },
    { text: `Paid ${money(statement.summary.paidCents)} · Penalties ${money(statement.summary.accruedPenaltyCents)} · Outstanding ${money(statement.summary.outstandingCents)}` },
    { text: `Installments paid: ${statement.summary.installmentsPaid} of ${statement.summary.installmentsTotal}` },
    { text: '', gapBefore: 10 },
    { text: 'SCHEDULE', size: 10, bold: true },
    { text: 'No.  Due date      Due             Paid            Status', size: 9, bold: true },
  ];

  for (const row of statement.installments) {
    lines.push({
      text: `${String(row.seq).padStart(2, ' ')}   ${row.dueDate}    ${money(row.dueCents).padEnd(16, ' ')}${money(row.paidCents).padEnd(16, ' ')}${row.status}`,
      size: 9,
    });
  }

  lines.push({ text: '', gapBefore: 10 }, { text: 'PAYMENTS', size: 10, bold: true });
  if (statement.payments.length === 0) {
    lines.push({ text: 'No payments recorded.', size: 9 });
  } else {
    for (const payment of statement.payments) {
      lines.push({
        text: `${new Date(payment.occurredAt).toISOString().slice(0, 10)}  ${payment.type.padEnd(12, ' ')}${money(payment.amountCents).padEnd(15, ' ')}${payment.status.padEnd(9, ' ')}${payment.mobileTxnCode ?? '—'}`,
        size: 9,
      });
    }
  }

  if (statement.agreementSha256) {
    lines.push(
      { text: '', gapBefore: 10 },
      { text: 'AGREEMENT FINGERPRINT', size: 10, bold: true },
      { text: statement.agreementSha256, size: 8 },
    );
  }

  lines.push(
    { text: '', gapBefore: 12 },
    { text: 'Payment hashes are anchored on the ledger; each row can be re-verified against it.', size: 8 },
  );

  return { pdf: renderPdf(lines), statement };
}

/** RFC 4180-ish CSV; amounts are plain decimals so spreadsheets read them. */
export function statementCsv(statement: Statement): string {
  const money = (cents: number) => (cents / 100).toFixed(2);
  const cell = (value: string | number | null | undefined) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const rows: string[] = [
    `${statement.institution.name} loan statement`,
    `Reference,${cell(statement.ref)}`,
    `Generated,${cell(statement.generatedAt)}`,
    `Borrower,${cell(statement.borrower.fullName)}`,
    `Institution,${cell(statement.institution.name)}`,
    `Status,${cell(statement.status)}`,
    `Principal,${money(statement.terms.principalCents)}`,
    `Rate bps,${statement.terms.rateBps}`,
    `Term count,${statement.terms.termCount}`,
    `Frequency,${statement.terms.frequency}`,
    `Total repayable,${money(statement.terms.totalRepayableCents)}`,
    `Paid,${money(statement.summary.paidCents)}`,
    `Penalties,${money(statement.summary.accruedPenaltyCents)}`,
    `Outstanding,${money(statement.summary.outstandingCents ?? 0)}`,
    '',
    'Installments',
    'No,Due date,Principal,Interest,Penalty,Paid,Status',
    ...statement.installments.map((row) =>
      [
        row.seq,
        row.dueDate,
        money(row.principalDueCents),
        money(row.interestDueCents),
        money(row.penaltyAccruedCents),
        money(row.paidCents),
        row.status,
      ].join(','),
    ),
    '',
    'Payments',
    'Date,Type,Method,Reference,Amount,Status,Payload hash,On-chain hash',
    ...statement.payments.map((payment) =>
      [
        cell(new Date(payment.occurredAt).toISOString()),
        payment.type,
        payment.method,
        cell(payment.mobileTxnCode),
        money(payment.amountCents),
        payment.status,
        cell(payment.hash),
        cell(payment.onchain.hash),
      ].join(','),
    ),
  ];

  return `${rows.join('\n')}\n`;
}
