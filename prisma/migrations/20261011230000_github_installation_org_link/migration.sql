-- ONE GITHUB ACCOUNT, MANY ORGANISATIONS — the data model (Story MOTIR-8216 ·
-- MOTIR-8218).
--
-- A GitHub App is installed ONCE per GitHub account, so `github_installation`
-- is one row per account and its `organization_id` can name only one Motir
-- organisation. An account that serves two Motir organisations therefore had
-- no way to be connected to the second. Two changes make that expressible:
--
--   1. `github_installation_org_link` — which organisations an installation is
--      linked to. The installation row stays one-per-account; the LINK is
--      per-organisation. Each existing tenant installation is backfilled with
--      the one link it already implies, so nothing an organisation can see
--      changes.
--
--   2. ONE ORGANISATION PER REPOSITORY. Once two organisations share an
--      installation, each claims its own subset of that account's
--      repositories, and the same repository must never be owned by two of
--      them. That is a database guarantee, not a service convention.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A TRIGGER AND NOT A UNIQUE INDEX on github_repo (provider, repo_id)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A unique index is the obvious shape and it is WRONG for this table. The
-- takeover flow (MOTIR-711, `projectRepoTakeoverService`) transfers a repo out
-- of Motir's shared provisioning installation into the customer's account; the
-- customer's installation then mirrors the same repository under its own
-- installation while the shared row is still standing. That is the same
-- repository twice IN ONE ORGANISATION, and it is legitimate. What must be
-- impossible is the same repository in TWO organisations — so the guard
-- compares organisations, which an index cannot do. The plain index below
-- serves the guard's lookup and `findByHostRepoId`.
--
-- The guard holds a transaction-scoped advisory lock on the repository's key,
-- so two concurrent claims of one repository by two organisations serialise
-- instead of both reading "nobody owns it" and both inserting. It reads under
-- the system escape (the competing row is, by definition, another tenant's and
-- invisible to the caller's RLS context) and restores the caller's setting
-- before returning. Its only observable output is the RAISE, which names the
-- repository and never the other organisation.
--
-- An organisation never changes IN PLACE on a repository row: nothing in the
-- tree writes that (offboarding deletes the row; takeover re-stamps owner and
-- name, not the organisation), and an upsert that would re-stamp it is exactly
-- a second organisation claiming the repository through a shared installation.

-- 1. The link table ---------------------------------------------------------
CREATE TABLE "github_installation_org_link" (
    "id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_installation_org_link_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "github_installation_org_link_organization_id_idx" ON "github_installation_org_link"("organization_id");

CREATE INDEX "github_installation_org_link_workspace_id_idx" ON "github_installation_org_link"("workspace_id");

CREATE UNIQUE INDEX "github_installation_org_link_installation_id_organization_i_key" ON "github_installation_org_link"("installation_id", "organization_id");

CREATE INDEX "github_repo_provider_repo_id_idx" ON "github_repo"("provider", "repo_id");

ALTER TABLE "github_installation_org_link" ADD CONSTRAINT "github_installation_org_link_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_installation_org_link" ADD CONSTRAINT "github_installation_org_link_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_installation_org_link" ADD CONSTRAINT "github_installation_org_link_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Row-level security -----------------------------------------------------
--
-- Writes only under the system escape: every write path (install callback,
-- webhook, disconnect) already runs in `withSystemContext`. Reads by the
-- workspace the link was made from, and by the organisation it links — the
-- org arm is byte-for-byte `github_installation_org_read`'s predicate (an
-- uncorrelated InitPlan, no `app.workspace_id`), and `FOR SELECT` only, so a
-- sibling workspace can never delete or re-point the organisation's link.
ALTER TABLE "github_installation_org_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_installation_org_link" FORCE ROW LEVEL SECURITY;

CREATE POLICY "github_installation_org_link_system" ON "github_installation_org_link"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');

CREATE POLICY "github_installation_org_link_workspace_read" ON "github_installation_org_link"
  FOR SELECT
  USING ("workspace_id" = current_setting('app.workspace_id', true));

CREATE POLICY "github_installation_org_link_org_read" ON "github_installation_org_link"
  FOR SELECT
  USING (
    "organization_id" = (SELECT app_caller_organization_id())
    OR "organization_id" = (SELECT current_setting('app.organization_id', true))
  );

-- 3. Refuse to proceed over data the guard would forbid ---------------------
--
-- Fails the deploy LOUDLY, naming each repository, rather than installing a
-- guard the existing rows already violate.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(DISTINCT r."repo_id", ', ')
    INTO offenders
    FROM "github_repo" r
   WHERE r."provider" = 'github'
     AND EXISTS (
       SELECT 1 FROM "github_repo" o
        WHERE o."provider" = r."provider"
          AND o."repo_id" = r."repo_id"
          AND o."organization_id" <> r."organization_id"
     );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'GITHUB_REPO_OWNED_BY_TWO_ORGANIZATIONS: GitHub repository ids % are owned by more than one organisation; resolve them before this migration can apply', offenders;
  END IF;
END
$$;

-- 4. Backfill — every tenant installation gets the link it already implies --
--
-- The shared provisioning installation (NULL on both tiers) gets none: it is
-- linked to no organisation, which is what it already was. GitLab connections
-- are per-organisation by construction and are not linked here.
INSERT INTO "github_installation_org_link" ("id", "installation_id", "organization_id", "workspace_id", "created_at", "updated_at")
SELECT gen_random_uuid()::text, i."id", i."organization_id", i."workspace_id", i."created_at", CURRENT_TIMESTAMP
  FROM "github_installation" i
 WHERE i."provider" = 'github'
   AND i."organization_id" IS NOT NULL
   AND i."workspace_id" IS NOT NULL
ON CONFLICT ("installation_id", "organization_id") DO NOTHING;

-- 5. The one-organisation-per-repository guard ------------------------------
CREATE OR REPLACE FUNCTION enforce_github_repo_single_organization()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  saved_admin text;
  owned_elsewhere boolean;
BEGIN
  IF NEW."provider" <> 'github' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."organization_id" IS DISTINCT FROM NEW."organization_id" THEN
    RAISE EXCEPTION 'GITHUB_REPO_OWNED_BY_ANOTHER_ORGANIZATION: repository % is already owned by another organisation', NEW."repo_id"
      USING ERRCODE = '23505', CONSTRAINT = 'github_repo_one_organization_per_repo';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('github_repo:' || NEW."provider" || ':' || NEW."repo_id", 0));

  saved_admin := current_setting('app.system_admin', true);
  PERFORM set_config('app.system_admin', 'true', true);
  SELECT EXISTS (
    SELECT 1 FROM "github_repo" o
     WHERE o."provider" = NEW."provider"
       AND o."repo_id" = NEW."repo_id"
       AND o."id" <> NEW."id"
       AND o."organization_id" <> NEW."organization_id"
  ) INTO owned_elsewhere;
  PERFORM set_config('app.system_admin', COALESCE(saved_admin, ''), true);

  IF owned_elsewhere THEN
    RAISE EXCEPTION 'GITHUB_REPO_OWNED_BY_ANOTHER_ORGANIZATION: repository % is already owned by another organisation', NEW."repo_id"
      USING ERRCODE = '23505', CONSTRAINT = 'github_repo_one_organization_per_repo';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_github_repo_one_organization
  BEFORE INSERT OR UPDATE OF "provider", "repo_id", "organization_id" ON "github_repo"
  FOR EACH ROW EXECUTE FUNCTION enforce_github_repo_single_organization();
