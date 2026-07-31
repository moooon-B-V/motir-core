-- MOTIR-1910 — the per-`(repository × user)` COLLABORATOR record, replacing the
-- four singular `collaborator_*` columns MOTIR-1900 put on `project_repository`.
--
-- ⚠️ WHY THIS IS A TABLE AND NOT FOUR MORE COLUMNS. MOTIR-1900 closed the hole
-- the ownership amendment opened (`docs/decisions/project-repository-set.md` §3:
-- every created repository is Motir-owned and PRIVATE, so the user cannot clone
-- their own code until Motir invites them) — but it closed it for exactly ONE
-- person. `collaborator_login` / `collaborator_invited_at` /
-- `collaborator_accepted_at` / `collaborator_invitation_url` hold one account per
-- repository, so on the six-person workspace Motir dogfoods, five members had no
-- path to the code and no column to record one in.
--
-- The count was never a property of the repository. It is a property of the TEAM,
-- so the shape is a join table whose degenerate case is one row. §3's TEAM ACCESS
-- amendment (MOTIR-1943) decides who is in that set (Q1: everyone `canEdit`
-- admits) and at what level (Q2: `push`, with `admin` reserved to the approving
-- user).
--
-- ⚠️ THE PERMISSION IS PER INVITEE. `lib/github/repoCollaborators.ts` pinned
-- `COLLABORATOR_PERMISSION = 'admin'` as a module constant, justified in-comment
-- by the takeover path (MOTIR-711) — reasoning that only holds for the OWNER, who
-- is the only one who walks a transfer. A teammate needs to clone, branch and
-- push; they do not need to rename, transfer or delete the project's
-- repositories. So the level becomes a column, and the backfill below stamps the
-- existing (owner's) row `admin` so this migration cannot silently DOWNGRADE
-- access that has already been granted.
--
-- WHY THE STATE IS STILL DERIVED, not an enum column. Same argument the
-- `ci_actions_*` intent columns and MOTIR-1900's own four columns used: a stored
-- state must be CLEARED by whatever set it, so a crash between the GitHub call
-- and the write leaves it lying. Two nullable stamps cannot desynchronise, and a
-- re-read recomputes the same answer:
--
--   accepted     ⟺ accepted_at IS NOT NULL
--   invited      ⟺ invited_at IS NOT NULL AND NOT accepted
--   not_invited  ⟺ neither  (including: no row at all, for a member never invited)
--
-- It also keeps an enum from ever needing a `declined` value Motir cannot
-- observe — GitHub owns acceptance and reports nothing when it happens, so a
-- declined invitation is simply one that never becomes accepted.
--
-- WHY `user_id` AND NOT A TYPED HANDLE. The FK is the safety property: an
-- invitation can only be aimed at someone the workspace already contains, so a
-- typo cannot invite a STRANGER to a private repository. `github_login` is a
-- snapshot of that user's own connected identity at invite time, recorded rather
-- than re-derived so a member who later reconnects a different GitHub account
-- still sees which account actually holds the access.
--
-- IDEMPOTENCY is the `(project_repository_id, user_id)` unique index: a retry
-- after a crash between the GitHub call and the write upserts the same row rather
-- than recording a second invitation for one account. It pairs with GitHub's own
-- idempotency (a repeat `PUT …/collaborators/{username}` UPDATES a pending
-- invitation rather than creating a second).

-- ── The permission level ─────────────────────────────────────────────────────
CREATE TYPE "project_repo_collaborator_permission" AS ENUM ('push', 'admin');

-- ── The record ───────────────────────────────────────────────────────────────
CREATE TABLE "project_repository_collaborator" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_repository_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "github_login" TEXT NOT NULL,
    "permission" "project_repo_collaborator_permission" NOT NULL DEFAULT 'push',
    "invited_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "invitation_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_repository_collaborator_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_repository_collaborator_project_repository_id_user__key"
    ON "project_repository_collaborator"("project_repository_id", "user_id");
CREATE INDEX "project_repository_collaborator_workspace_id_idx"
    ON "project_repository_collaborator"("workspace_id");
CREATE INDEX "project_repository_collaborator_project_repository_id_idx"
    ON "project_repository_collaborator"("project_repository_id");
CREATE INDEX "project_repository_collaborator_user_id_idx"
    ON "project_repository_collaborator"("user_id");

ALTER TABLE "project_repository_collaborator"
    ADD CONSTRAINT "project_repository_collaborator_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_repository_collaborator"
    ADD CONSTRAINT "project_repository_collaborator_project_repository_id_fkey"
    FOREIGN KEY ("project_repository_id") REFERENCES "project_repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_repository_collaborator"
    ADD CONSTRAINT "project_repository_collaborator_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── BACKFILL — migrate, do not drop ──────────────────────────────────────────
--
-- Every established row that carries a `collaborator_login` describes a REAL
-- invitation that is live on GitHub right now: an account that can already clone,
-- or one holding a pending invitation it can still accept. Dropping the columns
-- without carrying them over would make Motir report `not_invited` for someone
-- who demonstrably has access, and would re-invite them on the next pass.
--
-- The login is resolved back to a Motir user through `github_identity`, which is
-- where it came from (MOTIR-1900 read the ACTOR's own connected identity and never
-- accepted a typed handle, so a matching identity is the expected case). The join
-- is on `github_login` because that is the only link the columns preserved.
--
-- `permission` is `admin` for every backfilled row — that is what
-- `COLLABORATOR_PERMISSION` actually sent, so recording anything else would be a
-- lie about what GitHub was told, and would silently downgrade the approving
-- user's access.
--
-- A row whose login resolves to NO current identity is deliberately left behind:
-- there is no user to attribute it to, and inventing one would be worse than the
-- honest `not_invited` that the next pass simply re-invites (which is idempotent
-- on GitHub's side, so it costs one request and converges).
INSERT INTO "project_repository_collaborator" (
    "id", "workspace_id", "project_repository_id", "user_id", "github_login",
    "permission", "invited_at", "accepted_at", "invitation_url",
    "created_at", "updated_at"
)
SELECT
    gen_random_uuid()::text,
    pr."workspace_id",
    pr."id",
    gi."user_id",
    pr."collaborator_login",
    'admin'::"project_repo_collaborator_permission",
    pr."collaborator_invited_at",
    pr."collaborator_accepted_at",
    pr."collaborator_invitation_url",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "project_repository" pr
JOIN "github_identity" gi ON gi."github_login" = pr."collaborator_login"
WHERE pr."collaborator_login" IS NOT NULL;

-- ── Retire the singular columns ──────────────────────────────────────────────
ALTER TABLE "project_repository"
    DROP COLUMN "collaborator_login",
    DROP COLUMN "collaborator_invited_at",
    DROP COLUMN "collaborator_accepted_at",
    DROP COLUMN "collaborator_invitation_url";

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- The same shape `project_repository` uses, and for the same reasons: FORCE so
-- even the table-owner role is subject to it, the predicate on the row's OWN
-- `workspace_id` (RLS does not traverse foreign keys, so a join through
-- `project_repository` would not gate anything), and NO `app.system_admin`
-- escape — every write here comes from a request path with an active workspace
-- (the access step, the team-access surface), never from a webhook with no
-- tenant. The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO
-- prodect_app` auto-grants on every new table created by the `prodect` role, so
-- no explicit GRANT is needed.
ALTER TABLE "project_repository_collaborator" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_repository_collaborator" FORCE ROW LEVEL SECURITY;

CREATE POLICY "project_repository_collaborator_active_workspace" ON "project_repository_collaborator"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
