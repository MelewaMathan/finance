import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config/env';
import { query } from '../src/db/pool';
import { sha256Hex } from '../src/lib/crypto';
import { authHeader, createAdmin, kraPinForTest, register, request, app, type Session } from './helpers';

/**
 * M2 -- loan application and management.
 *
 * Covers the money maths, the institution-wide authorisation boundaries, the
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
      .send({
        nationalId: '23456789',
        phone: '0712345678',
        occupation: 'Trader',
        monthlyIncomeCents: 4_500_000,
        kraPin: kraPinForTest(email),
      });
    expect(profile.status).toBe(200);
    return borrower;
  }

  async function lender(email = 'lender@loans.test'): Promise<Session> {
    return register(email, { fullName: 'Amani Mwangi', role: 'staff', inviteCode: 'smf-staff-invite-change-me', staffId: 'Amani Micro Credit' });
  }

  async function applyLoan(borrower: Session, overrides: Record<string, unknown> = {}) {
    return request(app)
      .post('/api/v1/loans')
      .set(...authHeader(borrower))
      .send({
        principalCents: 500_000,
        termCount: 4,
        frequency: 'weekly',
        purpose: 'Restock my shop',
        ...overrides,
      });
  }

  async function approvedLoan(borrower: Session, lenderSession: Session, overrides: Record<string, unknown> = {}) {
    const created = await applyLoan(borrower, overrides);
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

    const response = await applyLoan(borrower);
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
    const stored = await query<{ lender_id: string | null }>('SELECT lender_id FROM loans WHERE id = $1', [loan.id]);
    expect(stored[0].lender_id).toBeNull();
  });

  it('ignores a client-sent lenderId and still assigns institution settings', async () => {
    const borrower = await borrowerWithProfile();
    const staff = await lender();
    const response = await applyLoan(borrower, { lenderId: staff.userId });

    expect(response.status).toBe(201);
    expect(response.body.loan.rateBps).toBe(1000);
    const stored = await query<{ lender_id: string | null }>('SELECT lender_id FROM loans WHERE id = $1', [
      response.body.loan.id,
    ]);
    expect(stored[0].lender_id).toBeNull();
  });

  it('keeps stored terms and reads legacy loans after institution settings change', async () => {
    const borrower = await borrowerWithProfile();
    const staff = await lender();
    const applied = await applyLoan(borrower);
    expect(applied.status).toBe(201);

    await query('UPDATE loans SET lender_id = $1 WHERE id = $2', [staff.userId, applied.body.loan.id]);
    await query(
      'UPDATE institution_loan_settings SET interest_rate_bps = 1500, max_principal_cents = 1000000 WHERE id = true',
    );

    const borrowerRead = await request(app)
      .get(`/api/v1/loans/${applied.body.loan.id}`)
      .set(...authHeader(borrower));
    const staffRead = await request(app)
      .get(`/api/v1/loans/${applied.body.loan.id}`)
      .set(...authHeader(staff));
    expect(borrowerRead.status).toBe(200);
    expect(staffRead.status).toBe(200);
    expect(borrowerRead.body.loan).toMatchObject({
      rateBps: 1000,
      termCount: 4,
      totalRepayableCents: 700_000,
    });
  });

  it('refuses applications from staff', async () => {
    const lenderSession = await lender();
    const lenderAttempt = await applyLoan(lenderSession);
    expect(lenderAttempt.status).toBe(403);
  });

  it.each([
    ['nationalId', { nationalId: '' }],
    ['phone', { phone: '' }],
    ['occupation', { occupation: '' }],
    ['monthlyIncomeCents', { monthlyIncomeCents: 0 }],
    ['kraPin', { kraPin: '' }],
  ])('blocks applications when %s is missing before validating or scoring', async (field, clearedField) => {
    const borrower = await borrowerWithProfile(`missing-${field}@loans.test`);
    const update = await request(app)
      .put('/api/v1/me/profile')
      .set(...authHeader(borrower))
      .send(clearedField);
    expect(update.status).toBe(200);

    const response = await request(app)
      .post('/api/v1/loans')
      .set(...authHeader(borrower))
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      code: 'PROFILE_INCOMPLETE',
      message: 'Complete your profile before applying for a loan.',
      missing: [field],
    });
    expect(
      await query('SELECT id FROM loans WHERE borrower_id = $1', [borrower.userId]),
    ).toHaveLength(0);
    expect(
      await query('SELECT id FROM credit_scores WHERE loan_id IN (SELECT id FROM loans WHERE borrower_id = $1)', [
        borrower.userId,
      ]),
    ).toHaveLength(0);

    const blockedAudit = await query<{ detail: { missing: string[] } }>(
      "SELECT detail FROM audit_log WHERE action = 'loan.application_blocked'",
    );
    expect(blockedAudit).toHaveLength(1);
    expect(blockedAudit[0].detail.missing).toEqual([field]);
  });

  it('rejects staff and admins from creating borrower loan applications', async () => {
    const lenderSession = await lender();
    const admin = await createAdmin('admin-loan-attempt@loans.test');
    const staffAttempt = await applyLoan(lenderSession);
    const adminAttempt = await applyLoan(admin);

    expect(staffAttempt.status).toBe(403);
    expect(adminAttempt.status).toBe(403);
    expect(await query('SELECT id FROM loans')).toHaveLength(0);
  });

  it('never exposes a borrower KRA PIN to staff or admins', async () => {
    const email = 'kra-private@loans.test';
    const kraPin = kraPinForTest(email);
    const borrower = await borrowerWithProfile(email);
    const lenderSession = await lender();
    const admin = await createAdmin('kra-private-admin@loans.test');
    const created = await applyLoan(borrower);
    expect(created.status).toBe(201);

    const staffLoans = await request(app).get('/api/v1/loans').set(...authHeader(lenderSession));
    const adminLoans = await request(app).get('/api/v1/loans').set(...authHeader(admin));

    expect(JSON.stringify(staffLoans.body)).not.toContain(kraPin);
    expect(JSON.stringify(adminLoans.body)).not.toContain(kraPin);
  });

  it('enforces institution amount, installment and frequency limits', async () => {
    const borrower = await borrowerWithProfile();
    await query(
      `UPDATE institution_loan_settings
          SET min_principal_cents = 30000, max_principal_cents = 1000000,
              max_installments = 6, allowed_frequencies = ARRAY['weekly']
        WHERE id = true`,
    );

    const tooSmall = await applyLoan(borrower, { principalCents: 29_999 });
    const tooLarge = await applyLoan(borrower, { principalCents: 1_000_001 });
    const tooManyInstallments = await applyLoan(borrower, { termCount: 7 });
    const unavailableFrequency = await applyLoan(borrower, { frequency: 'daily' });
    const valid = await applyLoan(borrower, { principalCents: 30_000, termCount: 6 });
    expect(tooSmall.status).toBe(422);
    expect(tooLarge.status).toBe(422);
    expect(tooManyInstallments.status).toBe(422);
    expect(unavailableFrequency.status).toBe(422);
    expect(valid.status).toBe(201);
  });

  it('shows all institution applications to staff and only each borrower their own', async () => {
    const borrower = await borrowerWithProfile();
    const otherBorrower = await borrowerWithProfile('other@loans.test');
    const lenderSession = await lender();
    const otherStaff = await lender('staff2@loans.test');
    const admin = await createAdmin('admin@loans.test');

    const mine = await applyLoan(borrower);
    expect(mine.status).toBe(201);
    await applyLoan(otherBorrower);

    const ownQueue = await request(app).get('/api/v1/loans').set(...authHeader(lenderSession));
    expect(ownQueue.body.total).toBe(2);
    const otherStaffQueue = await request(app).get('/api/v1/loans').set(...authHeader(otherStaff));
    expect(otherStaffQueue.body.total).toBe(2);

    const stranger = await request(app)
      .get(`/api/v1/loans/${mine.body.loan.id}`)
      .set(...authHeader(otherBorrower));
    expect(stranger.status).toBe(404);

    const borrowerLoans = await request(app).get('/api/v1/loans').set(...authHeader(borrower));
    expect(borrowerLoans.body.total).toBe(1);
    expect(borrowerLoans.body.items[0].id).toBe(mine.body.loan.id);

    const auditView = await request(app).get('/api/v1/loans').set(...authHeader(admin));
    expect(auditView.status).toBe(200);
    expect(auditView.body.total).toBe(2);
  });

  it('requires identity verification before approval', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const created = await applyLoan(borrower);

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
    await query("UPDATE institution_loan_settings SET institution_name = 'Test Institution' WHERE id = true");
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
    expect(bytes.toString('latin1')).toContain('Test Institution');
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
    const created = await applyLoan(borrower);
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
