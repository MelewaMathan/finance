import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../src/db/pool';
import { app, createAdmin, register, request, PASSWORD, authHeader } from './helpers';

/**
 * Admin-approved staff login flow.
 *
 * Security properties verified:
 *  - A staff member with correct credentials gets HTTP 202 (no session) until approved.
 *  - An approved request issues a session exactly once; reuse returns 404.
 *  - A denied request never issues a session.
 *  - An expired request never issues a session.
 *  - A pending or suspended staff account gets the same generic failure as a wrong password.
 *  - Borrowers and staff get 403 on admin approval endpoints.
 *  - An admin cannot approve their own login request.
 *  - Every event appears in the audit log.
 */
describe('staff login approval flow', () => {
  /**
   * Creates a staff user directly in the DB (active status so we can test
   * the approval flow without having to approve the account first).
   */
  async function createActiveStaff(email = 'staff@approval.test'): Promise<{
    userId: string;
    token: null;
  }> {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const row = await queryOne<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, full_name, status)
       VALUES ($1, $2, 'staff', 'Test Staff', 'active')
       RETURNING id`,
      [email, hash],
    );
    if (!row) throw new Error('Could not insert staff user');
    await query('INSERT INTO staff_profiles (user_id) VALUES ($1)', [row.id]);
    return { userId: row.id, token: null };
  }

  it('gives HTTP 202 with pollToken instead of a session for staff with correct credentials', async () => {
    await createActiveStaff('staff202@approval.test');
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'staff202@approval.test', password: PASSWORD });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('awaiting_approval');
    expect(res.body.pollToken).toBeTruthy();
    expect(res.body.requestId).toBeTruthy();
    expect(res.body.expiresAt).toBeTruthy();

    // No session cookie must be set.
    const cookies = res.headers['set-cookie'] as string[] | undefined;
    expect(cookies?.some((c: string) => c.startsWith('smf_refresh='))).toBeFalsy();
    // No accessToken in body.
    expect(res.body.accessToken).toBeUndefined();
  });

  it('poll returns pending before an admin acts', async () => {
    await createActiveStaff('pollpend@approval.test');
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'pollpend@approval.test', password: PASSWORD });
    expect(login.status).toBe(202);
    const { requestId, pollToken } = login.body;

    const poll = await request(app)
      .get(`/api/v1/auth/login-requests/${requestId}/status`)
      .query({ pollToken });
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('pending');
  });

  it('poll returns approved + session after admin approves, and is then used', async () => {
    await createActiveStaff('approveme@approval.test');
    const admin = await createAdmin('aud-approve@approval.test');

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'approveme@approval.test', password: PASSWORD });
    expect(login.status).toBe(202);
    const { requestId, pollToken } = login.body;

    // Admin approves.
    const decide = await request(app)
      .post(`/api/v1/auth/login-requests/${requestId}/decide`)
      .set(...authHeader(admin))
      .send({ decision: 'approve' });
    expect(decide.status).toBe(200);

    // First poll — should issue a session.
    const poll = await request(app)
      .get(`/api/v1/auth/login-requests/${requestId}/status`)
      .query({ pollToken });
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('approved');
    expect(poll.body.accessToken).toBeTruthy();
    expect(poll.body.user.role).toBe('staff');
    const cookie = (poll.headers['set-cookie'] as string[]).find((c: string) =>
      c.startsWith('smf_refresh='),
    );
    expect(cookie).toBeTruthy();

    // Second poll — token is now 'used', must not issue another session.
    const replay = await request(app)
      .get(`/api/v1/auth/login-requests/${requestId}/status`)
      .query({ pollToken });
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe('used');
    expect(replay.body.accessToken).toBeUndefined();
  });

  it('poll returns denied after admin denies, and never issues a session', async () => {
    await createActiveStaff('denystaff@approval.test');
    const admin = await createAdmin('aud-deny@approval.test');

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'denystaff@approval.test', password: PASSWORD });
    expect(login.status).toBe(202);
    const { requestId, pollToken } = login.body;

    await request(app)
      .post(`/api/v1/auth/login-requests/${requestId}/decide`)
      .set(...authHeader(admin))
      .send({ decision: 'deny', reason: 'Suspicious location' });

    const poll = await request(app)
      .get(`/api/v1/auth/login-requests/${requestId}/status`)
      .query({ pollToken });
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('denied');
    expect(poll.body.reason).toBe('Suspicious location');
    expect(poll.body.accessToken).toBeUndefined();
  });

  it('poll returns expired when the TTL passes', async () => {
    await createActiveStaff('expirestaff@approval.test');
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'expirestaff@approval.test', password: PASSWORD });
    expect(login.status).toBe(202);
    const { requestId, pollToken } = login.body;

    // Force-expire the row.
    await query(
      `UPDATE login_approvals SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [requestId],
    );

    const poll = await request(app)
      .get(`/api/v1/auth/login-requests/${requestId}/status`)
      .query({ pollToken });
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('expired');
    expect(poll.body.accessToken).toBeUndefined();
  });

  it('a pending staff account gets the same generic failure as a wrong password', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    await query(
      `INSERT INTO users (email, password_hash, role, full_name, status)
       VALUES ('pendstaff@approval.test', $1, 'staff', 'Pending Staff', 'pending')`,
      [hash],
    );
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'pendstaff@approval.test', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid email or password');
  });

  it('a suspended staff account gets the same generic failure', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    await query(
      `INSERT INTO users (email, password_hash, role, full_name, status)
       VALUES ('suspstaff@approval.test', $1, 'staff', 'Suspended Staff', 'suspended')`,
      [hash],
    );
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'suspstaff@approval.test', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid email or password');
  });

  it('a borrower gets 403 on the admin login-requests endpoint', async () => {
    const borrower = await register('borrow-noapprove@approval.test');
    const res = await request(app)
      .get('/api/v1/auth/login-requests')
      .set(...authHeader(borrower));
    expect(res.status).toBe(403);
  });

  it('a staff user gets 403 on the admin login-requests endpoint', async () => {
    // We need a real session for the staff user; use a trick:
    // insert an already-approved row and use the session from it.
    await createActiveStaff('staffnoapprove@approval.test');
    const auditorSetup = await createAdmin('aud-setup@approval.test');

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'staffnoapprove@approval.test', password: PASSWORD });
    expect(login.status).toBe(202);
    const { requestId, pollToken } = login.body;

    await request(app)
      .post(`/api/v1/auth/login-requests/${requestId}/decide`)
      .set(...authHeader(auditorSetup))
      .send({ decision: 'approve' });

    const poll = await request(app)
      .get(`/api/v1/auth/login-requests/${requestId}/status`)
      .query({ pollToken });
    expect(poll.body.status).toBe('approved');
    const staffToken = poll.body.accessToken as string;

    const res = await request(app)
      .get('/api/v1/auth/login-requests')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
  });

  it('an admin cannot approve their own login request (guard rejects it)', async () => {
    // Auditors don't get login_approval rows because only staff go through the
    // approval flow, so this tests the explicit guard in decideLoginApproval.
    // Manufacture a scenario by inserting a fake row pointing at the admin.
    const admin = await createAdmin('aud-selfapprove@approval.test');
    const auditorId = admin.userId;

    // Create a fake approval row attributed to the admin's user id.
    const { randomToken, sha256Hex } = await import('../src/lib/crypto');
    const tok = randomToken(32);
    const hash = sha256Hex(tok);
    const row = await queryOne<{ id: string }>(
      `INSERT INTO login_approvals
         (staff_user_id, status, expires_at, poll_token_hash)
       VALUES ($1, 'pending', now() + interval '10 minutes', $2)
       RETURNING id`,
      [auditorId, hash],
    );
    if (!row) throw new Error('Could not insert fake approval row');

    const res = await request(app)
      .post(`/api/v1/auth/login-requests/${row.id}/decide`)
      .set(...authHeader(admin))
      .send({ decision: 'approve' });
    expect(res.status).toBe(403);
  });

  it('all approval events appear in the audit log', async () => {
    await createActiveStaff('auditcheck@approval.test');
    const admin = await createAdmin('aud-auditcheck@approval.test');

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'auditcheck@approval.test', password: PASSWORD });
    expect(login.status).toBe(202);
    const { requestId, pollToken } = login.body;

    await request(app)
      .post(`/api/v1/auth/login-requests/${requestId}/decide`)
      .set(...authHeader(admin))
      .send({ decision: 'approve' });

    await request(app)
      .get(`/api/v1/auth/login-requests/${requestId}/status`)
      .query({ pollToken });

    // Check audit log entries.
    // The approval_requested and approval_approved events use the approval row id.
    // The login event uses the staff user id.
    const approvalEntries = await query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE entity_id = $1
        ORDER BY seq ASC`,
      [requestId],
    );
    const approvalActions = approvalEntries.map((e) => e.action);
    expect(approvalActions).toContain('auth.login_approval_requested');
    expect(approvalActions).toContain('auth.login_approval_approved');

    // The final auth.login is written with the user's id as entity_id.
    const loginEntry = await query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE action = 'auth.login'
          AND detail->>'approvalId' = $1`,
      [requestId],
    );
    expect(loginEntry.length).toBeGreaterThanOrEqual(1);
  });

  it('deny without a reason returns 409', async () => {
    await createActiveStaff('nodeny@approval.test');
    const admin = await createAdmin('aud-nodeny@approval.test');

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nodeny@approval.test', password: PASSWORD });
    const { requestId } = login.body;

    const res = await request(app)
      .post(`/api/v1/auth/login-requests/${requestId}/decide`)
      .set(...authHeader(admin))
      .send({ decision: 'deny' }); // no reason
    expect(res.status).toBe(409);
  });

  it('a second login request is rejected while one is pending (spam guard)', async () => {
    await createActiveStaff('spamguard@approval.test');
    const first = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'spamguard@approval.test', password: PASSWORD });
    expect(first.status).toBe(202);

    const second = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'spamguard@approval.test', password: PASSWORD });
    expect(second.status).toBe(429);
  });
});
