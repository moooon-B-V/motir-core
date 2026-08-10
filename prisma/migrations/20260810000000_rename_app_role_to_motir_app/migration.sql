-- Rename the non-bypass runtime role: `prodect_app` -> `motir_app` (MOTIR-2519).
--
-- The role is the one the application is INTENDED to connect as so the workspace
-- RLS policies actually execute (see 20260527134009_add_workspace_rls, which
-- creates it, and 20260528175528_grant_prodect_app_login, which gives it LOGIN).
-- It is the last piece of the pre-rebrand product name left inside the database.
--
-- ⚠️ EVERY EARLIER MIGRATION'S `prodect_app` MEANS THIS ROLE. Those files are not
-- edited to say `motir_app`, and must never be: `_prisma_migrations` stores a
-- `checksum` over the WHOLE migration file, so changing even a COMMENT in an
-- already-applied migration makes `prisma migrate deploy` fail on every database
-- that has run it -- production included. This header is the single pointer that
-- reconciles the ~42 historical references with the current name.
--
-- ⚠️ WHY NOW, AND NOT LATER. Nothing connects as this role yet (production runs
-- as the owner; `pg_stat_activity` showed zero sessions for it on 2026-08-07), so
-- today the rename is one statement. Once the deployed cutover (MOTIR-2515) puts
-- the name inside a secret store and a live connection string, the same rename
-- becomes a coordinated credential rotation with an outage window.
--
-- IDEMPOTENT ACROSS THREE STARTING STATES. Roles are CLUSTER-level while
-- migrations are per-DATABASE, so a cluster hosting several databases will run
-- this more than once against a role that is already renamed:
--
--   (a) `prodect_app` exists, `motir_app` does not -> RENAME. The normal path.
--   (b) neither exists                             -> CREATE `motir_app`.
--   (c) `motir_app` already exists                 -> no-op on the role itself.
--
-- On path (a) nothing needs re-granting: a rename carries the role's OID, so
-- table and schema GRANTs, `pg_default_acl` entries and any policy `TO <role>`
-- clause all follow it automatically. Verified 2026-08-09 against a throwaway
-- role: login password, `has_table_privilege`, `has_schema_privilege`,
-- `pg_default_acl` and `pg_policies.roles` were all intact afterwards.
--
-- ⚠️ ONE EXCEPTION, worth checking before running this against any cluster you do
-- not control: under `password_encryption = md5` Postgres CLEARS the role's
-- password on rename, because MD5 verifiers are salted with the role NAME. Neon
-- and the local dev cluster both report `scram-sha-256`, where the password
-- survives. On an md5 cluster the password must be re-set out of band afterwards.
--
-- ⚠️ AND THE CLUSTER-LEVEL SCOPE CUTS BOTH WAYS LOCALLY: applying this to a
-- shared dev cluster renames the role for every database on it at once, including
-- another worktree's `*_test_wN` clones mid-suite. Run it against an isolated
-- cluster, or when nothing else is using that Postgres.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motir_app')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prodect_app') THEN
    -- (c) BOTH exist, which is not a corrupt state but a routine one, and it is
    -- the case a naive no-op gets wrong. Roles are cluster-level; migrations are
    -- per-database. So once this migration has renamed the role for ONE database,
    -- creating a SECOND database on the same cluster replays the whole history --
    -- and 20260527134009_add_workspace_rls, seeing no `prodect_app`, dutifully
    -- CREATEs it again. Left alone it would linger with live grants in this
    -- database, and the suite would find two roles where the RLS tests name one.
    --
    -- Strip what the replay just granted it HERE (DROP OWNED BY is
    -- current-database-scoped: privileges and default-ACL entries, and it owns no
    -- objects), then drop the role itself. That last step fails while ANY other
    -- database on the cluster still grants to it, which is fine and expected --
    -- whichever database runs this last succeeds, and until then the role is inert.
    DROP OWNED BY prodect_app;
    BEGIN
      DROP ROLE prodect_app;
    EXCEPTION
      WHEN dependent_objects_still_exist THEN
        RAISE NOTICE 'prodect_app still holds privileges in another database on this cluster; left in place.';
    END;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prodect_app') THEN
    -- (a) The normal path.
    ALTER ROLE prodect_app RENAME TO motir_app;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motir_app') THEN
    -- (b) A cluster that has never seen the old role. Mirror the attributes the
    -- two originating migrations produced between them: LOGIN (20260528175528),
    -- NOSUPERUSER + NOBYPASSRLS (20260527134009). No password is set here, for
    -- the same reason 20260528175528 sets none -- a static password in git is a
    -- secret-management anti-pattern; dev sets one via scripts/db-up.sh and each
    -- deployed environment injects its own from a secret store.
    CREATE ROLE motir_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- GRANTS ARE PER-DATABASE, so path (c) -- where the rename happened while another
-- database on this cluster was migrating -- still needs them applied here, and
-- path (b) needs them outright. All five statements are idempotent; on paths (a)
-- and (c) they merely re-state privileges the rename already carried.
GRANT USAGE ON SCHEMA public TO motir_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO motir_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO motir_app;

-- Future tables/sequences created by later migrations inherit these without any
-- further grant. Scoped to the role running this migration, exactly as
-- 20260527134009 scoped the originals.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO motir_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO motir_app;
