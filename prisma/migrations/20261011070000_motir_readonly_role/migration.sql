-- The READ-ONLY diagnosis role, `motir_readonly` (MOTIR-8187 · MOTIR-8188).
--
-- Diagnosing a production run meant a node script piped through
-- `fly ssh console`, run by a person, read back from a file. This role lets an
-- operator (or a diagnosing agent holding its connection string) query the
-- production database directly and do nothing else: SELECT on every table, now
-- and as later migrations add them, and no write privilege of any kind.
--
-- ⚠️ NOLOGIN IN GIT, ON PURPOSE. A role that can log in needs a password, and a
-- password in a migration is a secret in every clone and every database the
-- history is replayed into: dev, CI, preview branches. So this file creates the
-- role without LOGIN, and production is the only place it gets one, by hand:
--   ALTER ROLE motir_readonly WITH LOGIN PASSWORD '<generated>';
-- (the human subtask MOTIR-8190). Everywhere else the role exists, holds its
-- grants and cannot be connected as.
--
-- ⚠️ ROW-LEVEL SECURITY STILL APPLIES TO IT, and that is intended. NOBYPASSRLS,
-- and every workspace policy is written without a `TO` clause, so a session as
-- this role sees no tenant rows until it does what `withSystemContext` does,
-- inside a transaction:
--   BEGIN; SELECT set_config('app.system_admin', 'true', true); … ; ROLLBACK;
-- With that, it reads every workspace's rows: its connection string is a
-- production secret and is handled like one.
--
-- TWO DEFAULTS AS A SECOND LINE: the grants already forbid writes, and the role
-- defaults make a session read-only and bound a heavy query, so a mistaken
-- statement fails instead of writing or holding the database. Role defaults
-- apply at LOGIN; a test reaching the role through `SET ROLE` reads them from
-- `pg_roles.rolconfig` instead.
--
-- IDEMPOTENT: roles are CLUSTER-level and migrations are per-DATABASE (see
-- 20260810000000_rename_app_role_to_motir_app), so a second database on the same
-- cluster finds the role already there. The DO block creates it only when absent
-- and never alters an existing one, so production's hand-set LOGIN and password
-- survive a replay. The grants below are per-database and re-stated each time.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motir_readonly') THEN
    CREATE ROLE motir_readonly NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE motir_readonly SET default_transaction_read_only = on;
ALTER ROLE motir_readonly SET statement_timeout = '30s';

GRANT USAGE ON SCHEMA public TO motir_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO motir_readonly;

-- Tables created by later migrations inherit SELECT without a further grant.
-- Scoped to the role running this migration, exactly as the motir_app defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO motir_readonly;
