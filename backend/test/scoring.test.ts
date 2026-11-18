import { describe, expect, it } from 'vitest';
import { query } from '../src/db/pool';
import { authHeader, createAdmin, kraPinForTest, register, request, app, type Session } from './helpers';

/**
 * M5 -- advisory credit scoring.
 *
 * The vitest run forces the fallback path (ML_FORCE_FALLBACK=true) so results
 * do not depend on whether the Python service happens to be running. What is
 * asserted here is the *contract*: a score always exists, it is labelled with
 * the model that produced it, it is advisory only, and it never blocks a
 * decision. The trained model itself is verified against its own /score
 * contract and its measured AUC.
 */
describe('credit scoring', () => {
  async function borrower(email: string, overrides: Record<string, unknown> = {}): Promise<Session> {
    const session = await register(email, { fullName: 'Grace Wanjiku', role: 'borrower' });
    const profile = await request(app)
      .put('/api/v1/me/profile')
      .set(...authHeader(session))
      .send({
        nationalId: '23456789',
        phone: '0712345678',
        occupation: 'Trader',
        monthlyIncomeCents: 4_500_000,
        kraPin: kraPinForTest(email),
        ...overrides,
      });
    expect(profile.status).toBe(200);
    return session;
  }

  async function lender(email = 'lender@scoring.test'): Promise<Session> {
    return register(email, { fullName: 'Amani Mwangi', role: 'staff', inviteCode: 'smf-staff-invite-change-me', staffId: 'Amani Micro Credit' });
  }

  async function apply(borrowerSession: Session, lenderId: string, overrides: Record<string, unknown> = {}) {
    const response = await request(app)
      .post('/api/v1/loans')
      .set(...authHeader(borrowerSession))
      .send({
        lenderId,
        principalCents: 500_000,
        termCount: 4,
        frequency: 'weekly',
        purpose: 'Restock my shop',
        ...overrides,
      });
    expect(response.status).toBe(201);
    return response.body.loan;
  }

  it('scores an application at submission and stores an advisory snapshot', async () => {
    const borrowerSession = await borrower('grace@scoring.test');
    const lenderSession = await lender();
    const loan = await apply(borrowerSession, lenderSession.userId);

    expect(loan.score).not.toBeNull();
    expect(loan.score.score).toBeGreaterThanOrEqual(0);
    expect(loan.score.score).toBeLessThanOrEqual(100);
    expect(['low', 'medium', 'high']).toContain(loan.score.riskLevel);
    expect(loan.score.advisoryOnly).toBe(true);
    // The Python service is deliberately bypassed in tests: the label must
    // say so rather than claim a model that never ran.
    expect(loan.score.modelSource).toBe('fallback_heuristic');
    expect(loan.score.modelVersion).toBe('fallback-heuristic-v1');
    expect(loan.scoreSnapshotId).toBe(loan.score.id);

    const rows = await query<{ model_source: string; advisory_only: boolean; score: number }>(
      'SELECT model_source, advisory_only, score FROM credit_scores WHERE loan_id = $1',
      [loan.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].advisory_only).toBe(true);
    expect(rows[0].score).toBe(loan.score.score);
  });

  it('scores a heavily indebted applicant below a modest one', async () => {
    const lenderSession = await lender();

    const modest = await borrower('modest@scoring.test');
    const modestLoan = await apply(modest, lenderSession.userId, { principalCents: 100_000, termCount: 8 });

    const stretched = await borrower('stretched@scoring.test');
    // Same income, 20x the principal, daily repayments: the shape of the loan
    // every experienced reviewer recognises as trouble.
    const stretchedLoan = await apply(stretched, lenderSession.userId, {
      principalCents: 2_000_000,
      termCount: 30,
      frequency: 'daily',
    });

    expect(stretchedLoan.score.score).toBeLessThan(modestLoan.score.score);
    expect(stretchedLoan.score.defaultProbability).toBeGreaterThan(modestLoan.score.defaultProbability ?? 0);
    expect(stretchedLoan.score.explanation.length).toBeGreaterThan(0);
  });

  it('exposes the score to the borrower, the lender and an admin but to nobody else', async () => {
    const borrowerSession = await borrower('grace@scoring.test');
    const lenderSession = await lender();
    const loan = await apply(borrowerSession, lenderSession.userId);

    const asBorrower = await request(app)
      .get(`/api/v1/loans/${loan.id}/score`)
      .set(...authHeader(borrowerSession));
    expect(asBorrower.status).toBe(200);
    expect(asBorrower.body.score.id).toBe(loan.score.id);
    expect(asBorrower.body.model.source).toBe('fallback_heuristic');

    const admin = await createAdmin('admin@scoring.test');
    const asAdmin = await request(app)
      .get(`/api/v1/loans/${loan.id}/score`)
      .set(...authHeader(admin));
    expect(asAdmin.status).toBe(200);

    const outsider = await borrower('outsider@scoring.test');
    const asOutsider = await request(app)
      .get(`/api/v1/loans/${loan.id}/score`)
      .set(...authHeader(outsider));
    expect(asOutsider.status).toBe(404);
  });

  it('lets the lender re-score, audits the run, and keeps the history', async () => {
    const borrowerSession = await borrower('grace@scoring.test');
    const lenderSession = await lender();
    const loan = await apply(borrowerSession, lenderSession.userId);

    const rescored = await request(app)
      .post(`/api/v1/loans/${loan.id}/score`)
      .set(...authHeader(lenderSession))
      .send({});
    expect(rescored.status).toBe(200);
    expect(rescored.body.score.id).not.toBe(loan.score.id);

    const snapshots = await query('SELECT id FROM credit_scores WHERE loan_id = $1', [loan.id]);
    expect(snapshots).toHaveLength(2);

    const audit = await query<{ action: string; detail: { advisoryOnly: boolean; source: string } }>(
      "SELECT action, detail FROM audit_log WHERE action = 'credit_score.generated'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].detail.advisoryOnly).toBe(true);
    expect(audit[0].detail.source).toBe('fallback_heuristic');

    // A borrower may not spend the lender's model budget or nudge their score.
    const byBorrower = await request(app)
      .post(`/api/v1/loans/${loan.id}/score`)
      .set(...authHeader(borrowerSession))
      .send({});
    expect(byBorrower.status).toBe(403);
  });

  it('stays advisory: a high-risk score does not block approval', async () => {
    const borrowerSession = await borrower('grace@scoring.test');
    const lenderSession = await lender();

    const loan = await apply(borrowerSession, lenderSession.userId, {
      principalCents: 2_000_000,
      termCount: 30,
      frequency: 'daily',
    });

    // Push the score to whatever the model says; the decision must not consult it.
    await query("UPDATE credit_scores SET score = 5, risk_level = 'high' WHERE loan_id = $1", [loan.id]);

    expect(
      (
        await request(app)
          .post(`/api/v1/loans/${loan.id}/verify`)
          .set(...authHeader(lenderSession))
          .send({ note: 'ID checked' })
      ).status,
    ).toBe(200);

    const decided = await request(app)
      .post(`/api/v1/loans/${loan.id}/decision`)
      .set(...authHeader(lenderSession))
      .send({ decision: 'approve', rateBps: 1000 });

    expect(decided.status).toBe(200);
    expect(decided.body.loan.status).toBe('approved');
    expect(decided.body.loan.score.score).toBe(5);
    expect(decided.body.loan.score.advisoryOnly).toBe(true);
  });
});
