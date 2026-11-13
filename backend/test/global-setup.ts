/**
 * Runs once, in the main process, before any test file.
 *
 * The test schema is rebuilt from the migration files every run, so a schema
 * change can never leave the test database in a half-migrated state.
 */
export async function setup(): Promise<void> {
  // Must be set before config/env is first imported, otherwise the pool would
  // point at the development database.
  process.env.NODE_ENV = 'test';

  const { runMigrations } = await import('../src/db/migrate');
  const { pool } = await import('../src/db/pool');

  await runMigrations({ reset: true });
  await pool.end();
}
