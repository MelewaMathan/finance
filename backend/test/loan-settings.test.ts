import { describe, expect, it } from 'vitest';
import { query } from '../src/db/pool';
import { app, authHeader, createAdmin, register, request } from './helpers';

describe('institution loan settings', () => {
  it('lets authenticated staff and borrowers read public settings only', async () => {
    const borrower = await register('settings-borrower@test.local');
    const staff = await register('settings-staff@test.local', {
      role: 'staff',
      inviteCode: 'smf-staff-invite-change-me',
      staffId: 'Staff 1',
    });

    for (const user of [borrower, staff]) {
      const publicSettings = await request(app)
        .get('/api/v1/loan-settings')
        .set(...authHeader(user));
      expect(publicSettings.status).toBe(200);
      expect(publicSettings.body.settings).toMatchObject({
        interestRateBps: 1000,
        minPrincipalCents: 10_000,
        maxPrincipalCents: 20_000_000,
        maxInstallments: 365,
        allowedFrequencies: ['daily', 'weekly', 'monthly'],
        institutionName: 'SecureMicrofinance',
      });

      const adminRead = await request(app)
        .get('/api/v1/admin/loan-settings')
        .set(...authHeader(user));
      const adminWrite = await request(app)
        .put('/api/v1/admin/loan-settings')
        .set(...authHeader(user))
        .send({});
      expect(adminRead.status).toBe(403);
      expect(adminWrite.status).toBe(403);
    }
  });

  it('allows admins to update settings and records old and new values in the audit log', async () => {
    const admin = await createAdmin('settings-admin@test.local');
    const before = await request(app)
      .get('/api/v1/admin/loan-settings')
      .set(...authHeader(admin));
    expect(before.status).toBe(200);

    const settings = {
      interestRateBps: 1250,
      minPrincipalCents: 20_000,
      maxPrincipalCents: 25_000_000,
      maxInstallments: 12,
      allowedFrequencies: ['weekly', 'monthly'],
      institutionName: 'Test Institution',
    };
    const updated = await request(app)
      .put('/api/v1/admin/loan-settings')
      .set(...authHeader(admin))
      .send(settings);
    expect(updated.status).toBe(200);
    expect(updated.body.settings).toEqual(settings);

    const publicSettings = await request(app)
      .get('/api/v1/loan-settings')
      .set(...authHeader(admin));
    expect(publicSettings.body.settings).toEqual(settings);

    const auditRows = await query<{
      actor_user_id: string;
      action: string;
      detail: { oldValue: Record<string, unknown>; newValue: Record<string, unknown> };
    }>(
      `SELECT actor_user_id, action, detail FROM audit_log
        WHERE action = 'institution.loan_settings_updated'`,
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actor_user_id: admin.userId,
      action: 'institution.loan_settings_updated',
      detail: {
        oldValue: before.body.settings,
        newValue: settings,
      },
    });
  });

  it('rejects invalid limits without changing settings or adding an audit entry', async () => {
    const admin = await createAdmin('invalid-settings-admin@test.local');
    const invalid = await request(app)
      .put('/api/v1/admin/loan-settings')
      .set(...authHeader(admin))
      .send({
        interestRateBps: 1000,
        minPrincipalCents: 500_000,
        maxPrincipalCents: 100_000,
        maxInstallments: 366,
        allowedFrequencies: [],
        institutionName: 'SecureMicrofinance',
      });
    expect(invalid.status).toBe(400);

    const audits = await query(
      "SELECT seq FROM audit_log WHERE action = 'institution.loan_settings_updated'",
    );
    expect(audits).toHaveLength(0);
  });
});
