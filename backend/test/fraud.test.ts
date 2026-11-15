import { afterEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool';
import { __setAnomalyScorer, type AnomalyResponse } from '../src/modules/fraud/anomaly.client';
import { authHeader, createAuditor, register, request, app, type Session } from './helpers';

/**
 * M6 -- fraud detection, holds and the review queue.
 *
 * Layer 1 (rules) is covered by the repayment and loan suites. This suite
 * covers layer 2 (the anomaly model), the hold it can create, and the human
 * decision that releases or rejects it.
 *
 * The model is *stubbed at the seam*, not mocked away: `__setAnomalyScorer`
 * replaces only the network call, so the feature queries, the flag, the hold,
 * the alert, the reviewer note and the audit entries all run for real.
 * The live service is verified separately against its own /anomaly contract.
 */
const flagged: AnomalyResponse = {
  is_anomaly: true,
  risk: 0.91,
  severity: 'high',
  decision_score: -0.94,
  threshold: -0.5536,
  model_version: 'stub-forest',
  latency_ms: 2,
  unusual: [{ feature: 'amount_ratio', value: 30, typical: 1, deviation: 126 }],
};

const normal: AnomalyResponse = { ...flagged, is_anomaly: false, risk: 0.12, severity: 'low', unusual: [] };

function scorerFor(response: AnomalyResponse | null) {
  return async () => response;
}

afterEach(() => {
  __setAnomalyScorer(null);
});

async function borrower(email: string): Promise<Session> {
  const session = await register(email, { fullName: 'Grace Wanjiku', role: 'borrower' });
  const profile = await request(app)
    .put('/api/v1/me/profile')
    .set(...authHeader(session))
    .send({ nationalId: '23456789', phone: '0712345678', occupation: 'Trader', monthlyIncomeCents: 4_500_000 });
  expect(profile.status).toBe(200);
  return session;
}

async function lender(email = 'lender@fraud.test'): Promise<Session> {
  return register(email, { fullName: 'Amani Mwangi', role: 'staff', inviteCode: 'smf-staff-invite-change-me', staffId: 'Amani Micro Credit' });
}

/** A loan taken through approval and disbursement, ready to be repaid. */
async function liveLoan(borrowerSession: Session, lenderSession: Session, principalCents = 100_000) {
  const applied = await request(app)
    .post('/api/v1/loans')
    .set(...authHeader(borrowerSession))
    .send({ lenderId: lenderSession.userId, principalCents, termCount: 4, frequency: 'weekly', purpose: 'Restock' });
  expect(applied.status).toBe(201);
  const loan = applied.body.loan;

  expect(
    (await request(app).post(`/api/v1/loans/${loan.id}/verify`).set(...authHeader(lenderSession)).send({ note: 'ID checked' }))
      .status,
  ).toBe(200);
  expect(
    (
      await request(app)
        .post(`/api/v1/loans/${loan.id}/decision`)
        .set(...authHeader(lenderSession))
        .send({ decision: 'approve', rateBps: 1000 })
    ).status,
  ).toBe(200);

  const disbursed = await request(app)
    .post(`/api/v1/loans/${loan.id}/disburse`)
    .set(...authHeader(lenderSession))
    .send({ method: 'cash' });
  expect(disbursed.status).toBe(200);
  expect(disbursed.body.held).toBe(false);
  return disbursed.body.loan as { id: string; ref: string; status: string };
}

describe('fraud detection and review', () => {
  it('stores the model risk on the transaction and raises one deduplicated ml flag', async () => {
    const borrowerSession = await borrower('grace@fraud.test');
    const lenderSession = await lender();
    const loan = await liveLoan(borrowerSession, lenderSession);

    __setAnomalyScorer(scorerFor(flagged));
    const paid = await request(app)
      .post(`/api/v1/loans/${loan.id}/repayments`)
      .set(...authHeader(borrowerSession))
      .send({ amountCents: 25_000, method: 'cash' });
    // 202: the claim was accepted for review, it has not cleared.
    expect(paid.status).toBe(202);
    expect(paid.body.held).toBe(true);

    const flags = await query<{ flag_type: string; source: string; severity: string; detail: { risk: number } }>(
      'SELECT flag_type, source, severity, detail FROM fraud_flags WHERE loan_id = $1',
      [loan.id],
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].flag_type).toBe('ml_anomaly');
    expect(flags[0].source).toBe('ml');
    expect(flags[0].severity).toBe('high');
    expect(flags[0].detail.risk).toBeCloseTo(0.91, 2);

    const txn = await query<{ status: string; fraud_score: string }>(
      "SELECT status, fraud_score FROM transactions WHERE loan_id = $1 AND type = 'repayment'",
      [loan.id],
    );
    expect(txn[0].status).toBe('held');
    expect(Number(txn[0].fraud_score)).toBeCloseTo(0.91, 2);

    // The lender is told without having to poll the queue.
    const alerts = await query<{ severity: string; title: string }>('SELECT severity, title FROM alerts');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('high');
  });

  it('releases a held repayment through the same allocation code and records the note', async () => {
    const borrowerSession = await borrower('grace@fraud.test');
    const lenderSession = await lender();
    const loan = await liveLoan(borrowerSession, lenderSession);

    __setAnomalyScorer(scorerFor(flagged));
    const paid = await request(app)
      .post(`/api/v1/loans/${loan.id}/repayments`)
      .set(...authHeader(borrowerSession))
      .send({ amountCents: 25_000, method: 'cash' });
    expect(paid.status).toBe(202);
    expect(paid.body.held).toBe(true);

    // Held money has not moved: nothing is allocated yet.
    const before = await query<{ paid: number }>(
      'SELECT COALESCE(SUM(paid_principal_cents + paid_interest_cents + paid_penalty_cents), 0)::bigint AS paid FROM loan_installments WHERE loan_id = $1',
      [loan.id],
    );
    expect(Number(before[0].paid)).toBe(0);

    const released = await request(app)
      .post(`/api/v1/loans/${loan.id}/holds/resolve`)
      .set(...authHeader(lenderSession))
      .send({ decision: 'release', note: 'Confirmed with the borrower on the phone; tenant deposit.' });
    expect(released.status).toBe(200);
    expect(released.body.loan.status).toBe('active');

    const after = await query<{ paid: number }>(
      'SELECT COALESCE(SUM(paid_principal_cents + paid_interest_cents + paid_penalty_cents), 0)::bigint AS paid FROM loan_installments WHERE loan_id = $1',
      [loan.id],
    );
    expect(Number(after[0].paid)).toBe(25_000);

    const flag = await query<{ status: string; resolution_note: string | null; reviewed_by: string | null }>(
      'SELECT status, resolution_note, reviewed_by FROM fraud_flags WHERE loan_id = $1',
      [loan.id],
    );
    expect(flag[0].status).toBe('cleared');
    expect(flag[0].resolution_note).toContain('tenant deposit');
    expect(flag[0].reviewed_by).toBe(lenderSession.userId);

    const txn = await query<{ status: string; hold_reason: string | null }>(
      "SELECT status, hold_reason FROM transactions WHERE loan_id = $1 AND type = 'repayment'",
      [loan.id],
    );
    expect(txn[0].status).toBe('cleared');
    expect(txn[0].hold_reason).toBeNull();

    const audit = await query<{ action: string }>("SELECT action FROM audit_log WHERE action = 'fraud.hold_released'");
    expect(audit).toHaveLength(1);
  });

  it('rejects a held movement without erasing it from the record', async () => {
    const borrowerSession = await borrower('grace@fraud.test');
    const lenderSession = await lender();
    const loan = await liveLoan(borrowerSession, lenderSession);

    __setAnomalyScorer(scorerFor(flagged));
    await request(app)
      .post(`/api/v1/loans/${loan.id}/repayments`)
      .set(...authHeader(borrowerSession))
      .send({ amountCents: 25_000, method: 'cash' });

    const rejected = await request(app)
      .post(`/api/v1/loans/${loan.id}/holds/resolve`)
      .set(...authHeader(lenderSession))
      .send({ decision: 'reject', note: 'Receipt does not exist on the M-Pesa statement.' });
    expect(rejected.status).toBe(200);

    const txn = await query<{ status: string; hold_reason: string }>(
      "SELECT status, hold_reason FROM transactions WHERE loan_id = $1 AND type = 'repayment'",
      [loan.id],
    );
    // Kept, not deleted: an auditor must see that a claim was made and refused.
    expect(txn[0].status).toBe('rejected');
    expect(txn[0].hold_reason).toContain('Receipt does not exist');

    const paid = await query<{ paid: number }>(
      'SELECT COALESCE(SUM(paid_principal_cents + paid_interest_cents + paid_penalty_cents), 0)::bigint AS paid FROM loan_installments WHERE loan_id = $1',
      [loan.id],
    );
    expect(Number(paid[0].paid)).toBe(0);

    const flag = await query<{ status: string }>('SELECT status FROM fraud_flags WHERE loan_id = $1', [loan.id]);
    expect(flag[0].status).toBe('confirmed');
  });

  it('returns a rejected held disbursement to approved so the lender can retry', async () => {
    const borrowerSession = await borrower('grace@fraud.test');
    const lenderSession = await lender();

    __setAnomalyScorer(scorerFor(flagged));
    const applied = await request(app)
      .post('/api/v1/loans')
      .set(...authHeader(borrowerSession))
      .send({ lenderId: lenderSession.userId, principalCents: 100_000, termCount: 4, frequency: 'weekly', purpose: 'Restock' });
    const loanId = applied.body.loan.id as string;

    await request(app).post(`/api/v1/loans/${loanId}/verify`).set(...authHeader(lenderSession)).send({ note: 'ID checked' });
    await request(app)
      .post(`/api/v1/loans/${loanId}/decision`)
      .set(...authHeader(lenderSession))
      .send({ decision: 'approve', rateBps: 1000 });

    const held = await request(app)
      .post(`/api/v1/loans/${loanId}/disburse`)
      .set(...authHeader(lenderSession))
      .send({ method: 'cash' });
    expect(held.status).toBe(200);
    expect(held.body.held).toBe(true);
    expect(held.body.loan.status).toBe('held');

    const rejected = await request(app)
      .post(`/api/v1/loans/${loanId}/holds/resolve`)
      .set(...authHeader(lenderSession))
      .send({ decision: 'reject', note: 'Anomalous payout; borrower asked to collect in person.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.loan.status).toBe('approved');

    // The retry is a normal disbursement: the rejected row does not trip R5.
    __setAnomalyScorer(scorerFor(normal));
    const retried = await request(app)
      .post(`/api/v1/loans/${loanId}/disburse`)
      .set(...authHeader(lenderSession))
      .send({ method: 'cash' });
    expect(retried.status).toBe(200);
    expect(retried.body.held).toBe(false);
    expect(retried.body.loan.status).toBe('disbursed');
  });

  it('scopes the queue to the lender, shows everything to an auditor and nothing to a borrower', async () => {
    const borrowerSession = await borrower('grace@fraud.test');
    const lenderSession = await lender();
    const loan = await liveLoan(borrowerSession, lenderSession);

    __setAnomalyScorer(scorerFor(flagged));
    await request(app)
      .post(`/api/v1/loans/${loan.id}/repayments`)
      .set(...authHeader(borrowerSession))
      .send({ amountCents: 25_000, method: 'cash' });

    const own = await request(app).get('/api/v1/fraud/flags').set(...authHeader(lenderSession));
    expect(own.status).toBe(200);
    expect(own.body.count).toBe(1);
    expect(own.body.flags[0].borrowerName).toBe('Grace Wanjiku');

    const other = await lender('other@fraud.test');
    const others = await request(app).get('/api/v1/fraud/flags').set(...authHeader(other));
    expect(others.status).toBe(200);
    expect(others.body.count).toBe(0);

    const outsiderResolve = await request(app)
      .post(`/api/v1/fraud/flags/${own.body.flags[0].id}/resolve`)
      .set(...authHeader(other))
      .send({ resolution: 'cleared', note: 'Not mine to judge.' });
    expect(outsiderResolve.status).toBe(404);

    const auditor = await createAuditor('auditor@fraud.test');
    const asAuditor = await request(app).get('/api/v1/fraud/flags').set(...authHeader(auditor));
    expect(asAuditor.status).toBe(200);
    expect(asAuditor.body.count).toBe(1);

    // An auditor reviews the reviewer; they must not be able to clear findings.
    const auditorResolve = await request(app)
      .post(`/api/v1/fraud/flags/${own.body.flags[0].id}/resolve`)
      .set(...authHeader(auditor))
      .send({ resolution: 'cleared', note: 'Auditors do not decide.' });
    expect(auditorResolve.status).toBe(403);

    const asBorrower = await request(app).get('/api/v1/fraud/flags').set(...authHeader(borrowerSession));
    expect(asBorrower.status).toBe(403);

    // The borrower may still see that their own payment was held.
    const ownFlags = await request(app).get(`/api/v1/loans/${loan.id}/flags`).set(...authHeader(borrowerSession));
    expect(ownFlags.status).toBe(200);
    expect(ownFlags.body.count).toBe(1);
    expect(ownFlags.body.flags[0].detail).toEqual({});
    expect(ownFlags.body.flags[0].resolutionNote).toBeNull();
  });

  it('clearing a flag is a judgement and never moves money by itself', async () => {
    const borrowerSession = await borrower('grace@fraud.test');
    const lenderSession = await lender();
    const loan = await liveLoan(borrowerSession, lenderSession);

    __setAnomalyScorer(scorerFor(flagged));
    await request(app)
      .post(`/api/v1/loans/${loan.id}/repayments`)
      .set(...authHeader(borrowerSession))
      .send({ amountCents: 25_000, method: 'cash' });

    const flags = await request(app).get('/api/v1/fraud/flags').set(...authHeader(lenderSession));
    const flagId = flags.body.flags[0].id as string;

    const cleared = await request(app)
      .post(`/api/v1/fraud/flags/${flagId}/resolve`)
      .set(...authHeader(lenderSession))
      .send({ resolution: 'cleared', note: 'Saw the bank statement; the amount was a salary advance.' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.flag.status).toBe('cleared');

    // The money is still parked: a cleared flag is not a release.
    const txn = await query<{ status: string }>(
      "SELECT status FROM transactions WHERE loan_id = $1 AND type = 'repayment'",
      [loan.id],
    );
    expect(txn[0].status).toBe('held');

    const summary = await request(app).get('/api/v1/fraud/summary').set(...authHeader(lenderSession));
    expect(summary.body.summary.heldMovements).toBe(1);
    expect(summary.body.summary.openFlags).toBe(0);

    // A resolution needs a reason; "cleared" alone is a rubber stamp.
    const second = await request(app)
      .post(`/api/v1/fraud/flags/${flagId}/resolve`)
      .set(...authHeader(lenderSession))
      .send({ resolution: 'confirmed', note: 'changed my mind' });
    expect(second.status).toBe(409);
  });

  it('fails open: an unreachable model never blocks a real payment', async () => {
    const borrowerSession = await borrower('grace@fraud.test');
    const lenderSession = await lender();
    const loan = await liveLoan(borrowerSession, lenderSession);

    __setAnomalyScorer(scorerFor(null));
    const paid = await request(app)
      .post(`/api/v1/loans/${loan.id}/repayments`)
      .set(...authHeader(borrowerSession))
      .send({ amountCents: 25_000, method: 'cash' });

    expect(paid.status).toBe(201);
    expect(paid.body.held).toBe(false);
    expect(paid.body.loan.status).toBe('active');

    const flags = await query('SELECT id FROM fraud_flags');
    expect(flags).toHaveLength(0);
  });

  it('lets a lender read and clear their alerts', async () => {
    const borrowerSession = await borrower('grace@fraud.test');
    const lenderSession = await lender();
    const loan = await liveLoan(borrowerSession, lenderSession);

    __setAnomalyScorer(scorerFor(flagged));
    await request(app)
      .post(`/api/v1/loans/${loan.id}/repayments`)
      .set(...authHeader(borrowerSession))
      .send({ amountCents: 25_000, method: 'cash' });

    const inbox = await request(app).get('/api/v1/alerts?unread=true').set(...authHeader(lenderSession));
    expect(inbox.status).toBe(200);
    expect(inbox.body.unread).toBe(1);
    expect(inbox.body.alerts).toHaveLength(1);

    const read = await request(app)
      .post(`/api/v1/alerts/${inbox.body.alerts[0].id}/read`)
      .set(...authHeader(lenderSession));
    expect(read.status).toBe(200);
    expect(read.body.alert.readAt).not.toBeNull();

    const after = await request(app).get('/api/v1/alerts').set(...authHeader(lenderSession));
    expect(after.body.unread).toBe(0);

    // Alerts are per-user: another lender cannot even see the id.
    const other = await lender('other@alerts.test');
    const stolen = await request(app)
      .post(`/api/v1/alerts/${inbox.body.alerts[0].id}/read`)
      .set(...authHeader(other));
    expect(stolen.status).toBe(404);
  });
});
