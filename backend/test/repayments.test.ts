import { describe, expect, it } from 'vitest';
import { query } from '../src/db/pool';
import { sha256Hex } from '../src/lib/crypto';
import { authHeader, createAuditor, register, request, app, type Session } from './helpers';

/**
 * M3 -- repayment tracking, penalties and statements.
 *
 * Fixture loan: KES 5,000 principal, 10% flat per week, 4 weekly
 * installments => KES 7,000 total, KES 1,750 per installment
 * (1,250 principal + 500 interest).
 */
describe('repayments', () => {
  async function scenario(email = 'borrower@repay.test') {
    const borrower = await register(email, { fullName: 'Grace Wanjiku', role: 'borrower' });
    await request(app)
      .put('/api/v1/me/profile')
      .set(...authHeader(borrower))
      .send({ nationalId: '23456789', phone: '0712345678', occupation: 'Trader', monthlyIncomeCents: 4_500_000 });

    const lender = await register(`lender-${email}`, {
      fullName: 'Amani Mwangi',
      role: 'lender',
      businessName: 'Amani Micro Credit',
    });

    const applied = await request(app).post('/api/v1/loans').set(...authHeader(borrower)).send({
      lenderId: lender.userId,
      principalCents: 500_000,
      termCount: 4,
      frequency: 'weekly',
      purpose: 'Restock my shop',
    });
    expect(applied.status).toBe(201);
    const loanId = applied.body.loan.id as string;

    await request(app).post(`/api/v1/loans/${loanId}/verify`).set(...authHeader(lender)).send({});
    const decided = await request(app)
      .post(`/api/v1/loans/${loanId}/decision`)
      .set(...authHeader(lender))
      .send({ decision: 'approve', rateBps: 1000 });
    expect(decided.status).toBe(200);

    const disbursed = await request(app)
      .post(`/api/v1/loans/${loanId}/disburse`)
      .set(...authHeader(lender))
      .send({ method: 'cash' });
    expect(disbursed.body.held).toBe(false);

    return { borrower, lender, loanId };
  }

  function repay(session: Session, loanId: string, body: Record<string, unknown>) {
    return request(app)
      .post(`/api/v1/loans/${loanId}/repayments`)
      .set(...authHeader(session))
      .send(body);
  }

  it('allocates a partial repayment interest-first and marks the installment partial', async () => {
    const { borrower, loanId } = await scenario();

    const response = await repay(borrower, loanId, {
      amountCents: 100_000,
      method: 'mobile_money',
      mobileTxnCode: 'SJ21AB3XYZ',
    });

    expect(response.status).toBe(201);
    expect(response.body.held).toBe(false);
    expect(response.body.loan.status).toBe('active');

    const first = response.body.loan.installments[0];
    expect(first.status).toBe('partial');
    expect(first.paidCents).toBe(100_000);
    // 50,000 interest then 50,000 principal.
    expect(first.interestDueCents).toBe(50_000);
    expect(first.principalDueCents).toBe(125_000);
    expect(first.paidCents).toBe(100_000);

    const second = response.body.loan.installments[1];
    expect(second.status).toBe('pending');
    expect(second.paidCents).toBe(0);

    expect(response.body.loan.summary.outstandingCents).toBe(600_000);
    expect(response.body.loan.transactions.at(-1).hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('settles the loan when the final balance is paid', async () => {
    const { borrower, loanId } = await scenario('settle@repay.test');

    const response = await repay(borrower, loanId, {
      amountCents: 700_000,
      method: 'mobile_money',
      mobileTxnCode: 'QK49PZ1ABC',
    });

    expect(response.status).toBe(201);
    expect(response.body.loan.status).toBe('settled');
    expect(response.body.loan.summary.outstandingCents).toBe(0);
    expect(response.body.loan.summary.installmentsPaid).toBe(4);
    expect(response.body.loan.installments.every((row: { status: string }) => row.status === 'paid')).toBe(true);

    const row = await query<{ settled_at: Date | null }>('SELECT settled_at FROM loans WHERE id = $1', [loanId]);
    expect(row[0].settled_at).not.toBeNull();

    const actions = await query<{ action: string }>("SELECT action FROM audit_log WHERE action = 'loan.settled'");
    expect(actions).toHaveLength(1);
  });

  it('refuses an overpayment and any repayment before disbursement', async () => {
    const { borrower, loanId } = await scenario('over@repay.test');

    const over = await repay(borrower, loanId, { amountCents: 700_001, method: 'cash' });
    expect(over.status).toBe(422);
    expect(over.body.error.message).toMatch(/outstanding/i);

    // A pending application has no schedule to repay.
    const lender = await register('lender-pending@repay.test', { role: 'lender', businessName: 'Second Credit' });
    const applied = await request(app).post('/api/v1/loans').set(...authHeader(borrower)).send({
      lenderId: lender.userId,
      principalCents: 100_000,
      termCount: 2,
      frequency: 'monthly',
      purpose: 'Pending application',
    });
    const early = await repay(borrower, applied.body.loan.id, { amountCents: 10_000, method: 'cash' });
    expect(early.status).toBe(409);
  });

  it('holds a repayment that reuses a receipt and does not apply the money', async () => {
    const { borrower, loanId } = await scenario('dupe@repay.test');

    const first = await repay(borrower, loanId, {
      amountCents: 175_000,
      method: 'mobile_money',
      mobileTxnCode: 'ABCD123456',
    });
    expect(first.status).toBe(201);
    expect(first.body.loan.summary.outstandingCents).toBe(525_000);

    const second = await repay(borrower, loanId, {
      amountCents: 175_000,
      method: 'mobile_money',
      mobileTxnCode: 'ABCD123456',
    });

    expect(second.status).toBe(202);
    expect(second.body.held).toBe(true);
    expect(second.body.reason).toMatch(/duplicate/i);
    // Held money is not applied: the balance is unchanged.
    expect(second.body.loan.summary.outstandingCents).toBe(525_000);

    const heldTransaction = second.body.loan.transactions.at(-1);
    expect(heldTransaction.status).toBe('held');

    const flags = await query<{ flag_type: string; severity: string }>(
      'SELECT flag_type, severity FROM fraud_flags WHERE loan_id = $1',
      [loanId],
    );
    expect(flags).toEqual([{ flag_type: 'duplicate_txn_code', severity: 'high' }]);
  });

  it('rejects a malformed mobile-money reference without recording a transaction', async () => {
    const { borrower, loanId } = await scenario('malformed@repay.test');

    const response = await repay(borrower, loanId, {
      amountCents: 50_000,
      method: 'mobile_money',
      mobileTxnCode: 'FAKE123',
    });

    expect(response.status).toBe(400);
    const txns = await query("SELECT id FROM transactions WHERE loan_id = $1 AND type = 'repayment'", [loanId]);
    expect(txns).toHaveLength(0);
  });

  it('accrues penalties on overdue installments idempotently', async () => {
    const { lender, loanId } = await scenario('penalty@repay.test');

    await query("UPDATE loan_installments SET due_date = CURRENT_DATE - 40 WHERE loan_id = $1 AND seq = 1", [loanId]);

    const first = await request(app).get(`/api/v1/loans/${loanId}`).set(...authHeader(lender));
    expect(first.status).toBe(200);
    const overdue = first.body.loan.installments[0];
    expect(overdue.status).toBe('overdue');
    // 5% per month pro rata for (40 - 3 grace) days on KES 1,750.
    expect(overdue.penaltyAccruedCents).toBeGreaterThan(0);
    expect(overdue.penaltyAccruedCents).toBe(10_792);

    const second = await request(app).get(`/api/v1/loans/${loanId}`).set(...authHeader(lender));
    expect(second.body.loan.installments[0].penaltyAccruedCents).toBe(overdue.penaltyAccruedCents);

    // Paying more than the contractual due is allowed up to the penalty.
    const pay = await repay(lender, loanId, { amountCents: 175_000 + overdue.penaltyAccruedCents, method: 'cash' });
    expect(pay.status).toBe(201);
    expect(pay.body.loan.installments[0].status).toBe('paid');
    expect(pay.body.loan.installments[0].paidCents).toBe(175_000 + overdue.penaltyAccruedCents);
  });

  it('generates JSON, PDF and CSV statements with matching totals', async () => {
    const { borrower, lender, loanId } = await scenario('statement@repay.test');

    await repay(borrower, loanId, { amountCents: 100_000, method: 'mobile_money', mobileTxnCode: 'SJ21AB3XYZ' });

    const json = await request(app).get(`/api/v1/loans/${loanId}/statement`).set(...authHeader(borrower));
    expect(json.status).toBe(200);
    expect(json.body.statement.ref).toMatch(/^SMF-/);
    expect(json.body.statement.summary.paidCents).toBe(100_000);
    expect(json.body.statement.summary.outstandingCents).toBe(600_000);
    expect(json.body.statement.installments).toHaveLength(4);
    expect(json.body.statement.payments.length).toBeGreaterThanOrEqual(2);

    const pdf = await request(app)
      .get(`/api/v1/loans/${loanId}/statement.pdf`)
      .set(...authHeader(lender))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const bytes = pdf.body as Buffer;
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(sha256Hex(bytes)).toBe(pdf.headers['x-document-sha256']);

    const csv = await request(app).get(`/api/v1/loans/${loanId}/statement.csv`).set(...authHeader(borrower));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain(json.body.statement.ref);
    expect(csv.text).toContain('SJ21AB3XYZ');
    expect(csv.text).toContain('1000.00');

    const audits = await query<{ detail: { format: string } }>(
      "SELECT detail FROM audit_log WHERE action = 'statement.generated' ORDER BY seq",
    );
    expect(audits.map((row) => row.detail.format).sort()).toEqual(['csv', 'json', 'pdf']);
  });

  it('keeps other borrowers out and auditors read-only', async () => {
    const { loanId } = await scenario('owner@repay.test');
    const outsider = await register('outsider@repay.test', { role: 'borrower' });
    const auditor = await createAuditor('auditor@repay.test');

    const read = await request(app).get(`/api/v1/loans/${loanId}/statement`).set(...authHeader(outsider));
    expect(read.status).toBe(404);

    const write = await repay(auditor, loanId, { amountCents: 10_000, method: 'cash' });
    expect(write.status).toBe(403);

    const auditRead = await request(app).get(`/api/v1/loans/${loanId}/statement`).set(...authHeader(auditor));
    expect(auditRead.status).toBe(200);
  });
});
