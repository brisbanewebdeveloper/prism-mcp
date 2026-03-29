#!/bin/sh
set -eu

socket_dir="/run/postgresql"
bootstrap_db="postgres"
bootstrap_user=""

for candidate in "$PRISM_DB_USER" prism supabase_admin postgres; do
  if psql -h "$socket_dir" -U "$candidate" -d "$bootstrap_db" -c 'SELECT 1' >/dev/null 2>&1; then
    bootstrap_user="$candidate"
    break
  fi
done

if [ -z "$bootstrap_user" ]; then
  echo "No local superuser role was available for bootstrap." >&2
  exit 1
fi

until pg_isready -h "$socket_dir" -U "$bootstrap_user" -d "$bootstrap_db" >/dev/null 2>&1; do
  sleep 1
done

psql -v ON_ERROR_STOP=1 \
  -h "$socket_dir" \
  -U "$bootstrap_user" \
  -d "$bootstrap_db" \
  -v db_user="$PRISM_DB_USER" \
  -v db_password="$PRISM_DB_PASSWORD" \
  -v db_name="$PRISM_DB_NAME" \
  -v anon_role="${PRISM_REST_DB_ANON_ROLE:-prism}" <<'SQL'
SELECT 'CREATE ROLE supabase_admin WITH LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'
)\gexec

SELECT 'ALTER ROLE supabase_admin WITH LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS'\gexec

SELECT format('CREATE ROLE %I NOLOGIN NOINHERIT', :'anon_role')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'anon_role'
)\gexec

SELECT 'CREATE ROLE anon NOLOGIN NOINHERIT'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'anon'
)\gexec

SELECT 'CREATE ROLE authenticated NOLOGIN NOINHERIT'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'
)\gexec

SELECT 'CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'service_role'
)\gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'db_user', :'db_password')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'db_user'
)\gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'db_user', :'db_password')\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'db_user')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'db_name'
)\gexec

SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'db_name', :'db_user')\gexec
SELECT format('GRANT %I TO %I', :'anon_role', :'db_user')\gexec
SELECT format('GRANT anon TO %I', :'db_user')\gexec

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
SELECT format('GRANT USAGE ON SCHEMA public TO %I, authenticated, service_role', :'anon_role')\gexec
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;

SELECT format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO %I', :'anon_role')\gexec
SELECT format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO %I', :'anon_role')\gexec
SELECT format('GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO %I', :'anon_role')\gexec

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT ALL ON ROUTINES TO anon, authenticated, service_role;

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO %I',
  :'anon_role'
)\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO %I',
  :'anon_role'
)\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON ROUTINES TO %I',
  :'anon_role'
)\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role',
  :'db_user'
)\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role',
  :'db_user'
)\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON ROUTINES TO anon, authenticated, service_role',
  :'db_user'
)\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON TABLES TO %I',
  :'db_user',
  :'anon_role'
)\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON SEQUENCES TO %I',
  :'db_user',
  :'anon_role'
)\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON ROUTINES TO %I',
  :'db_user',
  :'anon_role'
)\gexec
SQL
