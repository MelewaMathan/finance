import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src/modules/audit/audit.service';
import { query, queryOne } from '../src/db/pool';
import { GENESIS_HASH } from '../src/lib/canonical';
import { login, register } from './helpers';

/**
 * M1 -- append-only, hash-chained audit log.
 *
 * Three separate guarantees are tested:
 *  1. the database refuses UPDATE / DELETE / TRUNCATE on audit_log,
 *  2. the hash chain links every row to its predecessor,
 *  3. if an attacker with DDL rights disables the trigger and edits a row,
 *     verification recomputes a different hash and reports the tampering.
 */
describe('audit log', () => {
  it('writes a chained row for every authentication event', async () => {
    const session = await register('audited@test.local');
    await login('audited@test.local');

    const rows = await query<{ seq: number; action: string; prev_hash: string; row_hash: string }>(
      'SELECT seq, action, prev_hash, row_hash FROM audit_log ORDER BY seq',
    );

    const actions = rows.map((row) => row.action);
    expect(actions).toContain('auth.register');
    expect(actions).toContain('auth.login');

    // First row links to genesis, every later row links to its predecessor.
    expect(rows[0].prev_hash).toBe(GENESIS_HASH);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].prev_hash).toBe(rows[index - 1].row_hash);
    }

    const actor = await queryOne<{ actor_user_id: string }>(
      'SELECT actor_user_id FROM audit_log WHERE action = $1',
      ['auth.register'],
    );
    expect(actor?.actor_user_id).toBe(session.userId);
  });

  it('rejects UPDATE, DELETE and TRUNCATE from the database itself', async () => {
    await register('immutable@test.local');

    await expect(query("UPDATE audit_log SET action = 'rewritten' WHERE action = 'auth.register'")).rejects.toThrow(
      /append-only/i,
    );
    await expect(query('DELETE FROM audit_log')).rejects.toThrow(/append-only/i);
    await expect(query('TRUNCATE audit_log')).rejects.toThrow(/append-only/i);

    // The rows are still intact afterwards.
    const count = await queryOne<{ count: number }>("SELECT count(*)::int AS count FROM audit_log WHERE action = 'auth.register'");
    expect(count?.count).toBe(1);
  });

  it('verifies an untouched chain', async () => {
    await register('verifier@test.local');
    await login('verifier@test.local');

    const result = await verifyAuditChain();
    expect(result.ok).toBe(true);
    expect(result.mismatches).toHaveLength(0);
    expect(result.rowsChecked).toBeGreaterThanOrEqual(2);
    expect(result.headHash).toHaveLength(64);
  });

  it('detects a row edited by someone who disabled the guard trigger', async () => {
    await register('victim@test.local');
    // A second row so the tampered row has a successor to break the link to.
    await login('victim@test.local');

    // An attacker with DDL rights can remove the trigger -- but not fix the hash.
    await query('ALTER TABLE audit_log DISABLE TRIGGER USER');
    try {
      await query(
        `UPDATE audit_log
            SET detail = jsonb_set(detail, '{role}', '"auditor"'),
                row_hash = repeat('a', 64)
          WHERE seq = 1`,
      );
    } finally {
      await query('ALTER TABLE audit_log ENABLE TRIGGER USER');
    }

    const result = await verifyAuditChain();
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((mismatch) => mismatch.reason === 'hash_mismatch' && mismatch.seq === 1)).toBe(true);

    // The next row stores the original hash as prev_hash, so the chain no longer links.
    expect(result.mismatches.some((mismatch) => mismatch.reason === 'broken_link' && mismatch.seq === 2)).toBe(true);
  });
});
