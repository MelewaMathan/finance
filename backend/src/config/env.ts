import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Configuration loader.
 *
 * Secrets live only in .env (git-ignored). We look in the current working
 * directory first (backend/) and then the repo root so `npm --workspace
 * backend run ...` and `npm run db:migrate` both work.
 */
const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
];
for (const candidate of candidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

const hexKey = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Container platforms (Render, Railway, Fly) inject PORT and route only to
  // that port, so it wins over the local default. API_PORT still overrides it
  // when set explicitly.
  API_PORT: z.coerce.number().int().positive().default(Number(process.env.PORT) || 4000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TEST_DATABASE_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  // Window in which a replayed refresh token is treated as a concurrent
  // double-submit (second browser tab) instead of theft.
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(120).default(15),
  BCRYPT_COST: z.coerce.number().int().min(10).max(14).default(12),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  FIELD_ENCRYPTION_KEY: hexKey,
  BLIND_INDEX_KEY: hexKey,

  CHAIN_MODE: z.enum(['local', 'amoy', 'off']).default('local'),
  CHAIN_RPC_URL: z.string().default('http://127.0.0.1:8545'),
  CHAIN_ID: z.coerce.number().int().default(31337),
  CHAIN_RECORDER_PRIVATE_KEY: z.string().optional(),
  LEDGER_CONTRACT_ADDRESS: z.string().optional(),
  AMOY_RPC_URL: z.string().optional(),
  AMOY_DEPLOYER_PRIVATE_KEY: z.string().optional(),

  ML_SERVICE_URL: z.string().default('http://127.0.0.1:8000'),
  ML_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  ML_FORCE_FALLBACK: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),

  RAPID_APPLICATION_WINDOW_HOURS: z.coerce.number().int().positive().default(48),
  RAPID_APPLICATION_MAX_LOANS: z.coerce.number().int().positive().default(3),
  REPAYMENT_REQUIRES_CLEARANCE: z
    .string()
    .default('true')
    .transform((value) => value === 'true'),

  // Overdue installments accrue a monthly penalty rate, charged pro rata per
  // day and only after the grace period. Stored as absolute cents per row.
  PENALTY_RATE_BPS: z.coerce.number().int().min(0).max(5000).default(500),
  PENALTY_GRACE_DAYS: z.coerce.number().int().min(0).max(90).default(3),

  REPORT_STORAGE_DIR: z.string().default('storage/reports'),

  // Single enterprise configuration.
  ENTERPRISE_NAME: z.string().default('SecureMicrofinance Enterprise'),
  // Human-readable institution name printed on loan agreements and statements.
  // Set this to the organisation's legal trading name before going live.
  INSTITUTION_NAME: z.string().default('SecureMicrofinance'),
  // Invite code that lets a person self-register as staff.
  // Keep this secret; share it only with authorised administrators.
  STAFF_INVITE_CODE: z.string().min(8).default('smf-staff-invite-change-me'),
  ENTERPRISE_DEFAULT_RATE_BPS: z.coerce.number().int().min(0).max(10000).default(1000),
  ENTERPRISE_MAX_PRINCIPAL_CENTS: z.coerce.number().int().positive().default(50_000_00),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // Fail fast: a half-configured server would silently weaken security.
  throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
}

export const env = parsed.data;

/** True when the caller is the test runner (uses TEST_DATABASE_URL). */
export const isTest = env.NODE_ENV === 'test';

export const databaseUrl = isTest ? env.TEST_DATABASE_URL || env.DATABASE_URL : env.DATABASE_URL;

export const config = {
  ...env,
  isProduction: env.NODE_ENV === 'production',
  databaseUrl,
  cookieName: 'smf_refresh',
  /** Absolute path used for generated PDFs / CSV exports. */
  storageDir: path.resolve(process.cwd(), env.REPORT_STORAGE_DIR),
};
