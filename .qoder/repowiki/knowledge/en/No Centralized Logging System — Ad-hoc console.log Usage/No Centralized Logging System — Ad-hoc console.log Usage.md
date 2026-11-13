---
kind: logging_system
name: No Centralized Logging System — Ad-hoc console.log Usage
category: logging_system
scope:
    - '**'
source_files:
    - backend/src/middleware/error.ts
    - backend/src/server.ts
    - backend/src/db/pool.ts
    - backend/src/db/migrate.ts
    - backend/src/db/reset.ts
    - backend/src/db/seed.ts
---

## What system/approach is used

This repository has **no centralized logging framework or logging subsystem**. There is no logger initialization, no log-level configuration, no structured-log library (winston/pino/bunyan), and no HTTP request logger (morgan). All output goes through Node.js built-in `console.log` / `console.error` calls scattered across source files.

## Key files with logging statements

- `backend/src/server.ts` — startup/shutdown messages via `console.log` (`[api] listening on ...`, `[api] docs: ...`, `[api] ledger mode: ...`, signal handler).
- `backend/src/middleware/error.ts` — unhandled errors are written with `console.error('[error] ${requestId} ${req.method} ${req.originalUrl}', error)`; this is the only place that attaches a per-request `requestId` to an error line.
- `backend/src/db/pool.ts` — idle client errors logged via `console.error('[db] idle client error', error)`.
- `backend/src/db/migrate.ts` — migration progress via `console.log('[migrate] schema dropped' | 'applied <file>' | 'up to date')` and failure via `console.error`.
- `backend/src/db/reset.ts` — `console.log('[reset] database rebuilt and seeded')` / `console.error('[reset] failed:', error)`.
- `backend/src/db/seed.ts` — per-user creation logs like `console.log(\`[seed] created ${person.role} ${person.email}\`)` plus a final demo-password printout.
- `scripts/dev-db.mjs`, `scripts/diag-audit.mjs`, `scripts/smoke-api.mjs` — CLI tooling uses `console.log` / `console.error` for human-readable status.

The frontend (`frontend/src/`) contains **zero** `console.log` / `console.error` calls in its source tree.

## Architecture and conventions

- **No abstraction layer**: every file that needs to emit output imports nothing and calls `console.*` directly. There is no shared logger module.
- **Tag-prefix convention**: most `console.log` / `console.error` lines start with a bracketed tag identifying the subsystem, e.g. `[api]`, `[db]`, `[migrate]`, `[seed]`, `[reset]`, `[error]`, `[smoke]`. This is the closest thing to a naming convention in the codebase.
- **Structured fields do not exist**: log lines are plain template strings or concatenated arguments; there is no JSON payload, no timestamp field, no level field, and no correlation ID propagated beyond the single `requestId` value attached to error lines in the central error handler.
- **Log levels are not modeled**: all runtime diagnostics use either `console.log` (informational) or `console.error` (errors); there is no distinction between debug/info/warn/fatal.
- **Error responses vs. server logs are separate**: the `errorHandler` middleware writes structured JSON to the HTTP response (including `code`, `message`, optional `details`, and `requestId`) while simultaneously writing one raw `console.error` line to stderr. The comment in `error.ts` explicitly states: "generic 500; details only in server logs".

## Conventions and constraints

- Observed convention: production-only detail leakage is gated by `config.isProduction` — the 500 response omits `details` in production but still emits the full error object to stderr via `console.error` (see `backend/src/middleware/error.ts` lines 66–74).
- Observed convention: the `requestId` from `req.requestId` is included in both the JSON error response and the stderr error line, providing a minimal per-request correlation token for server-side debugging.
- No enforced rule was found: there is no lint rule, no logger factory, and no documentation mandating how new logging should be added. New code currently follows the existing ad-hoc pattern of direct `console.log` / `console.error` calls with a `[tag]` prefix.