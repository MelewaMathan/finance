import { afterAll, beforeEach } from 'vitest';
import { pool, query } from '../src/db/pool';

/**
 * Per-test isolation.
 *
 * audit_log refuses TRUNCATE by design, so the triggers are disabled for the
 * cleanup statement only and immediately re-enabled -- the same thing an
 * attacker with DDL rights would have to do, which is exactly what the
 * tamper-detection test then tries to get away with.
 */
const TABLES = [
  'audit_log',
  'audit_anchors',
  'integrity_checks',
  'alerts',
  'fraud_flags',
  'refresh_tokens',
  'documents',
  'loan_installments',
  'loans',
  'credit_scores',
  'transactions',
  'borrower_profiles',
  'staff_profiles',
  'institution_loan_settings',
  'users',
];

beforeEach(async () => {
  await query('ALTER TABLE audit_log DISABLE TRIGGER USER');
  try {
    await query(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await query('ALTER TABLE audit_log ENABLE TRIGGER USER');
  }
  await query(
    `INSERT INTO institution_loan_settings
       (id, interest_rate_bps, min_principal_cents, max_principal_cents,
        max_installments, allowed_frequencies, institution_name)
     VALUES (true, 1000, 10000, 20000000, 365, ARRAY['daily', 'weekly', 'monthly'], 'SecureMicrofinance')`,
  );
  await query("ALTER SEQUENCE audit_seq RESTART WITH 1");
});

afterAll(async () => {
  await pool.end();
});
