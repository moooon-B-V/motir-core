import { Prisma, type ProjectRepo, type ProjectRepoRole } from '@prisma/client';
import { db } from '@/lib/db';
import type { ProjectRepoWithRealized } from '@/lib/mappers/projectRepoMappers';

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
  collaboratorLogin: string | null;
  collaboratorInvitedAt: Date | null;
  collaboratorAcceptedAt: Date | null;
  collaboratorInvitationUrl: string | null;
  // The realized `github_repo` half — every column NULL when the row is
  // unrealized (or when its mirror row was deleted / is invisible under RLS).
  repoRowId: string | null;
  repoProvider: string | null;
  repoWorkspaceId: string | null;
  repoInstallationId: string | null;
  repoHostId: string | null;
  repoOwner: string | null;
  repoName: string | null;
  repoDefaultBranch: string | null;
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
    collaboratorLogin: r.collaboratorLogin,
    collaboratorInvitedAt: r.collaboratorInvitedAt,
    collaboratorAcceptedAt: r.collaboratorAcceptedAt,
    collaboratorInvitationUrl: r.collaboratorInvitationUrl,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    githubRepo:
      r.repoRowId === null
        ? null
        : {
            id: r.repoRowId,
            provider: r.repoProvider!,
            workspaceId: r.repoWorkspaceId!,
            installationId: r.repoInstallationId!,
            repoId: r.repoHostId!,
            owner: r.repoOwner!,
            name: r.repoName!,
            defaultBranch: r.repoDefaultBranch!,
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
        pr."collaborator_login"          AS "collaboratorLogin",
        pr."collaborator_invited_at"     AS "collaboratorInvitedAt",
        pr."collaborator_accepted_at"    AS "collaboratorAcceptedAt",
        pr."collaborator_invitation_url" AS "collaboratorInvitationUrl",
        pr."created_at"        AS "createdAt",
        pr."updated_at"        AS "updatedAt",
        gr."id"                AS "repoRowId",
        gr."provider"          AS "repoProvider",
        gr."workspace_id"      AS "repoWorkspaceId",
        gr."installation_id"   AS "repoInstallationId",
        gr."repo_id"           AS "repoHostId",
        gr."owner"             AS "repoOwner",
        gr."name"              AS "repoName",
        gr."default_branch"    AS "repoDefaultBranch",
        gr."created_at"        AS "repoCreatedAt",
        gr."updated_at"        AS "repoUpdatedAt"
      FROM "project_repository" pr
      LEFT JOIN "github_repo" gr ON gr."id" = pr."github_repo_id"
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
    const client = tx ?? db;
    return client.projectRepo.findFirst({
      where: { id, workspaceId },
      include: { githubRepo: true },
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
    const client = tx ?? db;
    return client.projectRepo.findMany({
      where: { projectId, role, workspaceId },
      include: { githubRepo: true },
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
   * The set row that already claims a realized `GithubRepo`, if any — the
   * pre-check behind the "a repo created for project A is never project B's"
   * guarantee.
   *
   * NOT workspace-filtered in its WHERE, on purpose: the corruption to prevent is
   * cross-PROJECT, and a project in another WORKSPACE is invisible to this read
   * anyway (RLS hides it under the app role). So the DB's `github_repo_id` unique
   * index is the real, tenant-blind guard and its P2002 is translated to a typed
   * error; this read is what turns the common, same-tenant case into a clean 409
   * instead of a raced insert.
   */
  async findByGithubRepoId(
    githubRepoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRepo | null> {
    return tx.projectRepo.findFirst({ where: { githubRepoId } });
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
      include: { githubRepo: true },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * The rows in one workspace whose INTENT is not yet asserted on the host —
   * the convergence predicate, and the sweep's entire input.
   *
   * Expressed as raw SQL because it compares two COLUMNS
   * (`applied_at < intent_at`), which Prisma's filter DSL cannot express; the
   * partial index in the same migration is built on exactly this predicate. A
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
};
