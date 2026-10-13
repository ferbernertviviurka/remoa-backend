#!/usr/bin/env bash
# Bootstrap an isolated local F33 test DB: scripts/f33-test-db.sh <dbname>   (e.g. remoa_f33_test_boot)
# Refuses unless name matches f33_(test|bench) and host is 127.0.0.1/localhost. Idempotent. Never touches other DBs.
# Admin URL (default local Supabase) via F33_ADMIN_URL=postgresql://user:pass@127.0.0.1:54322 (no db path).
set -euo pipefail
NAME="${1:-}"
ADMIN="${F33_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:54322}"
[[ "$NAME" =~ ^[a-z0-9_]*f33_(test|bench)[a-z0-9_]*$ ]] || { echo "refused: db name must match f33_(test|bench) (got '$NAME')" >&2; exit 1; }
HOSTPART="${ADMIN#*@}"; HOST="${HOSTPART%%[:/]*}"
[[ "$HOST" == 127.0.0.1 || "$HOST" == localhost ]] || { echo "refused: host must be 127.0.0.1/localhost" >&2; exit 1; }
ADMIN="${ADMIN%/}"
[[ "$(psql "$ADMIN/postgres" -Atc "select 1 from pg_database where datname='$NAME'")" == 1 ]] || psql "$ADMIN/postgres" -v ON_ERROR_STOP=1 -qc "create database \"$NAME\""
URL="$ADMIN/$NAME"
if [[ "$(psql "$URL" -Atc "select 1 from pg_namespace where nspname='auth'")" != 1 ]]; then
psql "$URL" -v ON_ERROR_STOP=1 -q <<'SQL'
create schema auth;
create table auth.users (id uuid primary key, email varchar(255), raw_user_meta_data jsonb, raw_app_meta_data jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now());
comment on schema auth is 'f33-test-stub';
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role'))::text $$;
create function auth.email() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.email',true),''),(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'email'))::text $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
SQL
fi
# Stub-only (marker comment): add late columns/tables idempotently. A real Supabase auth schema has no marker and is never altered.
if [[ "$(psql "$URL" -Atc "select obj_description('auth'::regnamespace,'pg_namespace')")" == f33-test-stub ]]; then
psql "$URL" -v ON_ERROR_STOP=1 -q <<'SQL'
alter table auth.users add column if not exists email_confirmed_at timestamptz, add column if not exists banned_until timestamptz, add column if not exists deleted_at timestamptz, add column if not exists instance_id uuid, add column if not exists aud varchar(255), add column if not exists role varchar(255);
create table if not exists auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(), updated_at timestamptz default now(), not_after timestamptz, refreshed_at timestamp, user_agent text, ip inet);
SQL
fi
cd "$(dirname "$0")/.."
DATABASE_URL="$URL" TEST_DATABASE_URL="$URL" pnpm --filter @remoa/db migrate
echo "ready: $URL"
