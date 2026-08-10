#!/usr/bin/env bash
# Bring up the local dev Postgres in Docker and apply Prisma migrations.
# Idempotent: safe to run repeatedly. Exits 0 on success, non-zero on failure.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is not installed or not on PATH" >&2
  exit 1
fi

echo "==> Starting prodect-postgres (docker compose up -d)"
docker compose up -d postgres

echo "==> Waiting for Postgres to be healthy (max 30s)"
deadline=$(( $(date +%s) + 30 ))
until docker compose exec -T postgres pg_isready -U prodect -d prodect >/dev/null 2>&1; do
  if (( $(date +%s) >= deadline )); then
    echo "error: Postgres did not become ready within 30s" >&2
    docker compose logs postgres | tail -40 >&2
    exit 1
  fi
  sleep 1
done
echo "    Postgres is ready."

echo "==> Applying Prisma migrations (prisma migrate deploy)"
pnpm prisma migrate deploy

# PRODECT_FINDINGS #5(deploy): the 20260528175528_grant_prodect_app_login migration gives the
# non-bypass `motir_app` role the LOGIN capability but deliberately commits no
# password (a static password in git is a secret-management anti-pattern). Set
# the LOCAL DEV password here, out of band, so the role can actually connect
# when we point a DATABASE_URL at it. This is the dev/CI password ONLY —
# production provisions motir_app's credentials via its secret store / managed
# Postgres provider, never via this script. Idempotent: ALTER ROLE ... PASSWORD
# is safe to re-run.
echo "==> Setting local dev password for the motir_app RLS role"
docker compose exec -T postgres \
  psql -U prodect -d prodect -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE motir_app WITH PASSWORD 'motir_app';" >/dev/null

echo "==> Done. Database is up at postgresql://prodect:prodect@localhost:5433/prodect"
echo "    RLS-enforcing role available at postgresql://motir_app:motir_app@localhost:5433/prodect"
echo "    (still unused — the active DATABASE_URL connects as the superuser 'prodect';"
echo "     see PRODECT_FINDINGS #5(deploy) for the runtime cutover.)"
