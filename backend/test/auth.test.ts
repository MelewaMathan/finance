import { describe, expect, it } from 'vitest';
import { queryOne } from '../src/db/pool';
import { app, login, PASSWORD, refreshCookie, register, request } from './helpers';

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

  it('refuses to self-register an auditor account', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'sneaky@test.local', password: PASSWORD, fullName: 'Sneaky', role: 'auditor' });

    expect(response.status).toBe(400);
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
    await register('known@test.local');

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
