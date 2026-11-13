---
kind: configuration_system
name: Zod-validated .env configuration loader with Docker Compose overlay
category: configuration_system
scope:
    - '**'
source_files:
    - backend/src/config/env.ts
    - .env.example
    - docker-compose.yml
    - backend/package.json
---

## Approach

The backend uses a single, centralized configuration module at `backend/src/config/env.ts` that:

1. Loads `.env` via `dotenv` (dependency declared in `backend/package.json`).
2. Validates every variable against a `zod` schema (`backend/src/config/env.ts:28-74`) — this is the only place environment variables are read.
3. Exposes a typed `config` object plus helpers (`isTest`, `databaseUrl`) consumed by every other module.

There is no runtime config file format (no YAML/JSON/TOML for application settings); all values come from `process.env`. Feature toggles (e.g. `CHAIN_MODE`, `ML_FORCE_FALLBACK`, `REPAYMENT_REQUIRES_CLEARANCE`) are plain env vars coerced to booleans or enums.

## Key files

- `backend/src/config/env.ts` — loader + zod schema + exported `config`.
- `.env.example` — template copied into `.env`; documents every required/optional variable and how to generate secrets.
- `docker-compose.yml` — overlays production values (`NODE_ENV=production`, compose-resolved `DATABASE_URL`, `WEB_ORIGIN`) on top of the `.env` file via `env_file` + inline `environment`.
- `backend/package.json` — declares `dotenv` and `zod` as dependencies.

## Architecture & conventions

**File discovery.** The loader tries two paths before loading dotenv: `process.cwd()/.env` then `process.cwd()/../.env` (`env.ts:13-22`). This lets both `npm --workspace backend run ...` (cwd=`backend/`) and repo-root scripts find the same `.env`.

**Schema-driven validation.** Every variable has an explicit zod entry with type coercion, defaults, and constraints:
- Enums: `NODE_ENV` (`development|test|production`), `LOG_LEVEL`, `CHAIN_MODE` (`local|amoy|off`).
- Coerced numbers: `API_PORT`, `REFRESH_TOKEN_TTL_DAYS`, `BCRYPT_COST`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_MINUTES`, `REFRESH_REUSE_GRACE_SECONDS`, `CHAIN_ID`, `ML_TIMEOUT_MS`, `RAPID_APPLICATION_WINDOW_HOURS`, `RAPID_APPLICATION_MAX_LOANS`, `REFRESH_REUSE_GRACE_SECONDS`.
- Booleans derived from strings: `ML_FORCE_FALLBACK`, `REPAYMENT_REQUIRES_CLEARANCE` via `.transform(v => v === 'true')`.
- Hex-key constraint: `FIELD_ENCRYPTION_KEY` and `BLIND_INDEX_KEY` must be exactly 64 hex characters (32 bytes) — enforced by a dedicated `hexKey` schema.
- Required vs optional: `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `FIELD_ENCRYPTION_KEY`, `BLIND_INDEX_KEY` have no default and are effectively mandatory; blockchain and ML fields are optional.

**Fail-fast policy.** If validation fails, the loader throws immediately with a formatted list of issues and instructions to copy `.env.example` (`env.ts:78-84`). There is no fallback to defaults for missing secrets.

**Single source of truth.** All modules import from `./config/env` (or relative path to it). Twelve files consume it: `app.ts`, `server.ts`, `db/pool.ts`, `db/seed.ts`, `lib/cookies.ts`, `lib/crypto.ts`, `middleware/error.ts`, `middleware/rateLimit.ts`, `modules/auth/auth.service.ts`, `modules/auth/token.service.ts`, `modules/fraud/rules.engine.ts`, `modules/ledger/chain.client.ts`. No module reads `process.env` directly.

**Derived exports.** Beyond the raw env, the module re-exports:
- `isTest` — true when `NODE_ENV === 'test'`.
- `databaseUrl` — resolves to `TEST_DATABASE_URL` in test mode, otherwise `DATABASE_URL`.
- `config.storageDir` — absolute path resolved from `REPORT_STORAGE_DIR`.
- `config.cookieName = 'smf_refresh'` — centralizes the cookie name used by auth.
- `config.isProduction` — boolean flag derived from `NODE_ENV`.

**Environment layers.**
- `.env` (gitignored) — developer secrets and local overrides.
- `.env.example` — committed template documenting every key and its purpose.
- `docker-compose.yml` — injects `NODE_ENV=production`, `API_PORT=4000`, a compose-resolved `DATABASE_URL` pointing at the `postgres` service, and `WEB_ORIGIN=${WEB_ORIGIN:-http://localhost:8080}`. It also passes the host's `.env` via `env_file: [.env]` so secrets flow into containers.

**Secret generation guidance.** `.env.example` instructs generating 32-byte hex keys with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and warns not to commit `.env`.

## Conventions and constraints

- **All runtime configuration goes through `backend/src/config/env.ts`** — observed across every backend module; no direct `process.env` access outside the loader.
- **Every env var has a zod definition** — adding a new setting requires updating the schema in `env.ts` and the template in `.env.example`.
- **Secrets are gitignored** — `.env` is listed in `.gitignore`; `.env.example` contains placeholder values only.
- **Boolean flags are string-typed env vars coerced via `.transform(v => v === 'true')`** — applied consistently to `ML_FORCE_FALLBACK` and `REPAYMENT_REQUIRES_CLEARANCE`.
- **Field-level encryption keys must be 64 hex characters** — enforced by the `hexKey` zod schema; changing them invalidates existing ciphertext (documented in `.env.example`).
- **Test database isolation** — `databaseUrl` switches to `TEST_DATABASE_URL` when `NODE_ENV=test`, allowing tests to use a separate DB.
- **Docker overlay** — `docker-compose.yml` sets `NODE_ENV=production` and overrides `DATABASE_URL`/`WEB_ORIGIN` for containerized runs, while still loading the host's `.env` via `env_file`.