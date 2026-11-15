import { describe, expect, it } from 'vitest';
import { query } from '../src/db/pool';
import { authHeader, createAuditor, register, request, app, type Session } from './helpers';

/**
 * M7 -- forensic dashboard.
 *
 * Three claims are tested here, one per page of the auditor's dashboard:
 * the log answers "what happened" and can be searched; the timeline puts one
 * loan's events in order; and an integrity run detects an edit made straight
 * in the database, both in the audit chain and in a payment row.
 *
 * The tamper tests deliberately disable the guard trigger, which is the same
 * thing an attacker with DDL rights would have to do. If detection only worked
 * while the trigger was enabled it would be worthless.
 */
describe('forensic dashboard', () => {
  async function borrowerWithProfile(email = 'grace@forensics.test'): Promise<Session> {
    const borrower = await register(email, { fullName: 'Grace Wanjiku', role: 'borrower' });
    const profile = await request(app)
      .put('/api/v1/me/profile')
      .set(...authHeader(borrower))
      .send({ nationalId: '23456789', phone: '0712345678', occupation: 'Trader', monthlyIncomeCents: 4_500_000 });
    expect(profile.status).toBe(200);
    return borrower;
  }

  async function lender(email = 'lender@forensics.test'): Promise<Session> {
    return register(email, { fullName: 'Amani Mwangi', role: 'staff', inviteCode: 'smf-staff-invite-change-me', staffId: 'Amani Micro Credit' });
  }

  /** A loan with a disbursement and one repayment: enough events to order. */
  async function activity(borrower: Session, lenderSession: Session): Promise<{ loanId: string; ref: string }> {
    const created = await request(app).post('/api/v1/loans').set(...authHeader(borrower)).send({
      lenderId: lenderSession.userId,
      principalCents: 400_000,
      termCount: 4,
      frequency: 'weekly',
      purpose: 'Restock my shop',
    });
    expect(created.status).toBe(201);
    const loan = created.body.loan as { id: string; ref: string };

    expect(
      (
        await request(app)
          .post(`/api/v1/loans/${loan.id}/verify`)
          .set(...authHeader(lenderSession))
          .send({ note: 'ID checked in person' })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`/api/v1/loans/${loan.id}/decision`)
          .set(...authHeader(lenderSession))
          .send({ decision: 'approve', rateBps: 1200 })
      ).status,
    ).toBe(200);
    const disbursed = await request(app)
      .post(`/api/v1/loans/${loan.id}/disburse`)
      .set(...authHeader(lenderSession))
      .send({ method: 'cash' });
    expect(disbursed.status).toBe(200);
    expect(disbursed.body.held).toBe(false);

    const repaid = await request(app)
      .post(`/api/v1/loans/${loan.id}/repayments`)
      .set(...authHeader(borrower))
      .send({ amountCents: 50_000, method: 'cash' });
    expect(repaid.status).toBe(201);

    return loan;
  }

  it('keeps every forensic surface auditor-only', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const auditor = await createAuditor('auditor@forensics.test');

    const anonymous = await request(app).get('/api/v1/audit/logs');
    expect(anonymous.status).toBe(401);

    const asLender = await request(app).get('/api/v1/audit/logs').set(...authHeader(lenderSession));
    expect(asLender.status).toBe(403);

    const asBorrower = await request(app).get('/api/v1/audit/logs').set(...authHeader(borrower));
    expect(asBorrower.status).toBe(403);

    const integrityAsLender = await request(app)
      .post('/api/v1/integrity/check')
      .set(...authHeader(lenderSession))
      .send({ scope: 'audit_chain' });
    expect(integrityAsLender.status).toBe(403);

    const csvAsBorrower = await request(app).get('/api/v1/audit/export.csv').set(...authHeader(borrower));
    expect(csvAsBorrower.status).toBe(403);

    const asAuditor = await request(app).get('/api/v1/audit/logs').set(...authHeader(auditor));
    expect(asAuditor.status).toBe(200);
  });

  it('searches the log by action, entity and free text, newest first', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const loan = await activity(borrower, lenderSession);
    const auditor = await createAuditor();

    const byAction = await request(app)
      .get('/api/v1/audit/logs?action=loan.disbursed')
      .set(...authHeader(auditor));
    expect(byAction.status).toBe(200);
    expect(byAction.body.total).toBeGreaterThanOrEqual(1);
    expect(byAction.body.items.every((row: { action: string }) => row.action === 'loan.disbursed')).toBe(true);

    // Newest first: the array is ordered by descending seq.
    const all = await request(app).get('/api/v1/audit/logs?pageSize=100').set(...authHeader(auditor));
    expect(all.status).toBe(200);
    const seqs = all.body.items.map((row: { seq: number }) => row.seq);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => b - a));

    const byEntity = await request(app)
      .get(`/api/v1/audit/logs?entityId=${loan.id}`)
      .set(...authHeader(auditor));
    expect(byEntity.status).toBe(200);
    expect(byEntity.body.items.length).toBeGreaterThanOrEqual(4);
    expect(
      byEntity.body.items.some((row: { action: string }) => row.action === 'loan.application_submitted'),
    ).toBe(true);

    const byActor = await request(app)
      .get(`/api/v1/audit/logs?actorId=${borrower.userId}`)
      .set(...authHeader(auditor));
    expect(byActor.status).toBe(200);
    expect(byActor.body.items.every((row: { actorRole: string }) => row.actorRole === 'borrower')).toBe(true);

    const freeText = await request(app)
      .get('/api/v1/audit/logs?q=disburs')
      .set(...authHeader(auditor));
    expect(freeText.status).toBe(200);
    expect(freeText.body.total).toBeGreaterThanOrEqual(1);

    // A LIKE wildcard typed by a human is literal text, not a match-all.
    const literalPercent = await request(app)
      .get('/api/v1/audit/logs?q=%25')
      .set(...authHeader(auditor));
    expect(literalPercent.status).toBe(200);
    expect(literalPercent.body.total).toBe(0);
  });

  it('lists action names for the filter and rejects a backwards date range', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    await activity(borrower, lenderSession);
    const auditor = await createAuditor();

    const actions = await request(app).get('/api/v1/audit/actions').set(...authHeader(auditor));
    expect(actions.status).toBe(200);
    const names = actions.body.actions.map((row: { action: string }) => row.action);
    expect(names).toContain('loan.disbursed');
    expect(names).toContain('repayment.recorded');

    const today = new Date().toISOString().slice(0, 10);
    const todayOnly = await request(app)
      .get(`/api/v1/audit/logs?from=${today}&to=${today}`)
      .set(...authHeader(auditor));
    expect(todayOnly.status).toBe(200);
    expect(todayOnly.body.total).toBeGreaterThan(0);

    const backwards = await request(app)
      .get('/api/v1/audit/logs?from=2026-11-12&to=2026-11-01')
      .set(...authHeader(auditor));
    expect(backwards.status).toBe(400);

    const badDate = await request(app)
      .get('/api/v1/audit/logs?from=yesterday')
      .set(...authHeader(auditor));
    expect(badDate.status).toBe(400);
  });

  it('builds one chronological timeline from every table that knows part of the loan', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const loan = await activity(borrower, lenderSession);
    const auditor = await createAuditor();

    const response = await request(app)
      .get(`/api/v1/audit/timeline?loanId=${loan.id}`)
      .set(...authHeader(auditor));
    expect(response.status).toBe(200);
    expect(response.body.loan.id).toBe(loan.id);

    const events = response.body.events as Array<{ at: string; kind: string; title: string; hash?: string | null }>;
    expect(events.length).toBeGreaterThan(5);

    const times = events.map((event) => event.at);
    expect(times).toEqual([...times].sort());

    expect(events.some((event) => event.kind === 'transaction')).toBe(true);
    expect(events.some((event) => event.kind === 'document')).toBe(true);
    expect(events.some((event) => event.title === 'loan.disbursed')).toBe(true);

    // The payment row carries the hash that the ledger anchored.
    const payment = events.find((event) => event.kind === 'transaction');
    expect(payment?.hash).toMatch(/^[0-9a-f]{64}$/);

    // A dispute file quotes the reference, so the timeline accepts that too.
    const byRef = await request(app)
      .get(`/api/v1/audit/timeline?ref=${encodeURIComponent(loan.ref)}`)
      .set(...authHeader(auditor));
    expect(byRef.status).toBe(200);
    expect(byRef.body.loan.id).toBe(loan.id);

    const unknown = await request(app)
      .get('/api/v1/audit/timeline?loanId=11111111-1111-4111-8111-111111111111')
      .set(...authHeader(auditor));
    expect(unknown.status).toBe(404);

    const malformed = await request(app).get('/api/v1/audit/timeline?loanId=1').set(...authHeader(auditor));
    expect(malformed.status).toBe(400);
  });

  it('records an integrity run, and a run over an edited audit row reports tampering', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    await activity(borrower, lenderSession);
    const auditor = await createAuditor();

    const clean = await request(app)
      .post('/api/v1/integrity/check')
      .set(...authHeader(auditor))
      .send({ scope: 'audit_chain' });
    expect(clean.status).toBe(200);
    expect(clean.body.check.result).toBe('ok');
    expect(clean.body.check.recordsChecked).toBeGreaterThan(0);
    expect(clean.body.check.mismatches).toBe(0);
    expect(clean.body.check.id).toMatch(/^[0-9a-f-]{36}$/);

    // An insider with DDL rights disables the guard and rewrites history.
    await query('ALTER TABLE audit_log DISABLE TRIGGER USER');
    await query("UPDATE audit_log SET action = 'loan.application_submitted' WHERE action = 'loan.disbursed'");
    await query('ALTER TABLE audit_log ENABLE TRIGGER USER');

    const tampered = await request(app)
      .post('/api/v1/integrity/check')
      .set(...authHeader(auditor))
      .send({ scope: 'audit_chain' });
    expect(tampered.status).toBe(200);
    expect(tampered.body.check.result).toBe('tampered');
    expect(tampered.body.check.mismatches).toBeGreaterThan(0);
    const problems = tampered.body.check.detail.chain.mismatches as Array<{ reason: string }>;
    expect(problems.some((problem) => problem.reason === 'hash_mismatch')).toBe(true);

    const history = await request(app).get('/api/v1/integrity/checks').set(...authHeader(auditor));
    expect(history.status).toBe(200);
    expect(history.body.checks[0].result).toBe('tampered');
    expect(history.body.checks.some((row: { result: string }) => row.result === 'ok')).toBe(true);
    expect(history.body.checks[0].runBy).toBe('Forensic Auditor');

    const audited = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE action = 'integrity.check_run'",
    );
    expect(Number(audited[0].count)).toBeGreaterThanOrEqual(2);
  });

  it('detects an edited payment when the check is scoped to one loan', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    const loan = await activity(borrower, lenderSession);
    const auditor = await createAuditor();

    const clean = await request(app)
      .post('/api/v1/integrity/check')
      .set(...authHeader(auditor))
      .send({ scope: 'loan', targetId: loan.id });
    expect(clean.status).toBe(200);
    expect(clean.body.check.result).toBe('ok');
    expect(clean.body.check.detail.loanCount).toBe(1);
    expect(clean.body.check.recordsChecked).toBeGreaterThan(0);

    // The same check by reference, for a dispute file that quotes the ref.
    const byRef = await request(app)
      .post('/api/v1/integrity/check')
      .set(...authHeader(auditor))
      .send({ scope: 'loan', ref: loan.ref });
    expect(byRef.status).toBe(200);
    expect(byRef.body.check.result).toBe('ok');
    expect(byRef.body.check.targetId).toBe(loan.id);

    // Change the amount the borrower was actually given, leaving the hash alone.
    await query('UPDATE transactions SET amount_cents = amount_cents + 100000 WHERE loan_id = $1', [loan.id]);

    const tampered = await request(app)
      .post('/api/v1/integrity/check')
      .set(...authHeader(auditor))
      .send({ scope: 'loan', targetId: loan.id });
    expect(tampered.status).toBe(200);
    expect(tampered.body.check.result).toBe('tampered');
    expect(tampered.body.check.mismatches).toBeGreaterThan(0);

    const missingTarget = await request(app)
      .post('/api/v1/integrity/check')
      .set(...authHeader(auditor))
      .send({ scope: 'loan' });
    expect(missingTarget.status).toBe(400);

    const unknownLoan = await request(app)
      .post('/api/v1/integrity/check')
      .set(...authHeader(auditor))
      .send({ scope: 'loan', targetId: '11111111-1111-4111-8111-111111111111' });
    expect(unknownLoan.status).toBe(404);
  });

  it('exports the filtered log as CSV and PDF, carrying its own verification state', async () => {
    const borrower = await borrowerWithProfile();
    const lenderSession = await lender();
    await activity(borrower, lenderSession);
    const auditor = await createAuditor();

    const csv = await request(app)
      .get('/api/v1/audit/export.csv?q=loan.')
      .set(...authHeader(auditor));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('audit-log-');
    expect(csv.headers['x-document-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(csv.text).toContain('Chain verified,yes');
    expect(csv.text).toContain('seq,created_at,actor_role,actor,action');
    expect(csv.text).toContain('loan.application_submitted');

    const pdf = await request(app)
      .get('/api/v1/audit/export.pdf')
      .set(...authHeader(auditor));
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');

    // The act of exporting is itself an audited action, with the chain head.
    const exported = await query<{ detail: { format: string; chainOk: boolean } }>(
      "SELECT detail FROM audit_log WHERE action = 'audit.exported' ORDER BY seq ASC",
    );
    expect(exported).toHaveLength(2);
    expect(exported.map((row) => row.detail.format)).toEqual(['csv', 'pdf']);
    expect(exported.every((row) => row.detail.chainOk === true)).toBe(true);
  });
});
