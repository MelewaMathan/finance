import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { app, createAuditor, register, request } from './helpers';

/**
 * M1 -- role-based access control.
 *
 * The checks are enforced in middleware, not in the UI: a borrower must not be
 * able to reach lender screens, an auditor must never be able to write, and a
 * token that was not signed by this server is rejected outright.
 */
describe('RBAC', () => {
  it('rejects requests without a token', async () => {
    const response = await request(app).get('/api/v1/me/profile');
    expect(response.status).toBe(401);
  });

  it('rejects a malformed or tampered token', async () => {
    const garbage = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer not-a-jwt');
    expect(garbage.status).toBe(401);

    const borrower = await register('tamper@test.local');
    const forged = jwt.sign({ sub: borrower.userId, role: 'auditor', typ: 'access' }, 'wrong-secret', {
      issuer: 'secure-microfinance',
      audience: 'smf-web',
      expiresIn: '15m',
    });
    const response = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(response.status).toBe(401);
  });

  it('lets a borrower read their own profile', async () => {
    const borrower = await register('reader@test.local');
    const response = await request(app).get('/api/v1/me/profile').set('Authorization', `Bearer ${borrower.token}`);
    expect(response.status).toBe(200);
    expect(response.body.profile).toBeDefined();
  });

  it('stops an auditor from writing anything', async () => {
    const auditor = await createAuditor();
    const response = await request(app)
      .put('/api/v1/me/profile')
      .set('Authorization', `Bearer ${auditor.token}`)
      .send({ occupation: 'Not allowed' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('stops a lender from writing a borrower profile', async () => {
    const lender = await register('lender@test.local', { role: 'lender', businessName: 'Test Credit' });
    const response = await request(app)
      .put('/api/v1/me/profile')
      .set('Authorization', `Bearer ${lender.token}`)
      .send({ occupation: 'Not allowed' });

    expect(response.status).toBe(403);
  });

  it('re-reads the role from the database instead of trusting the token claim', async () => {
    const borrower = await register('demoted@test.local');
    // Simulate a role change after the token was issued.
    const { query } = await import('../src/db/pool');
    await query("UPDATE users SET role = 'auditor' WHERE id = $1", [borrower.userId]);

    const response = await request(app)
      .put('/api/v1/me/profile')
      .set('Authorization', `Bearer ${borrower.token}`)
      .send({ occupation: 'Now an auditor' });

    expect(response.status).toBe(403);
  });
});
