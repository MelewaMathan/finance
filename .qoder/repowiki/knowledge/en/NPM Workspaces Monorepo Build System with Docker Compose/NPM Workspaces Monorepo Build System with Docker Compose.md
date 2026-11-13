---
kind: build_system
name: NPM Workspaces Monorepo Build System with Docker Compose
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - backend/package.json
    - frontend/package.json
    - contracts/package.json
    - docker-compose.yml
    - backend/Dockerfile
    - frontend/Dockerfile
    - backend/vitest.config.mts
    - backend/tsconfig.json
    - frontend/vite.config.ts
    - frontend/nginx.conf
    - .env.example
---

# Build & Artifact Management

## Approach

The project is an **NPM workspaces monorepo** (`package.json` at the root declares `workspaces: ["backend", "frontend", "contracts"]`) that orchestrates three Node/TypeScript packages plus a Hardhat Solidity contract workspace. There are no Makefiles or shell build scripts; all orchestration lives in npm scripts and Docker artifacts.

## Key Files

- `package.json` (root) — workspace wiring, top-level dev/test/build scripts, `engines.node >=20`
- `backend/package.json` — Express API build (`tsc -p tsconfig.json`), test (`vitest run`), migration/seed/reset via `tsx`
- `frontend/package.json` — Vite SPA build (`vite build`), typecheck (`tsc --noEmit`)
- `contracts/package.json` — Hardhat compile/test/node/deploy scripts
- `docker-compose.yml` — local stack: PostgreSQL 16 Alpine + API + Nginx frontend
- `backend/Dockerfile` — multi-stage container for the API
- `frontend/Dockerfile` — multi-stage container: Node build → nginx static server
- `.env.example`, `.dockerignore` — environment and build context filtering

## Architecture

### Workspace layout

```
secure-microfinance/
├── backend/          @smf/backend   (Express + TypeScript + Vitest)
├── frontend/         @smf/frontend  (React + Vite + Tailwind)
└── contracts/        @smf/contracts (Hardhat Solidity)
```

All three sub-packages declare their own `name` (`@smf/backend`, `@smf/frontend`, `@smf/contracts`) and `version: 0.1.0`; versions are not centrally managed by a tool like Lerna or changesets.

### Build pipeline per workspace

| Workspace | Dev server | Production build | Test runner |
|---|---|---|---|
| `backend` | `tsx watch src/server.ts` | `tsc -p tsconfig.json` → `dist/server.js` | `vitest run` |
| `frontend` | `vite` | `vite build` → `dist/` | none (no test script) |
| `contracts` | `hardhat node` | `hardhat compile` | `hardhat test` |

### Top-level orchestration scripts

- `npm run dev:all` — runs API and web concurrently via `concurrently -k -n api,web -c green,magenta`.
- `npm run build` — builds backend then frontend (`npm --workspace backend run build && npm --workspace frontend run build`).
- `npm run test` / `test:all` — runs backend tests, optionally also `contracts test`.
- `npm run typecheck` — runs both backend and frontend typechecks.
- `npm run db:migrate` / `db:seed` / `db:reset` — delegate to the backend workspace.
- `npm run smoke` — runs `scripts/smoke-api.mjs` against a live API.
- `npm run contract:test` / `contract:deploy` — delegates to the contracts workspace.

### Database bootstrap

Two paths coexist:

1. **Docker Compose** (`docker-compose.yml`): spins up `postgres:16-alpine` on port `55432` with a named volume `pgdata`, then the `api` service depends on it being healthy (`pg_isready`).
2. **Embedded Postgres** (`scripts/dev-db.mjs`, driven by `embedded-postgres`): used when Docker is unavailable locally, as documented in the compose file comment.

Migrations live under `backend/src/db/migrations/` (`001_core_auth.sql`, `002_loans.sql`, `003_transactions_scoring.sql`, `004_fraud_audit.sql`) and are executed at runtime via `tsx src/db/migrate.ts`.

### Containerization

Both `backend/Dockerfile` and `frontend/Dockerfile` use **multi-stage builds** based on `node:20-alpine`:

- **Backend**: stage 1 (`deps`) copies only the three workspace `package.json` files plus the root lockfile and runs `npm ci`; stage 2 (`build`) compiles TypeScript; final image copies only `backend/dist`, migrations, and `openapi.yaml`, runs as `USER node`, exposes port `4000`, and starts `node backend/dist/server.js`. The build context is the repository root so the root `package-lock.json` is the single source of truth for reproducible installs.
- **Frontend**: stage 1 builds the Vite SPA; final image uses `nginx:1.27-alpine` serving `/usr/share/nginx/html` from the built `dist/`, with `nginx.conf` reverse-proxing `/api` to the API container so the browser never talks directly to the API (no CORS in production).

`docker-compose.yml` wires them together: `postgres` → `api` (depends_on healthcheck) → `web` (depends_on api). The `web` container maps host port `8080:80`; the `api` container maps `4000:4000`.

## Conventions and Constraints

- **Node version**: enforced by the root `engines.node = ">=20"` and mirrored in every Dockerfile base image (`node:20-alpine`).
- **Reproducible installs**: Dockerfiles copy the root `package-lock.json` and run `npm ci` (not `npm install`); the compose comment states this is because the repo is a workspaces monorepo and the root lockfile is the only reproducible one.
- **Workspace-scoped scripts**: top-level scripts always invoke sub-workspaces via `npm --workspace <pkg> run ...` rather than relying on hoisted binaries.
- **Build outputs**: backend emits to `backend/dist/` (configured by `backend/tsconfig.json`); frontend emits to `frontend/dist/` (Vite default). These are the only directories copied into containers.
- **Environment variables**: `DATABASE_URL`, `API_PORT`, `WEB_ORIGIN`, `NODE_ENV` are injected via `docker-compose.yml` `environment`/`env_file`; local development uses `.env.example` as the template.
- **Database schema evolution**: additive-only numbered SQL migration files under `backend/src/db/migrations/`, applied through `tsx src/db/migrate.ts`.
- **No CI configuration found**: there is no GitHub Actions, GitLab CI, Jenkinsfile, or similar pipeline file in the repository; deployment appears to be manual or external (the compose file references an AWS deployment guide in `docs/`, but that doc is not present in the tree).
- **No Makefile or shell build scripts**: all build logic is expressed in npm scripts and Dockerfiles.