import { defineConfig } from 'vitest/config';

/**
 * Backend test configuration.
 *
 * Tests run against a real PostgreSQL database (secure_microfinance_test)
 * instead of mocks: the append-only trigger, the hash chain and the AES
 * blind indexes are database-level guarantees that a mock cannot prove.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    // One database, so test files must not run concurrently.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      // bcrypt cost 10 in tests keeps the suite fast; production uses 12.
      BCRYPT_COST: '10',
      // The scoring tests assert the documented fallback path. Whether the
      // Python service happens to be running must not change a test result;
      // the live service is exercised separately against its own contract.
      ML_FORCE_FALLBACK: 'true',
      // Likewise the chain: the ledger suite asserts what the API reports when
      // no contract is configured, so a node deployed on this machine must not
      // flip those results to "verified".
      CHAIN_MODE: 'off',
      LEDGER_CONTRACT_ADDRESS: '',
    },
  },
});
