import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config/env';
import { query } from '../src/db/pool';
import { sha256Hex } from '../src/lib/crypto';
import { authHeader, createAuditor, register, request, app, type Session } from './helpers';

/**
 * M2 -- loan application and management.
 *
 * Covers the money maths, the authorisation boundaries between books, the
 * approve -> PDF agreement -> SHA-256 chain, and the fraud-gated
 * disbursement path (no duplicate receipt may clear).
 */
describe('loans', () => {
  beforeEach(async () => {
    // The shared setup truncates tables before each test.
  });

  async function borrowerWithProfile(email = 'borrower@loans.test'): Promise<Session> {
    const borrower = await register(email, { fullName: 'Grace Wanjiku', role: 'borrower' });
    const profile = await request(app)
      .put('/api/v1/me/profile')
      .set(...authHeader(borrower))
      .send({ nationalId: '23456789', phone: '0712345678', occupation: 'Trader', monthlyIncomeCents: 4_500_000 });
    expect(profile.status).toBe(200);
    return borrower;
  }

  async function lender(email = 'lender@loans.test'): Promise<Session> {
    return register(email, { fullName: 'Amani Mwangi', role: 'staff', inviteCode: 'smf-staff-invite-change-me', staffId: 'Amani Micro Credit' });
  }

  async function applyLoan(borrower: Session, lenderId: string, overrides: Record<string, unknown> = {}) {
    return request(app)
      .post('/api/v1/loans')
      .set(...authHeader(borrower))
      .send({
        lenderId,
        principalCents: 500_000,
        termCount: 4,
        frequency: 'weekly',
        purpose: 'Restock my shop',
        ...overrides,
      });
  }

  async function approvedLoan(borrower: Session, lenderSession: Session, overrides: Record<string, unknown> = {}) {
    const created = await applyLoan(borrower, lenderSession.userId, overrides);
    expect(created.status).toBe(201);
    const loanId = created.body.loan.id as string;

    const verified = await request(app)
      .post(`/api/v1/loans/${loanId}/verify`)
      .set(...authHeader(lenderSession))
      .send({ note: 'ID checked in person' });
    expect(verified.status).toBe(200);

    const decided = await request(app)
      .post(`/api/v1/loans/${loanId}/decision`)
      .set(...authHeader(lenderSession))
      .send({ decision: 'approve', rateBps: 1000, note: 'Approved after review' });
    expect(decided.status).toBe(200);
    return { loanId, loan: decided.body.loan };
  }

  it('creates an application with server-computed totals', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();

    const response = await applyLoan(borrower, lenderSession.userId);
    expect(response.status).toBe(201);

    const loan = response.body.loan;
    expect(loan.status).toBe('pending');
    expect(loan.ref).toMatch(/^SMF-\d{4}-\d{6}$/);
    // 10% flat per weekly period x 4 periods => 500000 + 200000 interest.
    expect(loan.principalCents).toBe(500_000);
    expect(loan.rateBps).toBe(1000);
    expect(loan.totalRepayableCents).toBe(700_000);
    expect(loan.installments).toEqual([]);
    expect(loan.borrower.id).toBe(borrower.userId);
  });

  it('refuses applications from lenders and from incomplete profiles', async () => {
    const lenderSession = await lender();
    const lenderAttempt = await applyLoan(lenderSession, lenderSession.userId);
    expect(lenderAttempt.status).toBe(403);

    const bare = await register('bare@loans.test', { role: 'borrower' });
    const incomplete = await applyLoan(bare, lenderSession.userId);
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.error.message).toMatch(/profile/i);
  });

  it('enforces the lender maximum principal', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    await query('UPDATE lender_profiles SET max_principal_cents = 100000 WHERE user_id = $1', [lenderSession.userId]);

    const response = await applyLoan(borrower, lenderSession.userId, { principalCents: 200_000 });
    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/up to/i);
  });

  it('scopes the queue to each book and hides other borrowers loans', async () => {
    const borrower = await borrowerWithProfile();
    const otherBorrower = await borrowerWithProfile('other@loans.test');
    const lenderSession = await lender();
    const otherLender = await lender('lender2@loans.test');
    const auditor = await createAuditor('auditor@loans.test');

    const mine = await applyLoan(borrower, lenderSession.userId);
    expect(mine.status).toBe(201);
    await applyLoan(otherBorrower, otherLender.userId);

    const ownQueue = await request(app).get('/api/v1/loans').set(...authHeader(lenderSession));
    expect(ownQueue.body.total).toBe(1);
    expect(ownQueue.body.items[0].id).toBe(mine.body.loan.id);

    const stranger = await request(app)
      .get(`/api/v1/loans/${mine.body.loan.id}`)
      .set(...authHeader(otherBorrower));
    expect(stranger.status).toBe(404);

    const auditView = await request(app).get('/api/v1/loans').set(...authHeader(auditor));
    expect(auditView.status).toBe(200);
    expect(auditView.body.total).toBe(2);
  });

  it('requires identity verification before approval', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const created = await applyLoan(borrower, lenderSession.userId);

    const early = await request(app)
      .post(`/api/v1/loans/${created.body.loan.id}/decision`)
      .set(...authHeader(lenderSession))
      .send({ decision: 'approve', rateBps: 800 });

    expect(early.status).toBe(409);
    expect(early.body.error.message).toMatch(/verify/i);
  });

  it('approving writes a schedule that sums exactly to the total and a hashed PDF', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const { loanId, loan } = await approvedLoan(borrower, lenderSession);

    expect(loan.status).toBe('approved');
    expect(loan.installments).toHaveLength(4);

    const scheduled = loan.installments.reduce(
      (sum: number, row: { principalDueCents: number; interestDueCents: number }) =>
        sum + row.principalDueCents + row.interestDueCents,
      0,
    );
    expect(scheduled).toBe(700_000);
    expect(loan.installments[0]).toMatchObject({ seq: 1, status: 'pending' });
    expect(loan.summary.outstandingCents).toBe(700_000);

    const documents = await query<{ sha256: string; file_path: string }>(
      'SELECT sha256, file_path FROM documents WHERE loan_id = $1',
      [loanId],
    );
    expect(documents).toHaveLength(1);
    expect(documents[0].file_path).toBe(`agreements/${loanId}.pdf`);

    const download = await request(app)
      .get(`/api/v1/loans/${loanId}/agreement`)
      .set(...authHeader(borrower))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.headers['x-document-sha256']).toBe(documents[0].sha256);

    const bytes = download.body as Buffer;
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    // The stored fingerprint must match the bytes actually served.
    expect(sha256Hex(bytes)).toBe(documents[0].sha256);
    expect(loan.agreement?.sha256).toBe(documents[0].sha256);

    const downloadAudit = await query<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'document.agreement_downloaded'",
    );
    expect(downloadAudit).toHaveLength(1);
  });

  it('refuses to serve an agreement whose bytes no longer match the recorded hash', async () => {
    const borrower = await borrowerWithProfile('borrower@tamper.test');
    const lenderSession = await lender('lender@tamper.test');
    const { loanId } = await approvedLoan(borrower, lenderSession);

    const [doc] = await query<{ sha256: string; file_path: string }>(
      'SELECT sha256, file_path FROM documents WHERE loan_id = $1',
      [loanId],
    );
    const absolute = path.resolve(config.storageDir, doc.file_path);
    const original = fs.readFileSync(absolute);

    // Same length, one flipped byte: the most plausible swap -- a different
    // file would usually differ in size and be caught incidentally.
    const tampered = Buffer.from(original);
    tampered[tampered.length - 20] ^= 0xff;
    fs.writeFileSync(absolute, tampered);

    try {
      const download = await request(app)
        .get(`/api/v1/loans/${loanId}/agreement`)
        .set(...authHeader(borrower));

      expect(download.status).toBe(409);
      expect(download.body.error.code).toBe('CONFLICT');

      const violations = await query<{ detail: { expectedSha256: string; actualSha256: string } }>(
        "SELECT detail FROM audit_log WHERE action = 'document.integrity_violation'",
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].detail.expectedSha256).toBe(doc.sha256);
      expect(violations[0].detail.actualSha256).not.toBe(doc.sha256);
    } finally {
      fs.writeFileSync(absolute, original);
    }
  });

  it('rejects with a note and refuses a second decision', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const created = await applyLoan(borrower, lenderSession.userId);
    const loanId = created.body.loan.id;

    const rejected = await request(app)
      .post(`/api/v1/loans/${loanId}/decision`)
      .set(...authHeader(lenderSession))
      .send({ decision: 'reject', note: 'Income cannot be verified' });

    expect(rejected.status).toBe(200);
    expect(rejected.body.loan.status).toBe('rejected');
    expect(rejected.body.loan.decisionNote).toBe('Income cannot be verified');
    expect(rejected.body.loan.installments).toEqual([]);

    const again = await request(app)
      .post(`/api/v1/loans/${loanId}/decision`)
      .set(...authHeader(lenderSession))
      .send({ decision: 'reject' });
    expect(again.status).toBe(409);
  });

  it('disburses once, stores a 64-hex payload hash and refuses a repeat', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const { loanId } = await approvedLoan(borrower, lenderSession);

    const disbursed = await request(app)
      .post(`/api/v1/loans/${loanId}/disburse`)
      .set(...authHeader(lenderSession))
      .send({ method: 'mobile_money', mobileTxnCode: 'SJ21AB3XYZ' });

    expect(disbursed.status).toBe(200);
    expect(disbursed.body.held).toBe(false);
    expect(disbursed.body.loan.status).toBe('disbursed');
    expect(disbursed.body.loan.transactions).toHaveLength(1);

    const txn = disbursed.body.loan.transactions[0];
    expect(txn.status).toBe('cleared');
    expect(txn.hash).toMatch(/^[0-9a-f]{64}$/);
    // No contract is deployed in tests, so the record is honestly unanchored.
    expect(txn.onchain.anchored).toBe(false);

    const repeat = await request(app)
      .post(`/api/v1/loans/${loanId}/disburse`)
      .set(...authHeader(lenderSession))
      .send({ method: 'cash' });
    expect(repeat.status).toBe(409);
  });

  it('rejects a malformed mobile-money reference before creating money movement', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const { loanId } = await approvedLoan(borrower, lenderSession);

    const response = await request(app)
      .post(`/api/v1/loans/${loanId}/disburse`)
      .set(...authHeader(lenderSession))
      .send({ method: 'mobile_money', mobileTxnCode: 'FAKE123' });

    expect(response.status).toBe(400);
    const txns = await query('SELECT id FROM transactions WHERE loan_id = $1', [loanId]);
    expect(txns).toHaveLength(0);
  });

  it('holds a disbursement that reuses a mobile-money receipt from another loan', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();

    const first = await approvedLoan(borrower, lenderSession, { purpose: 'First loan' });
    const firstDisbursement = await request(app)
      .post(`/api/v1/loans/${first.loanId}/disburse`)
      .set(...authHeader(lenderSession))
      .send({ method: 'mobile_money', mobileTxnCode: 'QK49PZ1ABC' });
    expect(firstDisbursement.body.held).toBe(false);

    const second = await approvedLoan(borrower, lenderSession, { purpose: 'Second loan' });
    const secondDisbursement = await request(app)
      .post(`/api/v1/loans/${second.loanId}/disburse`)
      .set(...authHeader(lenderSession))
      .send({ method: 'mobile_money', mobileTxnCode: 'QK49PZ1ABC' });

    expect(secondDisbursement.status).toBe(200);
    expect(secondDisbursement.body.held).toBe(true);
    expect(secondDisbursement.body.loan.status).toBe('held');
    expect(secondDisbursement.body.loan.heldReason).toMatch(/duplicate/i);

    const flags = await query<{ flag_type: string; severity: string }>(
      'SELECT flag_type, severity FROM fraud_flags WHERE loan_id = $1',
      [second.loanId],
    );
    expect(flags).toEqual([{ flag_type: 'duplicate_txn_code', severity: 'critical' }]);

    const alerts = await query('SELECT id FROM alerts WHERE user_id = $1', [lenderSession.userId]);
    expect(alerts.length).toBeGreaterThan(0);
  });
});
