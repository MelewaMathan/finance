import { describe, expect, it } from 'vitest';
import { query } from '../src/db/pool';
import { hashTransaction } from '../src/lib/canonical';
import { authHeader, createAuditor, register, request, app, type Session } from './helpers';

/**
 * M4 -- ledger verification.
 *
 * No contract is deployed for the test run, so the honest answer for every
 * payment is "unanchored". What *is* testable here is the part that actually
 * protects the borrower: the hash recorded when the money moved must still
 * match the row today. Each test tampering path below is a plausible insider
 * edit -- change the amount, blank the hash, swap the hash for the proof of
 * another loan.
 */
describe('ledger', () => {
  async function borrowerWithProfile(email = 'borrower@ledger.test'): Promise<Session> {
    const borrower = await register(email, { fullName: 'Grace Wanjiku', role: 'borrower' });
    const profile = await request(app)
      .put('/api/v1/me/profile')
      .set(...authHeader(borrower))
      .send({ nationalId: '23456789', phone: '0712345678', occupation: 'Trader', monthlyIncomeCents: 4_500_000 });
    expect(profile.status).toBe(200);
    return borrower;
  }

  async function lender(email = 'lender@ledger.test'): Promise<Session> {
    return register(email, { fullName: 'Amani Mwangi', role: 'staff', inviteCode: 'smf-staff-invite-change-me', staffId: 'Amani Micro Credit' });
  }

  /** Walks the loan to a cleared disbursement and returns the loan id. */
  async function disbursedLoan(borrower: Session, lenderSession: Session): Promise<string> {
    const created = await request(app).post('/api/v1/loans').set(...authHeader(borrower)).send({
      lenderId: lenderSession.userId,
      principalCents: 500_000,
      termCount: 4,
      frequency: 'weekly',
      purpose: 'Restock my shop',
    });
    expect(created.status).toBe(201);
    const loanId = created.body.loan.id as string;

    expect(
      (
        await request(app)
          .post(`/api/v1/loans/${loanId}/verify`)
          .set(...authHeader(lenderSession))
          .send({ note: 'ID checked in person' })
      ).status,
    ).toBe(200);

    expect(
      (
        await request(app)
          .post(`/api/v1/loans/${loanId}/decision`)
          .set(...authHeader(lenderSession))
          .send({ decision: 'approve', rateBps: 1000 })
      ).status,
    ).toBe(200);

    const disbursed = await request(app)
      .post(`/api/v1/loans/${loanId}/disburse`)
      .set(...authHeader(lenderSession))
      .send({ method: 'mobile_money', mobileTxnCode: 'SJ21AB3XYZ' });
    expect(disbursed.status).toBe(200);
    expect(disbursed.body.held).toBe(false);
    return loanId;
  }

  it('reports the chain as unavailable instead of pretending to be anchored', async () => {
    const borrower = await borrowerWithProfile();
    const response = await request(app).get('/api/v1/ledger/status').set(...authHeader(borrower));

    expect(response.status).toBe(200);
    expect(response.body.chain.enabled).toBe(false);
    expect(response.body.chain.live).toBe(false);
    expect(response.body.chain.contractAddress).toBeNull();

    const anonymous = await request(app).get('/api/v1/ledger/status');
    expect(anonymous.status).toBe(401);
  });

  it('returns an unanchored but internally consistent proof for a disbursement', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const loanId = await disbursedLoan(borrower, lenderSession);

    const response = await request(app).get(`/api/v1/loans/${loanId}/proof`).set(...authHeader(borrower));
    expect(response.status).toBe(200);

    const report = response.body.report;
    expect(report.ok).toBe(true);
    expect(report.loan.ref).toMatch(/^SMF-\d{4}-\d{6}$/);
    expect(report.proofs).toHaveLength(1);

    const proof = report.proofs[0];
    expect(proof.type).toBe('disbursement');
    expect(proof.state).toBe('unanchored');
    expect(proof.recordedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.recomputedHash).toBe(proof.recordedHash);
    expect(proof.onChain).toBeNull();
    expect(report.summary).toEqual({ total: 1, verified: 0, anchoredUnchecked: 0, unanchored: 1, broken: 0 });

    const [row] = await query<{ id: string; occurred_at: Date; mobile_txn_code_norm: string | null }>(
      'SELECT id, occurred_at, mobile_txn_code_norm FROM transactions WHERE loan_id = $1',
      [loanId],
    );
    // The hash is reproducible from the public reference, the row id and the
    // payment details -- no secret material is needed to re-verify it.
    expect(
      hashTransaction({
        txnId: row.id,
        loanRef: report.loan.ref,
        type: 'disbursement',
        amountCents: 500_000,
        occurredAt: row.occurred_at,
        mobileCodeNorm: row.mobile_txn_code_norm,
      }),
    ).toBe(proof.recordedHash);
    expect(report.loanRefHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('flags a payment whose amount was edited after the hash was taken', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const loanId = await disbursedLoan(borrower, lenderSession);

    // An insider lowers the recorded disbursement so the books appear to owe
    // less. The hash was computed over the original amount and now disagrees.
    await query('UPDATE transactions SET amount_cents = 300000 WHERE loan_id = $1', [loanId]);

    const response = await request(app).get(`/api/v1/loans/${loanId}/proof`).set(...authHeader(borrower));
    expect(response.status).toBe(200);
    expect(response.body.report.ok).toBe(false);

    const proof = response.body.report.proofs[0];
    expect(proof.state).toBe('broken');
    expect(proof.problem).toMatch(/does not match the transaction/i);
    expect(proof.recomputedHash).not.toBe(proof.recordedHash);
    expect(response.body.report.summary.broken).toBe(1);
  });

  it('flags a missing payload hash and a substituted hash', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const loanId = await disbursedLoan(borrower, lenderSession);

    await query('UPDATE transactions SET canonical_payload_hash = NULL WHERE loan_id = $1', [loanId]);
    const blank = await request(app).get(`/api/v1/loans/${loanId}/proof`).set(...authHeader(borrower));
    expect(blank.body.report.proofs[0].state).toBe('broken');
    expect(blank.body.report.proofs[0].problem).toMatch(/no payload hash/i);

    // A plausible forgery: copy the hash of another loan's transaction.
    await query('UPDATE transactions SET canonical_payload_hash = repeat($2, 64) WHERE loan_id = $1', [
      loanId,
      'a',
    ]);
    const swapped = await request(app).get(`/api/v1/loans/${loanId}/proof`).set(...authHeader(borrower));
    expect(swapped.body.report.proofs[0].state).toBe('broken');
    expect(swapped.body.report.ok).toBe(false);
  });

  it('includes repayments in the proof trail alongside the disbursement', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const loanId = await disbursedLoan(borrower, lenderSession);

    const repayment = await request(app)
      .post(`/api/v1/loans/${loanId}/repayments`)
      .set(...authHeader(borrower))
      .send({ amountCents: 175_000, method: 'mobile_money', mobileTxnCode: 'TR88QW2LMN' });
    expect(repayment.status).toBe(201);

    const response = await request(app).get(`/api/v1/loans/${loanId}/proof`).set(...authHeader(lenderSession));
    expect(response.status).toBe(200);

    const proofs = response.body.report.proofs;
    expect(proofs.map((proof: { type: string }) => proof.type)).toEqual(['disbursement', 'repayment']);
    expect(proofs.every((proof: { state: string }) => proof.state === 'unanchored')).toBe(true);
    expect(response.body.report.summary.total).toBe(2);
  });

  it('lets an auditor read any proof but hides a loan from an unrelated borrower', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const loanId = await disbursedLoan(borrower, lenderSession);

    const auditor = await createAuditor('auditor@ledger.test');
    const auditorView = await request(app).get(`/api/v1/loans/${loanId}/proof`).set(...authHeader(auditor));
    expect(auditorView.status).toBe(200);
    expect(auditorView.body.report.ok).toBe(true);

    const stranger = await borrowerWithProfile('stranger@ledger.test');
    const strangerView = await request(app).get(`/api/v1/loans/${loanId}/proof`).set(...authHeader(stranger));
    expect(strangerView.status).toBe(404);

    const audits = await query<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'ledger.proof_viewed'",
    );
    expect(audits).toHaveLength(1);
  });

  it('refuses anchoring while no contract is configured, and refuses borrowers outright', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const loanId = await disbursedLoan(borrower, lenderSession);

    const asLender = await request(app)
      .post(`/api/v1/loans/${loanId}/anchor`)
      .set(...authHeader(lenderSession))
      .send({});
    expect(asLender.status).toBe(503);
    expect(asLender.body.error.code).toBe('CHAIN_UNAVAILABLE');

    const asBorrower = await request(app)
      .post(`/api/v1/loans/${loanId}/anchor`)
      .set(...authHeader(borrower))
      .send({});
    expect(asBorrower.status).toBe(403);

    const auditAnchor = await request(app)
      .post('/api/v1/ledger/audit-anchor')
      .set(...authHeader(lenderSession))
      .send({});
    expect(auditAnchor.status).toBe(503);

    const borrowerAuditAnchor = await request(app)
      .post('/api/v1/ledger/audit-anchor')
      .set(...authHeader(borrower))
      .send({});
    expect(borrowerAuditAnchor.status).toBe(403);
  });
});
