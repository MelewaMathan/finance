import { describe, expect, it } from 'vitest';
import { decryptField, nationalIdBlindIndex, phoneBlindIndex } from '../src/lib/crypto';
import { queryOne } from '../src/db/pool';
import { app, login, register, request } from './helpers';

/**
 * M1 -- field-level encryption and blind indexes.
 *
 * The point of these tests is that a database dump alone reveals no national
 * ID or phone number, that the API only returns masked values, and that
 * duplicate identities are still detectable through HMAC blind indexes.
 */
describe('profile encryption', () => {
  it('stores national ID and phone as AES-GCM ciphertext with blind indexes', async () => {
    const borrower = await register('encrypted@test.local');

    const response = await request(app)
      .put('/api/v1/me/profile')
      .set('Authorization', `Bearer ${borrower.token}`)
      .send({ nationalId: '23456789', phone: '0712345678', occupation: 'Tailor', monthlyIncomeCents: 4_200_000 });

    expect(response.status).toBe(200);

    const row = await queryOne<{
      national_id_enc: string;
      national_id_bi: string;
      phone_enc: string;
      phone_bi: string;
    }>('SELECT national_id_enc, national_id_bi, phone_enc, phone_bi FROM borrower_profiles WHERE user_id = $1', [
      borrower.userId,
    ]);

    expect(row?.national_id_enc).toMatch(/^v1:/);
    expect(row?.national_id_enc).not.toContain('23456789');
    expect(row?.phone_enc).toMatch(/^v1:/);
    expect(row?.phone_enc).not.toContain('712345678');

    // The blind index is deterministic and keyed, not a plain hash.
    expect(row?.national_id_bi).toBe(nationalIdBlindIndex('23456789'));
    expect(row?.phone_bi).toBe(phoneBlindIndex('0712345678'));
    expect(row?.phone_bi).toHaveLength(64);

    // Ciphertext round-trips with the application key.
    expect(decryptField(row?.national_id_enc)).toBe('23456789');
  });

  it('never returns the raw national ID or phone number, only masked values', async () => {
    const borrower = await register('masked@test.local');
    await request(app)
      .put('/api/v1/me/profile')
      .set('Authorization', `Bearer ${borrower.token}`)
      .send({ nationalId: '23456789', phone: '0712345678' });

    const response = await request(app).get('/api/v1/me/profile').set('Authorization', `Bearer ${borrower.token}`);

    expect(response.status).toBe(200);
    expect(response.body.profile.nationalIdMasked).toContain('*');
    expect(response.body.profile.nationalIdMasked).not.toBe('23456789');
    expect(response.body.profile.phoneMasked).toContain('*');
    expect(JSON.stringify(response.body)).not.toContain('23456789');
  });

  it.each([
    ['nationalId', '123456'],
    ['nationalId', '12A45678'],
    ['phone', '1234567890'],
    ['phone', '071234567'],
  ])('rejects an invalid %s value (%s)', async (field, value) => {
    const borrower = await register(`invalid-${field}-${value}@test.local`);
    const response = await request(app)
      .put('/api/v1/me/profile')
      .set('Authorization', `Bearer ${borrower.token}`)
      .send({ [field]: value });

    expect(response.status).toBe(400);
  });

  it('reports the shared completeness result and audits changed field names without values', async () => {
    const borrower = await register('profile-audit@test.local');
    const update = await request(app)
      .put('/api/v1/me/profile')
      .set('Authorization', `Bearer ${borrower.token}`)
      .send({
        nationalId: '23456789',
        phone: '0712345678',
        occupation: 'Tailor',
        monthlyIncomeCents: 420000,
        verified: true,
      });
    expect(update.status).toBe(200);

    const profile = await request(app)
      .get('/api/v1/me/profile')
      .set('Authorization', `Bearer ${borrower.token}`);
    expect(profile.body.profile.completeness).toEqual({
      complete: true,
      completed: 4,
      total: 4,
      missing: [],
    });
    expect(profile.body.profile.verified).toBeUndefined();

    const audit = await queryOne<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_log WHERE action = 'profile.update' AND entity_id = $1",
      [borrower.userId],
    );
    expect(audit?.detail.changedFields).toEqual(['nationalId', 'phone', 'occupation', 'monthlyIncomeCents']);
    expect(JSON.stringify(audit?.detail)).not.toContain('23456789');
    expect(JSON.stringify(audit?.detail)).not.toContain('0712345678');
  });

  it('flags a shared phone number as an identity conflict without decrypting', async () => {
    const first = await register('first@test.local');
    const second = await register('second@test.local');

    await request(app)
      .put('/api/v1/me/profile')
      .set('Authorization', `Bearer ${first.token}`)
      .send({ nationalId: '11111111', phone: '0712345678' });
    await request(app)
      .put('/api/v1/me/profile')
      .set('Authorization', `Bearer ${second.token}`)
      .send({ nationalId: '22222222', phone: '+254 712 345 678' });

    const flag = await queryOne<{ flag_type: string; severity: string; detail: Record<string, unknown> }>(
      `SELECT flag_type, severity, detail FROM fraud_flags WHERE flag_type = 'identity_conflict'`,
    );

    expect(flag).toBeDefined();
    expect(flag?.severity).toBe('critical');
    // Same number, three different notations -- one blind index.
    expect((flag?.detail as { field: string }).field).toBe('phone number');
  });

  it('does not create a duplicate flag on repeated saves (dedupe key)', async () => {
    const first = await register('dedupe1@test.local');
    const second = await register('dedupe2@test.local');

    await request(app)
      .put('/api/v1/me/profile')
      .set('Authorization', `Bearer ${first.token}`)
      .send({ phone: '0712345678' });
    await request(app)
      .put('/api/v1/me/profile')
      .set('Authorization', `Bearer ${second.token}`)
      .send({ phone: '0712345678' });
    await request(app)
      .put('/api/v1/me/profile')
      .set('Authorization', `Bearer ${second.token}`)
      .send({ phone: '0712345678' });

    const flags = await queryOne<{ count: number }>(
      "SELECT count(*)::int AS count FROM fraud_flags WHERE flag_type = 'identity_conflict'",
    );
    expect(flags?.count).toBe(1);
  });

  it('keeps working through the login endpoint (sanity check)', async () => {
    await register('sanity@test.local');
    const session = await login('sanity@test.local');
    expect(session.token).toBeTruthy();
  });
});
