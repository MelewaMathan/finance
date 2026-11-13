import { pool } from './pool';
import { runMigrations } from './migrate';
import { seed } from './seed';

/**
 * Full demo reset: drop the schema, re-apply every migration, re-seed.
 * Used by `npm run db:reset` and before running the test suite.
 */
async function reset(): Promise<void> {
  await runMigrations({ reset: true });
  await seed();
  console.log('[reset] database rebuilt and seeded');
}

reset()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error('[reset] failed:', error);
    await pool.end();
    process.exit(1);
  });
