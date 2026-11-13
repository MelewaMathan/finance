#!/bin/sh
# Container entrypoint.
#
# Applies the forward-only SQL migrations, then hands over to the CMD. The
# runner is idempotent (applied files are recorded in schema_migrations), so a
# restart is cheap. Set RUN_MIGRATIONS=false when migrations are applied by a
# separate release job instead -- with more than one API replica you want that,
# otherwise several containers race the same DDL.
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] applying migrations"
  node backend/dist/db/migrate.js
fi

exec "$@"
