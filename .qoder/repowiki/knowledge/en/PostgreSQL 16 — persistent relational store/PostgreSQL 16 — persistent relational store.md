---
kind: external_dependency
name: PostgreSQL 16 — persistent relational store
slug: postgresql
category: external_dependency
category_hints:
    - vendor_identity
scope:
    - '**'
source_files:
    - docker-compose.yml
    - .env.example
    - backend/src/db/pool.ts
    - backend/src/db/migrate.ts
---

The project's primary data store is PostgreSQL (image `postgres:16-alpine` in docker-compose; local dev also ships embedded binaries driven by `scripts/dev-db.mjs`). The backend connects via the `pg` driver using `DATABASE_URL` / `TEST_DATABASE_URL`; migrations live under `backend/src/db/migrations/` and are applied through `db:migrate`. Two databases are used: `secure_microfinance` (dev) and `secure_microfinance_test` (tests). Sensitive borrower fields (national ID, phone) are encrypted at rest with AES-256-GCM plus HMAC blind indexes keyed by `FIELD_ENCRYPTION_KEY` / `BLIND_INDEX_KEY`.