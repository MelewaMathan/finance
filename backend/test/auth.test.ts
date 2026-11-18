import { describe, expect, it } from 'vitest';
import { query, queryOne } from '../src/db/pool';
import { app, authHeader, createAdmin, login, PASSWORD, refreshCookie, register, request } from './helpers';

/**
 * M1 -- authentication.
 *
 * These tests cover the properties the security report claims: password
 * hashing, generic error messages, lockout, refresh-token rotation with reuse
 * detection, and server-side session revocation.
 */
describe('authentication', () => {
  it('registers a borrower, hashes the password and sets an httpOnly refresh cookie', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'Grace@Test.Local', password: PASSWORD, fullName: 'Grace Test', role: 'borrower' });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe('grace@test.local');
    expect(response.body.user.role).toBe('borrower');
    expect(response.body.accessToken).toBeTruthy();

    // The response must never echo the hash.
    expect(JSON.stringify(response.body)).not.toContain('password');
    expect(JSON.stringify(response.body)).not.toContain(PASSWORD);

    const stored = await queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = $1', [
      'grace@test.local',
    ]);
    expect(stored?.password_hash).toMatch(/^\$2[aby]\$/);
    expect(stored?.password_hash).not.toBe(PASSWORD);

    const cookieHeader = (response.headers['set-cookie'] as unknown as string[])[0];
    expect(cookieHeader).toContain('smf_refresh=');
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('SameSite=Strict');
  });

  it('refuses to self-register an admin account (role "admin" rejected)', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'sneaky@test.local', password: PASSWORD, fullName: 'Sneaky', role: 'admin' });

    expect(response.status).toBe(400);
  });

  it('rejects staff registration with an invalid invite code', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: 'bad-invite@test.local',
        password: PASSWORD,
        fullName: 'Bad Invite',
        role: 'staff',
        inviteCode: 'not-the-invite-code',
      });

    expect(response.status).toBe(401);
    const row = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', ['bad-invite@test.local']);
    expect(row).toBeNull();
  });

  it('keeps new staff pending and issues no session until an admin approves the account', async () => {
    const registration = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: 'pending-staff@test.local',
        password: PASSWORD,
        fullName: 'Pending Staff',
        role: 'staff',
        inviteCode: 'smf-staff-invite-change-me',
      });

    expect(registration.status).toBe(202);
    expect(registration.body.status).toBe('pending_approval');
    expect(registration.body.accessToken).toBeUndefined();
    expect(registration.headers['set-cookie']).toBeUndefined();

    const staffId = registration.body.user.id as string;
    const row = await queryOne<{ status: string }>('SELECT status FROM users WHERE id = $1', [staffId]);
    expect(row?.status).toBe('pending');

    const beforeApproval = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'pending-staff@test.local', password: PASSWORD });
    expect(beforeApproval.status).toBe(401);

    const admin = await createAdmin('approve-pending-staff@test.local');
    const approval = await request(app)
      .post(`/api/v1/auth/staff-accounts/${staffId}/status`)
      .set(...authHeader(admin))
      .send({ action: 'approve-account' });
    expect(approval.status).toBe(200);

    const afterApproval = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'pending-staff@test.local', password: PASSWORD });
    expect(afterApproval.status).toBe(202);
    expect(afterApproval.body.status).toBe('awaiting_approval');
  });

  it('the single login endpoint works for all roles and returns the correct role', async () => {
    // Borrower
    const borrower = await register('brole@test.local');
    const borrowerLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'brole@test.local', password: PASSWORD });
    expect(borrowerLogin.status).toBe(200);
    expect(borrowerLogin.body.user.role).toBe('borrower');
    const borrowerLoginAudit = await query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'auth.login'`,
      [borrower.userId],
    );
    expect(borrowerLoginAudit.length).toBeGreaterThan(0);

    // Admin
    const admin = await createAdmin('arole@test.local');
    const adminLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'arole@test.local', password: PASSWORD });
    expect(adminLogin.status).toBe(200);
    expect(adminLogin.body.user.role).toBe('admin');
    // must_change_password is false in createAdmin (uses must_change_password=false for tests)
    expect(typeof adminLogin.body.mustChangePassword).toBe('boolean');
  });

  it('login returns mustChangePassword=true when the flag is set', async () => {
    // Insert a user with must_change_password = true
    const hash = await (await import('bcryptjs')).default.hash(PASSWORD, 10);
    await (await import('../src/db/pool')).queryOne(
      `INSERT INTO users (email, password_hash, role, full_name, must_change_password)
       VALUES ('mcp@test.local', $1, 'admin', 'MCP Admin', true)`,
      [hash],
    );
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'mcp@test.local', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(true);

    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie(res));
    expect(rotated.status).toBe(200);
    expect(rotated.body.mustChangePassword).toBe(true);
  });

  it('force-change-password clears the flag and revokes all sessions', async () => {
    const { queryOne: qOne } = await import('../src/db/pool');
    const bcryptjs = (await import('bcryptjs')).default;
    const hash = await bcryptjs.hash(PASSWORD, 10);
    await qOne(
      `INSERT INTO users (email, password_hash, role, full_name, must_change_password)
       VALUES ('fcp@test.local', $1, 'admin', 'FCP Admin', true)`,
      [hash],
    );
    const session = await login('fcp@test.local');

    const blocked = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${session.token}`);
    expect(blocked.status).toBe(403);

    const changed = await request(app)
      .post('/api/v1/auth/password/force')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ newPassword: 'NewForce0rd!' });
    expect(changed.status).toBe(200);

    // Old cookie is revoked.
    const stale = await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookie);
    expect(stale.status).toBe(401);

    // Flag is cleared.
    const row = await qOne<{ must_change_password: boolean }>(
      'SELECT must_change_password FROM users WHERE email = $1',
      ['fcp@test.local'],
    );
    expect(row?.must_change_password).toBe(false);
    const audit = await query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'auth.forced_password_set'`,
      [session.userId],
    );
    expect(audit.length).toBeGreaterThan(0);
  });

  it('rejects a duplicate email with 409', async () => {
    await register('dupe@test.local');
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'dupe@test.local', password: PASSWORD, fullName: 'Other', role: 'borrower' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('rejects a weak password', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'weak@test.local', password: 'short', fullName: 'Weak', role: 'borrower' });

    expect(response.status).toBe(400);
  });

  it('returns the same generic message for an unknown email and a wrong password', async () => {
    const known = await register('known@test.local');

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'known@test.local', password: 'not-the-password' });
    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'not-the-password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    expect(wrongPassword.body.error.message).toBe('Invalid email or password');

    const actions = await query<{ action: string }>(
      'SELECT action FROM audit_log WHERE entity_id = $1',
      [known.userId],
    );
    expect(actions.map((entry) => entry.action)).toContain('auth.login_failed');
  });

  it('locks the account after too many failed logins, even for the right password', async () => {
    await register('lockme@test.local');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'lockme@test.local', password: 'wrong-password' });
      expect(failed.status).toBe(401);
    }

    const locked = await request(app).post('/api/v1/auth/login').send({ email: 'lockme@test.local', password: PASSWORD });
    expect(locked.status).toBe(423);

    const row = await queryOne<{ locked_until: Date | null }>('SELECT locked_until FROM users WHERE email = $1', [
      'lockme@test.local',
    ]);
    expect(row?.locked_until).not.toBeNull();
  });

  it('rotates the refresh token and detects reuse of a superseded token', async () => {
    await register('rotator@test.local');
    const session = await login('rotator@test.local');

    const first = await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookie);
    expect(first.status).toBe(200);
    const secondCookie = refreshCookie(first);
    expect(secondCookie).not.toBe(session.cookie);

    const second = await request(app).post('/api/v1/auth/refresh').set('Cookie', secondCookie);
    expect(second.status).toBe(200);
    const thirdCookie = refreshCookie(second);

    // The original cookie is now two generations old: replaying it is theft.
    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookie);
    expect(replay.status).toBe(401);

    // Reuse detection must have revoked the whole family, including the newest token.
    const afterFamilyRevoke = await request(app).post('/api/v1/auth/refresh').set('Cookie', thirdCookie);
    expect(afterFamilyRevoke.status).toBe(401);
  });

  it('allows a concurrent double-submit inside the grace window (two tabs)', async () => {
    await register('twotabs@test.local');
    const session = await login('twotabs@test.local');

    const [a, b] = await Promise.all([
      request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookie),
      request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookie),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 200]);
  });

  it('revokes every session when the password changes', async () => {
    const session = await register('changeme@test.local');

    const changed = await request(app)
      .patch('/api/v1/auth/password')
      .set(...(['Authorization', `Bearer ${session.token}`] as [string, string]))
      .send({ currentPassword: PASSWORD, newPassword: 'NewPassw0rd!23' });
    expect(changed.status).toBe(200);
    const audit = await query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'auth.password_change'`,
      [session.userId],
    );
    expect(audit.length).toBeGreaterThan(0);

    const stale = await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookie);
    expect(stale.status).toBe(401);

    const relogin = await request(app).post('/api/v1/auth/login').send({ email: 'changeme@test.local', password: PASSWORD });
    expect(relogin.status).toBe(401);

    const fresh = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'changeme@test.local', password: 'NewPassw0rd!23' });
    expect(fresh.status).toBe(200);
  });
});
