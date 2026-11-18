import { describe, expect, it } from 'vitest';
import { query, queryOne } from '../src/db/pool';
import { suspendAdmin } from '../src/modules/admin/admin.service';
import { app, createAdmin, register, request, PASSWORD, authHeader } from './helpers';

/**
 * Admin management endpoints.
 *
 * Security properties verified:
 *  - Only an admin can create an admin (staff and borrower get 403).
 *  - Admin cannot be registered via the public /auth/register endpoint.
 *  - Temporary password is returned once on creation.
 *  - must_change_password is set on newly created admin.
 *  - An admin cannot suspend their own account.
 *  - The last active admin cannot be suspended.
 *  - Borrowers and staff get 403 on all /admin/* endpoints.
 *  - Every creation and status change is written to the audit log.
 */
describe('admin management', () => {
  it('only an admin can create another admin — staff gets 403', async () => {
    const admin = await createAdmin('create-admin@admin.test');
    const staff = await register('create-staff@admin.test', {
      role: 'staff',
      inviteCode: 'smf-staff-invite-change-me',
    });

    const asStaff = await request(app)
      .post('/api/v1/admin/users')
      .set(...authHeader(staff))
      .send({ fullName: 'New Admin', email: 'newadmin@admin.test' });
    expect(asStaff.status).toBe(403);

    const asAdmin = await request(app)
      .post('/api/v1/admin/users')
      .set(...authHeader(admin))
      .send({ fullName: 'New Admin', email: 'newadmin2@admin.test' });
    expect(asAdmin.status).toBe(201);
    expect(asAdmin.body.temporaryPassword).toBeTruthy();
    expect(asAdmin.body.temporaryPassword.length).toBeGreaterThan(10);
  });

  it('only an admin can create another admin — borrower gets 403', async () => {
    const borrower = await register('create-borrower@admin.test');
    const res = await request(app)
      .post('/api/v1/admin/users')
      .set(...authHeader(borrower))
      .send({ fullName: 'Sneaky Admin', email: 'sneaky-admin@admin.test' });
    expect(res.status).toBe(403);
  });

  it('all admin-management endpoints reject borrowers and staff', async () => {
    const target = await createAdmin('non-admin-target@admin.test');
    const borrower = await register('non-admin-borrower@admin.test');
    const staff = await register('non-admin-staff@admin.test', {
      role: 'staff',
      inviteCode: 'smf-staff-invite-change-me',
    });

    for (const session of [borrower, staff]) {
      const responses = await Promise.all([
        request(app).get('/api/v1/admin/users').set(...authHeader(session)),
        request(app)
          .post('/api/v1/admin/users')
          .set(...authHeader(session))
          .send({ fullName: 'Forbidden Admin', email: 'forbidden-admin@admin.test' }),
        request(app)
          .post(`/api/v1/admin/users/${target.userId}/status`)
          .set(...authHeader(session))
          .send({ action: 'suspend' }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    }
  });

  it('admin cannot be registered via the public endpoint', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'pub-admin@admin.test', password: PASSWORD, fullName: 'Pub Admin', role: 'admin' });
    expect(res.status).toBe(400);
  });

  it('newly created admin has must_change_password = true', async () => {
    const admin = await createAdmin('mcp-creator@admin.test');
    const res = await request(app)
      .post('/api/v1/admin/users')
      .set(...authHeader(admin))
      .send({ fullName: 'MCP Admin', email: 'mcp-new@admin.test' });
    expect(res.status).toBe(201);

    const row = await queryOne<{ must_change_password: boolean }>(
      'SELECT must_change_password FROM users WHERE email = $1',
      ['mcp-new@admin.test'],
    );
    expect(row?.must_change_password).toBe(true);
  });

  it('admin cannot suspend their own account', async () => {
    // We need a second admin so the last-active-admin guard doesn't fire first.
    const admin1 = await createAdmin('self-suspend1@admin.test');
    await createAdmin('self-suspend2@admin.test');

    const res = await request(app)
      .post(`/api/v1/admin/users/${admin1.userId}/status`)
      .set(...authHeader(admin1))
      .send({ action: 'suspend' });
    expect(res.status).toBe(403);
  });

  it('concurrent suspensions cannot leave the system without an active admin', async () => {
    const admin1 = await createAdmin('last-admin-a@admin.test');
    const admin2 = await createAdmin('last-admin-b@admin.test');

    const results = await Promise.allSettled([
      suspendAdmin(admin1.userId, admin2.userId, {}),
      suspendAdmin(admin2.userId, admin1.userId, {}),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const active = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND status = 'active'`,
    );
    expect(active?.count).toBe(1);

    const suspensions = await query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE action = 'admin.user_suspended'
          AND entity_id IN ($1, $2)`,
      [admin1.userId, admin2.userId],
    );
    expect(suspensions).toHaveLength(1);
  });

  it('creating an admin writes to the audit log', async () => {
    const admin = await createAdmin('audit-create@admin.test');
    await request(app)
      .post('/api/v1/admin/users')
      .set(...authHeader(admin))
      .send({ fullName: 'Audit Target', email: 'audit-target@admin.test' });

    const entries = await query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE action = 'admin.user_created'
        ORDER BY seq DESC LIMIT 1`,
    );
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].action).toBe('admin.user_created');
  });

  it('list admins returns all admin accounts', async () => {
    const admin = await createAdmin('list-admin@admin.test');
    const res = await request(app)
      .get('/api/v1/admin/users')
      .set(...authHeader(admin));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.some((u: { email: string }) => u.email === 'list-admin@admin.test')).toBe(true);
  });

  it('wrong password returns the same generic error for every role', async () => {
    // Register accounts of each publicly available role.
    await register('generic-borrower@admin.test');

    const wrongBorrower = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'generic-borrower@admin.test', password: 'wrongpassword' });

    const admin = await createAdmin('generic-admin@admin.test');
    const wrongAdmin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'generic-admin@admin.test', password: 'wrongpassword' });

    expect(wrongBorrower.status).toBe(401);
    expect(wrongAdmin.status).toBe(401);
    expect(wrongBorrower.body.error.message).toBe('Invalid email or password');
    expect(wrongAdmin.body.error.message).toBe('Invalid email or password');
    expect(wrongBorrower.body.error.message).toBe(wrongAdmin.body.error.message);
  });
});
