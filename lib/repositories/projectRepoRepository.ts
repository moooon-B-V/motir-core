import {
  Prisma,
  type ProjectRepo,
  type ProjectRepoCollaboratorPermission,
  type ProjectRepoRole,
  type ProjectRepoTakeoverState,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import type { ProjectRepoWithRealized } from '@/lib/mappers/projectRepoMappers';
import { ESTABLISHED_PROJECT_REPO_STATES } from '@/lib/projectRepos/vocabulary';

// Single Prisma operations on the `project_repository` table — a project's
// REPOSITORY SET (Story MOTIR-1775 · MOTIR-1780).
//
// Named `projectRepoRepository` (for the Prisma model `ProjectRepo`) so it is
// unambiguous next to the long-shipped `projectRepository`, which is the
// data-access leaf for the `project` table — a different entity. The
// repository-name-matches-the-entity rule, with the collision resolved by the
// model name rather than by filing rows under the wrong leaf.
//
// Writes require `tx` (a compile-time guarantee they run in a transaction); reads
// take an optional `tx` so a transition's locked re-read joins the surrounding
// transaction. No business logic, no transactions, no DTO mapping — those belong
// in `projectRepoSetService`.
//
// Every tenant path runs under an active workspace context, so the RLS policy's
// `app.workspace_id` GUC gates the rows; the `workspaceId` argument on each read
// is the belt-and-suspenders app-level scope (a cross-tenant id returns null →
// 404, never 403 — the no-existence-leak posture).

/**
 * The collaborator columns every `ProjectRepo` read joins — exactly the ones the
 * derivation in `lib/projectRepos/access.ts` consumes, and no more.
 *
 * A `select` rather than `true` on purpose: the record also holds `userId` and the
 * tenant id, which the access DERIVATION has no business seeing (it decides over
 * stamps + login + permission alone). Narrowing here is what lets
 * `ProjectRepoAccessColumns` stay a small structural type a fixture can satisfy.
 */
const COLLABORATOR_COLUMNS = {
  select: {
    githubLogin: true,
    permission: true,
    invitedAt: true,
    acceptedAt: true,
    invitationUrl: true,
  },
} as const;

/** The raw row shape {@link projectRepoRepository.listByProject}'s LEFT JOIN
 *  returns, before it is reassembled into {@link ProjectRepoWithRealized}. */
interface JoinedRow {
  id: string;
  workspaceId: string;
  projectId: string;
  role: ProjectRepoRole;
  label: string | null;
  name: string;
  seedSource: string;
  state: ProjectRepo['state'];
  failureReason: string | null;
  proposalSignal: string | null;
  githubRepoId: string | null;
  position: string;
  createdAt: Date;
  updatedAt: Date;
  ciActionsDisabled: boolean;
  ciActionsIntentAt: Date | null;
  ciActionsAppliedAt: Date | null;
  takeoverState: ProjectRepoTakeoverState | null;
  takeoverTargetOwner: string | null;
  takeoverRequestedAt: Date | null;
  takeoverTransferredAt: Date | null;
  takeoverCompletedAt: Date | null;
  takeoverFailureReason: string | null;
  // The APPROVING USER's collaborator record (the `admin` one — ADR §3 Q2), or
  // all-NULL when the row has none. Only that record is joined here: this read
  // feeds the establish step, which asks "can *I* reach my code?", and joining a
  // whole team's records onto every row would fan the set read out by member
  // count to answer a question it never asks. The team matrix is its own read.
  ownerLogin: string | null;
  ownerPermission: ProjectRepoCollaboratorPermission | null;
  ownerInvitedAt: Date | null;
  ownerAcceptedAt: Date | null;
  ownerInvitationUrl: string | null;
  // The realized `github_repo` half — every column NULL when the row is
  // unrealized (or when its mirror row was deleted / is invisible under RLS).
  repoRowId: string | null;
  repoDefaultBranchHeadSha: string | null;
  repoIndexedHeadSha: string | null;
  repoIndexedAt: Date | null;
  repoIndexingRunId: string | null;
  repoProvider: string | null;
  repoWorkspaceId: string | null;
  /** The mirror row's ORGANISATION (MOTIR-4649) — nullable in the column, and
   *  doubly so here because the LEFT JOIN itself can miss. */
  repoOrganizationId: string | null;
  repoInstallationId: string | null;
  repoHostId: string | null;
  repoOwner: string | null;
  repoName: string | null;
  repoDefaultBranch: string | null;
  /** The mirror's LIVENESS (MOTIR-1959) — `false` for a live repo, and NULL only
   *  because every joined column is null on an unrealized row, never because the
   *  column itself is nullable. Reassembled below with the same `?? false` an
   *  absent value reads as everywhere else. */
  repoArchived: boolean | null;
  repoCreatedAt: Date | null;
  repoUpdatedAt: Date | null;
}

/** Reassemble one LEFT-JOINed row into the nested shape the mappers consume. */
function toNested(r: JoinedRow): ProjectRepoWithRealized {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    projectId: r.projectId,
    role: r.role,
    label: r.label,
    name: r.name,
    seedSource: r.seedSource,
    state: r.state,
    failureReason: r.failureReason,
    proposalSignal: r.proposalSignal,
    githubRepoId: r.githubRepoId,
    position: r.position,
    ciActionsDisabled: r.ciActionsDisabled,
    ciActionsIntentAt: r.ciActionsIntentAt,
    ciActionsAppliedAt: r.ciActionsAppliedAt,
    takeoverState: r.takeoverState,
    takeoverTargetOwner: r.takeoverTargetOwner,
    takeoverRequestedAt: r.takeoverRequestedAt,
    takeoverTransferredAt: r.takeoverTransferredAt,
    takeoverCompletedAt: r.takeoverCompletedAt,
    takeoverFailureReason: r.takeoverFailureReason,
    // Zero or one record — the mapper then picks the `admin` one out of it, which
    // is exactly what the JOIN already selected. Keeping the shape a LIST (rather
    // than a nullable field) means this read and the Prisma-`include` reads below
    // return the same type, so the mapper has one code path.
    collaborators:
      r.ownerLogin === null
        ? []
        : [
            {
              githubLogin: r.ownerLogin,
              permission: r.ownerPermission!,
              invitedAt: r.ownerInvitedAt,
              acceptedAt: r.ownerAcceptedAt,
              invitationUrl: r.ownerInvitationUrl,
            },
          ],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    githubRepo:
      r.repoRowId === null
        ? null
        : {
            id: r.repoRowId,
            defaultBranchHeadSha: r.repoDefaultBranchHeadSha,
            indexedHeadSha: r.repoIndexedHeadSha,
            indexedAt: r.repoIndexedAt,
            indexingRunId: r.repoIndexingRunId,
            provider: r.repoProvider!,
            workspaceId: r.repoWorkspaceId!,
            organizationId: r.repoOrganizationId,
            installationId: r.repoInstallationId!,
            repoId: r.repoHostId!,
            owner: r.repoOwner!,
            name: r.repoName!,
            defaultBranch: r.repoDefaultBranch!,
            archived: r.repoArchived ?? false,
            createdAt: r.repoCreatedAt!,
            updatedAt: r.repoUpdatedAt!,
          },
  };
}

export const projectRepoRepository = {
  /**
   * A project's whole repository set, ORDERED (primary first), with each row's
   * realized `GithubRepo` joined — in ONE query.
   *
   * Raw SQL with a LEFT JOIN rather than a Prisma `include`, deliberately: an
   * `include` on a to-one relation compiles to a SECOND round-trip (batched, so
   * O(1) rather than N+1, but still two). The set read is the one every later
   * card in this Story goes through — the establish-step UI, the dispatch
   * resolver, the transfer flow — so it is a single statement by construction.
   * `$queryRaw` in a repository is the sanctioned escape (CLAUDE.md's layer
   * contract lists it as a legal single operation).
   *
   * RLS still applies to BOTH sides, and since MOTIR-1931 both gate the SAME way:
   * on the row's OWN `workspace_id`. So a mirror row belonging to another tenant
   * simply does not join — the realized half comes back null rather than leaking
   * — while a repo Motir CREATED for this workspace now DOES join, and the row
   * reads `established: true`. Before that change `github_repo` gated through its
   * parent installation, and a created repo sits behind the shared provisioning
   * installation: the join returned NULL, `established` was false, and
   * `toProjectRepoNames` dropped the row, so the repo was never dispatchable.
   *
   * `ORDER BY position` matches every other positioned table in this schema
   * (`work_item` / `board_column` / `workflow_status`), so the set sorts by the
   * same rule and the same collation as the rest of the product.
   *
   * Takes `tx` (not optional): the caller is inside `withWorkspaceContext`, which
   * is what binds the GUC both policies read.
   */
  async listByProject(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRepoWithRealized[]> {
    const rows = await tx.$queryRaw<JoinedRow[]>`
      SELECT
        pr."id"                AS "id",
        pr."workspace_id"      AS "workspaceId",
        pr."project_id"        AS "projectId",
        pr."role"              AS "role",
        pr."label"             AS "label",
        pr."name"              AS "name",
        pr."seed_source"       AS "seedSource",
        pr."state"             AS "state",
        pr."failure_reason"    AS "failureReason",
        pr."proposal_signal"   AS "proposalSignal",
        pr."github_repo_id"    AS "githubRepoId",
        pr."position"          AS "position",
        pr."ci_actions_disabled"   AS "ciActionsDisabled",
        pr."ci_actions_intent_at"  AS "ciActionsIntentAt",
        pr."ci_actions_applied_at" AS "ciActionsAppliedAt",
        pr."takeover_state" AS "takeoverState",
        pr."takeover_target_owner" AS "takeoverTargetOwner",
        pr."takeover_requested_at" AS "takeoverRequestedAt",
        pr."takeover_transferred_at" AS "takeoverTransferredAt",
        pr."takeover_completed_at" AS "takeoverCompletedAt",
        pr."takeover_failure_reason" AS "takeoverFailureReason",
        oc."github_login"      AS "ownerLogin",
        oc."permission"        AS "ownerPermission",
        oc."invited_at"        AS "ownerInvitedAt",
        oc."accepted_at"       AS "ownerAcceptedAt",
        oc."invitation_url"    AS "ownerInvitationUrl",
        pr."created_at"        AS "createdAt",
        pr."updated_at"        AS "updatedAt",
        gr."id"                AS "repoRowId",
        gr."provider"          AS "repoProvider",
        gr."workspace_id"      AS "repoWorkspaceId",
        gr."organization_id"   AS "repoOrganizationId",
        gr."installation_id"   AS "repoInstallationId",
        gr."repo_id"           AS "repoHostId",
        gr."owner"             AS "repoOwner",
        gr."name"              AS "repoName",
        gr."default_branch"    AS "repoDefaultBranch",
        gr."archived"          AS "repoArchived",
        gr."created_at"        AS "repoCreatedAt",
        gr."updated_at"        AS "repoUpdatedAt",
        -- THE INDEX-STATE COLUMNS RIDE ALONG (MOTIR-4724). They are here because
        -- this projection reconstructs a WHOLE GithubRepo by hand: a column added
        -- to the model and not added here is a TYPE ERROR rather than a silently
        -- missing field, which is what makes the hand-built row safe to keep. The
        -- room does not render them today; the row is honest either way.
        -- (No backticks in this block: it is inside a tagged template, and one
        --  would end the literal — which is exactly how this first broke.)
        gr."default_branch_head_sha" AS "repoDefaultBranchHeadSha",
        gr."indexed_head_sha"        AS "repoIndexedHeadSha",
        gr."indexed_at"              AS "repoIndexedAt",
        gr."indexing_run_id"         AS "repoIndexingRunId"
      FROM "project_repository" pr
      LEFT JOIN "github_repo" gr ON gr."id" = pr."github_repo_id"
      -- The APPROVING USER's record only: permission = 'admin' is what selects it
      -- (ADR §3 Q2), and there is at most one per row, so this stays a to-one
      -- join and the set read stays one statement per set — not one per member.
      LEFT JOIN "project_repository_collaborator" oc
        ON oc."project_repository_id" = pr."id" AND oc."permission" = 'admin'
      WHERE pr."project_id" = ${projectId} AND pr."workspace_id" = ${workspaceId}
      ORDER BY pr."position" ASC
    `;
    return rows.map(toNested);
  },

  /** One set row by id, workspace-scoped, with its realized repo. Optional `tx`
   *  joins a surrounding transaction (the locked re-read inside a transition). */
  async findById(
    id: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectRepoWithRealized | null> {
    const client = tx ?? dbRead;
    return client.projectRepo.findFirst({
      where: { id, workspaceId },
      include: { githubRepo: true, collaborators: COLLABORATOR_COLUMNS },
    });
  },

  /**
   * The rows of a project's set carrying a given ROLE, in set order. Returns a
   * LIST, not one row: a role MAY repeat (ADR §1.2 — two services are two `api`
   * rows), and it is precisely the >1 case a repo resolution must detect and
   * refuse to guess at (§5.3). A read that returned "the first match" would BE
   * that guess.
   */
  async findByProjectAndRole(
    projectId: string,
    role: ProjectRepoRole,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectRepoWithRealized[]> {
    const client = tx ?? dbRead;
    return client.projectRepo.findMany({
      where: { projectId, role, workspaceId },
      include: { githubRepo: true, collaborators: COLLABORATOR_COLUMNS },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * A row of the project's set whose name matches CASE-INSENSITIVELY — the
   * pre-check behind the name-collision guard. Git-host repo names are
   * case-insensitive, so `acme-web` and `Acme-Web` are one repository, while the
   * DB's `(project_id, name)` unique index only catches the exact duplicate.
   * `excludeId` lets a patch ignore the row being edited (renaming a row to its
   * own current name must not collide with itself).
   */
  async findByProjectAndNameInsensitive(
    projectId: string,
    name: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
    excludeId?: string,
  ): Promise<ProjectRepo | null> {
    return tx.projectRepo.findFirst({
      where: {
        projectId,
        workspaceId,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  },

  /**
   * ⚠️ `findByGithubRepoId` IS GONE, AND ITS ABSENCE IS THE POINT (MOTIR-4648).
   *
   * It was `findFirst({ where: { githubRepoId } })`, and its own comment said why
   * that was sound: *"the DB's `github_repo_id` unique index is the real,
   * tenant-blind guard."* The index is dropped — a repository belongs to the
   * ORGANISATION and a repository in two projects is the ordinary case — so the
   * same call would return AN answer rather than THE answer, silently, and
   * whichever row the planner happened to hand back first.
   *
   * A method that quietly changes from total to arbitrary is worse than one that
   * disappears, so it disappeared. Its four callers each took one of the two
   * reads below, with a stated disposition at the call site.
   */

  /**
   * The row in THIS PROJECT that already claims a realized `GithubRepo`, if any —
   * the pre-check behind the surviving guarantee: one repository appears at most
   * once in one project's set.
   *
   * NOT workspace-filtered in its WHERE, exactly as its predecessor was not: the
   * corruption to prevent is within a project, and another workspace's rows are
   * invisible to this read anyway (RLS hides them under the app role). The DB's
   * `@@unique([projectId, githubRepoId])` is the real, tenant-blind guard and its
   * P2002 is translated to a typed error; this read is what turns the common,
   * same-tenant case into a clean 409 instead of a raced insert.
   */
  async findByProjectAndGithubRepoId(
    projectId: string,
    githubRepoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRepo | null> {
    return tx.projectRepo.findFirst({ where: { projectId, githubRepoId } });
  },

  /**
   * EVERY set row realizing one `GithubRepo` — the read for a caller that
   * genuinely wants the SET rather than a single owner.
   *
   * Deliberately plural in its NAME as well as its type, so a caller has to
   * decide what a length of two means for it. That decision is the whole of what
   * MOTIR-4648 asked for at the four call sites: two of them are ATTRIBUTION and
   * must not start guessing, and one is EXISTENTIAL and never needed a single row
   * at all.
   *
   * Ordered by `position` so a caller that does want a deterministic first row
   * gets the project set's own primary ordering rather than the planner's.
   */
  async listByGithubRepoId(
    githubRepoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRepo[]> {
    return tx.projectRepo.findMany({ where: { githubRepoId }, orderBy: { position: 'asc' } });
  },

  /** CLEAR every project's link to one repository — the org-level disconnect's
   *  write (Story MOTIR-4669 · MOTIR-4679). Returns how many rows it touched.
   *
   *  ⚠️ It NULLS the link; it does not delete the rows, and that is
   *  `ProjectRepo.githubRepo`'s own `onDelete: SetNull` decision rather than this
   *  method's — a project's PLAN for a repository outlives its connection to one,
   *  and deleting the rows would delete the plans as a side effect of an
   *  integration change. `state` is left alone deliberately: the row records that
   *  the repository WAS connected, and rewriting that history is a different act
   *  from disconnecting.
   *
   *  ⚠️ WORKSPACE-SCOPED, and the caller LOOPS. `project_repository` carries one
   *  policy — `FOR ALL USING (workspace_id = app.workspace_id)` — with no system
   *  arm, and this card's new `project_repository_org_read` is `FOR SELECT` only
   *  (permissive policies OR-combine for reads; widening the write arm would hand
   *  a sibling workspace a DELETE it never had). So an org-level clear is one
   *  bound write PER affected workspace, not one sweeping statement. The
   *  authorisation happened once, at the org-admin gate; this is the execution. */
  async clearGithubRepoLinks(
    githubRepoId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.projectRepo.updateMany({
      where: { githubRepoId, workspaceId },
      data: { githubRepoId: null },
    });
    return result.count;
  },

  /** The set's LAST position key (the append anchor), or null on an empty set. */
  async findLastPosition(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await tx.projectRepo.findFirst({
      where: { projectId, workspaceId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return row?.position ?? null;
  },

  /**
   * Take a row lock (`SELECT … FOR UPDATE`) so a state transition serializes
   * against a concurrent transition on the SAME row — the lost-update guard for a
   * read-derived write (the lock-before-read-derived-update rule: the legality of
   * the hop is derived from the current state, so the state must not move between
   * the read and the write). Returns the id, or null when the row does not exist;
   * the caller re-reads the row under the lock to re-validate.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "project_repository" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Take a row lock (`SELECT … FOR UPDATE`) on EVERY row of a project's set, in a
   * deterministic order — the serialization point for a write DERIVED from the
   * shape of the whole set rather than from one row (MOTIR-1913's role → repo-name
   * resolution).
   *
   * `lockById` is not enough there: the derived answer depends on how many rows
   * carry a role and which of them are established, so two concurrent establish
   * calls could each lock only their OWN row, read contradictory snapshots of the
   * set, and write pins from both. Locking the set makes the second pass wait and
   * then re-read the truth the first one committed.
   *
   * `ORDER BY "id"` is load-bearing, not tidiness: two passes that took the same
   * rows in different orders would deadlock rather than queue. Every caller
   * therefore acquires this lock FIRST and any `work_item` lock second, so the two
   * tables are always taken in one order.
   *
   * Returns the locked ids (empty for a project with no set — nothing to lock and
   * nothing to resolve); the caller re-reads the rows under the lock.
   */
  async lockByProject(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "project_repository"
      WHERE "project_id" = ${projectId} AND "workspace_id" = ${workspaceId}
      ORDER BY "id"
      FOR UPDATE
    `;
    return rows.map((r) => r.id);
  },

  async create(
    data: Prisma.ProjectRepoUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRepo> {
    return tx.projectRepo.create({ data });
  },

  async update(
    id: string,
    data: Prisma.ProjectRepoUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRepo> {
    return tx.projectRepo.update({ where: { id }, data });
  },

  /** Remove one row from the set. `deleteMany` (not `delete`) so a double-submit
   *  after the row is gone is an idempotent no-op (count 0) rather than a `P2025`
   *  throw. Returns the count. */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.projectRepo.deleteMany({ where: { id } });
    return result.count;
  },

  // ── The CI-Actions intent (MOTIR-1907) ────────────────────────────────────

  /**
   * Every MOTIR-OWNED, realized row in one workspace, with its mirror — the
   * fan-out's unit of work.
   *
   * `state: 'created'` is the ownership test and it is exact: that state is
   * reachable ONLY through `proposed → creating → created` (see
   * `lib/projectRepos/transitions.ts`), i.e. only via the repo-creation
   * primitive. A `connected` row is a repository the USER already owned and
   * merely pointed Motir at — GitHub bills THEM for it, so Motir must never touch
   * its Actions settings. Reading the ownership off the state (rather than off a
   * separate flag someone has to remember to set) is what makes that guarantee
   * structural.
   *
   * `githubRepoId: { not: null }` because an unrealized row has no repository on
   * the host to act on at all.
   */
  async listMotirCreatedByWorkspace(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRepoWithRealized[]> {
    return tx.projectRepo.findMany({
      where: { workspaceId, state: 'created', githubRepoId: { not: null } },
      include: { githubRepo: true, collaborators: COLLABORATOR_COLUMNS },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * The rows in one workspace whose INTENT is not yet asserted on the host —
   * the convergence predicate, and the sweep's entire input.
   *
   * Expressed as raw SQL because it compares two COLUMNS
   * (`applied_at < intent_at`), which Prisma's filter DSL cannot express; the
   * partial index `project_repository_ci_actions_pending_idx` is built on
   * exactly this predicate, over (`workspace_id`, `state`) — the two equalities
   * below, so both land in the index condition rather than a heap filter. Its
   * column list is deliberately NOT `(workspace_id)` alone: that collides with
   * the model's `@@index([workspaceId])` and puts the datamodel in permanent
   * drift against the migration-built database (MOTIR-1960 — the reasoning is
   * on the `@@index` in `schema.prisma`, and CI now fails on that drift). A
   * NULL `applied_at` is "never asserted", which is why it is a separate OR arm
   * rather than something the comparison would cover (SQL's NULL comparison
   * yields NULL, not true — the trap this spells out).
   *
   * ⚠️ `ci_actions_intent_at IS NOT NULL` is the arm that keeps this from
   * matching EVERY row. A freshly created repo has no intent and no applied
   * stamp, and "no intent" is not "unconverged" — the default (Actions enabled)
   * is already the desired state. Without this arm every untouched repository in
   * every Motir-hosted workspace would look pending forever, and each sweep would
   * issue a pointless `enabled: true` PUT for it — the exact runaway the
   * no-op/idempotency criterion is meant to exclude.
   */
  async listCiActionsPendingByWorkspace(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string }>> {
    return tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "project_repository"
      WHERE "workspace_id" = ${workspaceId}
        AND "state" = 'created'
        AND "github_repo_id" IS NOT NULL
        AND "ci_actions_intent_at" IS NOT NULL
        AND ("ci_actions_applied_at" IS NULL
             OR "ci_actions_applied_at" < "ci_actions_intent_at")
      ORDER BY "position" ASC
    `;
  },

  /**
   * Record the DESIRED Actions state on a set of rows, stamping when the intent
   * changed.
   *
   * ⚠️ `ci_actions_disabled: { not: disabled }` in the WHERE is load-bearing, not
   * an optimisation: it makes the write a no-op for rows that ALREADY hold this
   * intent, so `ci_actions_intent_at` does not advance and a row that is already
   * settled is not dragged back into the pending set. Without it, every
   * entitlement pass would re-stamp every row and the sweep would re-issue a
   * GitHub call per repo per pass, forever. Returns how many rows actually
   * changed.
   */
  async setCiActionsIntent(
    ids: string[],
    disabled: boolean,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tx.projectRepo.updateMany({
      where: { id: { in: ids }, ciActionsDisabled: { not: disabled } },
      data: { ciActionsDisabled: disabled, ciActionsIntentAt: at },
    });
    return result.count;
  },

  /** How many rows in this workspace Motir is currently holding DISABLED — the
   *  resume pass's "is this tenant affected at all?" probe, so an hourly job
   *  costs one cheap count per Motir-hosted workspace instead of an entitlement
   *  read per organization. */
  async countCiActionsDisabledByWorkspace(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.projectRepo.count({ where: { workspaceId, ciActionsDisabled: true } });
  },

  /**
   * Mark one row's intent as successfully asserted on the host. Called ONLY after
   * GitHub has accepted the change — a failed call leaves the stamp behind the
   * intent, which is exactly what keeps the row in the sweep.
   *
   * ⚠️ IT COPIES `ci_actions_intent_at` RATHER THAN STAMPING A CLOCK, and that is
   * a correctness requirement, not tidiness. "Applied" means *this* intent has
   * been asserted, so the honest value is the intent's own timestamp — and
   * copying it makes convergence an EQUALITY between two values from ONE clock.
   * Stamping `now()` instead mixes clock domains: the caller's `at` (a passed-in
   * instant — the metering event's, or a test's) against the writer's wall clock,
   * which can sit on either side of it. When wall-clock `now` runs AHEAD of the
   * intent's `at`, `applied > intent` and the row reads converged the moment it
   * is stamped — including for an intent whose call never happened. That is a
   * silently under-enforced tenant, and it is what this shape makes impossible.
   */
  async markCiActionsApplied(id: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`
      UPDATE "project_repository"
      SET "ci_actions_applied_at" = "ci_actions_intent_at"
      WHERE "id" = ${id}
    `;
  },

  // ── The TAKE-IT-OVER saga (MOTIR-711) ─────────────────────────────────────

  /**
   * Every row whose takeover is IN FLIGHT, across one workspace — the resume
   * pass's input, and what a "you have an unfinished handoff" prompt reads.
   *
   * `done` and `failed` are both excluded, for different reasons: `done` needs
   * nothing, and `failed` is only resumed by the USER asking again (re-issuing a
   * transfer that GitHub already refused, unprompted and on a timer, would hammer
   * the API for a condition only a human can clear).
   */
  async listTakeoverInFlightByWorkspace(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRepoWithRealized[]> {
    return tx.projectRepo.findMany({
      where: {
        workspaceId,
        takeoverState: { in: ['requested', 'transfer_pending', 'awaiting_reinstall'] },
      },
      include: { githubRepo: true, collaborators: COLLABORATOR_COLUMNS },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * The row whose takeover is awaiting THIS repository moving to THIS owner — how
   * the `repository` `transferred` webhook finds its saga.
   *
   * Matched on the realized mirror's provider repo id (via the join) rather than
   * on the name, because a transfer can be accompanied by a RENAME and the id is
   * the only thing that survives both. The target owner is checked
   * case-insensitively by the caller, not here — SQL's `citext` is not in play and
   * a `mode: 'insensitive'` filter would silently not use the index.
   */
  async findByRealizedProviderRepoId(
    providerRepoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRepoWithRealized | null> {
    return tx.projectRepo.findFirst({
      where: { githubRepo: { repoId: providerRepoId } },
      include: { githubRepo: true, collaborators: COLLABORATOR_COLUMNS },
    });
  },

  /**
   * Write the takeover fields of one row.
   *
   * A narrow, single-op write taking an explicit patch rather than reusing
   * `update`, so the saga's columns can only be moved through the service that
   * owns the machine — the same reason the CI-Actions intent has its own writers
   * rather than being reachable via a general-purpose update.
   */
  async setTakeover(
    id: string,
    data: {
      takeoverState: ProjectRepoTakeoverState | null;
      takeoverTargetOwner?: string | null;
      takeoverRequestedAt?: Date | null;
      takeoverTransferredAt?: Date | null;
      takeoverCompletedAt?: Date | null;
      takeoverFailureReason?: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRepo> {
    return tx.projectRepo.update({ where: { id }, data });
  },

  /**
   * The realized repositories of a project's ESTABLISHED rows — the input to the
   * runner group's access list (Story MOTIR-1916 · MOTIR-1972).
   *
   * ⚠️ A PROJECT SPANS N REPOSITORIES (`docs/decisions/project-repository-set.md`
   * §1.2), so this is a LIST and the one-repo case is the degenerate one. Rows
   * establish independently and asynchronously (§4.1 — "one may fail or be skipped
   * while the others succeed"), which is why the caller re-reads the whole set on
   * every sync rather than appending the row it just settled.
   *
   * ESTABLISHED-only, via the same {@link ESTABLISHED_PROJECT_REPO_STATES} filter
   * every repo-resolution read applies plus a non-null realized repo: a `proposed`
   * / `creating` / `failed` / `skipped` row names no repository, and there is no
   * id to access-list.
   *
   * `owner` comes back with the id because the CALLER must drop repositories that
   * are not in Motir's provisioning org — a `connected` row points at a repository
   * the USER owns, whose id GitHub would refuse to put in a group belonging to
   * Motir's org. That filter is a policy decision, so it lives in the service; this
   * read stays a single query and hands over the fact it needs.
   */
  async listEstablishedRealizedRepos(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ owner: string; providerRepoId: string }>> {
    const rows = await tx.projectRepo.findMany({
      where: {
        projectId,
        workspaceId,
        state: { in: [...ESTABLISHED_PROJECT_REPO_STATES] },
        NOT: { githubRepoId: null },
      },
      select: { githubRepo: { select: { owner: true, repoId: true } } },
      orderBy: { position: 'asc' },
    });
    return rows
      .map((row) => row.githubRepo)
      .filter((repo): repo is { owner: string; repoId: string } => repo !== null)
      .map((repo) => ({ owner: repo.owner, providerRepoId: repo.repoId }));
  },
};
