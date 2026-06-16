import {
  Prisma,
  type EstimationStatistic,
  type PointScale,
  type Project,
  type ProjectAccessLevel,
  type WorkflowPolicyMode,
} from '@prisma/client';
import { db } from '@/lib/db';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ProjectSquareRank } from '@/lib/projectSquare/rank';

/**
 * One row of the PROJECT SQUARE directory read (Story 6.13 · Subtask 6.13.2) —
 * the public card-projection columns of a `public` project PLUS its owning
 * organisation (the cross-org context the square shows). Carries ONLY the
 * card-projection fields + the keyset cursor field (`createdAt`); no internal
 * project column (access level, estimation config, workspace id, …) is
 * selected, so the directory read cannot leak one. `id` rides along solely as
 * the keyset tiebreak.
 */
export interface ProjectDirectoryRow {
  id: string;
  identifier: string;
  name: string;
  publicOverviewMd: string | null;
  createdAt: Date;
  org: { name: string; slug: string };
}

/** An opaque keyset cursor position for the directory read (createdAt + id tiebreak). */
export interface ProjectDirectoryCursor {
  createdAt: Date;
  id: string;
}

/**
 * One row of a RANKED project-square page (Story 6.13 · Subtask 6.13.4) — the
 * same card projection as {@link ProjectDirectoryRow} PLUS the row's computed
 * rank sort key, which the service turns into the next page's keyset cursor.
 * Exactly one of `sortScore` (the `trending` / `popular` integer key) and
 * `sortTs` (the `recent` timestamp key) is non-null, per the requested rank.
 */
export interface ProjectDirectoryRankedRow extends ProjectDirectoryRow {
  sortScore: number | null;
  sortTs: Date | null;
}

/**
 * A ranked keyset position the directory read seeks strictly past (Subtask
 * 6.13.4): a numeric `score` for the `trending` / `popular` ranks, or a `ts`
 * timestamp for the `recent` rank — each paired with the last row's `id` (the
 * stable tiebreak that makes every rank a deterministic TOTAL order).
 */
export type ProjectDirectoryRankCursor = { score: number; id: string } | { ts: Date; id: string };

/**
 * Trending-score weights (Subtask 6.13.4): a recent UPVOTE counts more than a
 * recent work-item ACTIVITY event, so demand (someone asked for it) outranks
 * mere churn. The exact weights only shift relative ordering — every rank stays
 * a deterministic total order via the `id` tiebreak regardless — so they are a
 * tunable product knob, not a correctness lever.
 */
const TRENDING_VOTE_WEIGHT = 3;
const TRENDING_ACTIVITY_WEIGHT = 1;

/** Map a ranked raw SQL row's card columns → the shared {@link ProjectDirectoryRow} shape. */
function toRankedCardRow(r: {
  id: string;
  identifier: string;
  name: string;
  publicOverviewMd: string | null;
  createdAt: Date;
  orgName: string;
  orgSlug: string;
}): ProjectDirectoryRow {
  return {
    id: r.id,
    identifier: r.identifier,
    name: r.name,
    publicOverviewMd: r.publicOverviewMd,
    createdAt: r.createdAt,
    org: { name: r.orgName, slug: r.orgSlug },
  };
}

// Project repository — single Prisma operations on the `project` table.
// Writes require `tx` (compile-time guarantee they run in a transaction);
// pure read paths use the `db` singleton. No business logic, no DTO
// mapping, no transactions here — those belong in projectsService.

export const projectRepository = {
  /**
   * Read a project by id. Optionally takes `tx` when the caller is already
   * inside a transaction — required when running under the non-bypass
   * prodect_app role with the project RLS policy in force, because the
   * policy keys on the per-transaction `app.workspace_id` GUC that
   * withWorkspaceContext binds. Outside withWorkspaceContext the policy
   * sees NULL and hides every row under the non-bypass role.
   */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<Project | null> {
    const client = tx ?? db;
    return client.project.findUnique({ where: { id } });
  },

  async findBySlug(workspaceId: string, slug: string): Promise<Project | null> {
    return db.project.findUnique({
      where: { workspaceId_slug: { workspaceId, slug } },
    });
  },

  /**
   * Read a project by its workspace-unique `identifier` (the `PROD`-style key
   * that prefixes work-item keys). Backs `projectsService.getByKey` — the
   * `?projectKey=` resolution the agent-dispatch endpoints (7.0.4 / 7.0.5)
   * use. Keyed on the `@@unique([workspaceId, identifier])` compound, so the
   * lookup is inherently workspace-scoped: a project living in another
   * workspace is simply not found (the no-existence-leak contract is enforced
   * one layer up, in the service). Optionally takes `tx` so the read sees the
   * project RLS policy's workspace GUC under the non-bypass prodect_app role,
   * exactly like `findById`.
   */
  async findByIdentifier(
    workspaceId: string,
    identifier: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Project | null> {
    const client = tx ?? db;
    return client.project.findUnique({
      where: { workspaceId_identifier: { workspaceId, identifier } },
    });
  },

  /**
   * Non-archived projects in a workspace, ordered by createdAt asc so the
   * first-created project lands first in any list surface. Optionally takes
   * `tx` so the read happens inside withWorkspaceContext when the caller
   * needs the project RLS policy to see the workspace GUC (production
   * non-bypass role); outside a tx this falls back to the `db` singleton,
   * which is fine for the BYPASSRLS dev/CI role.
   */
  async findByWorkspace(workspaceId: string, tx?: Prisma.TransactionClient): Promise<Project[]> {
    const client = tx ?? db;
    return client.project.findMany({
      where: { workspaceId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  },

  async create(
    data: { workspaceId: string; name: string; slug: string; identifier: string },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.create({ data });
  },

  /**
   * Resolve a PUBLIC project by its `identifier` (the `PROD`-style key) WITHOUT
   * a workspace scope — the lookup behind the anonymous public view
   * (`/p/[identifier]`, Story 6.12 · Subtask 6.12.4). The public surface knows
   * only the key, not the workspace, so this is one of the few deliberately
   * cross-workspace reads; it is constrained to `accessLevel = 'public'` and
   * non-archived rows so it can never resolve a private/internal project (the
   * no-existence-leak posture is preserved — a non-public key resolves to null,
   * and the projectAccessService gate re-confirms `public` regardless).
   * `identifier` is unique per workspace; if two workspaces ever both made a
   * project with the same key public, this returns the most recently updated
   * (deterministic) — an acceptable edge for the showcase tenant, and a true
   * collision is resolved by the gate + the key-uniqueness the product enforces
   * per workspace. Read-only → `db` singleton.
   */
  async findPublicByIdentifier(identifier: string): Promise<Project | null> {
    return db.project.findFirst({
      where: { identifier, accessLevel: 'public', archivedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
  },

  /**
   * Every PUBLIC (accessLevel = 'public'), non-archived project across ALL
   * workspaces — the read behind `app/sitemap.ts` (Story 6.12 · Subtask
   * 6.12.4). This is the ONE project read that is deliberately NOT
   * workspace-scoped: a public project is crawlable cross-org, so the sitemap
   * lists every one regardless of tenant. Read-only path → `db` singleton.
   * Ordered by `updatedAt` desc so the freshest public projects lead the
   * sitemap. Returns only the columns the sitemap needs.
   */
  async listPublic(): Promise<Array<Pick<Project, 'identifier' | 'updatedAt'>>> {
    return db.project.findMany({
      where: { accessLevel: 'public', archivedAt: null },
      select: { identifier: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
  },

  /**
   * The PROJECT SQUARE directory read (Story 6.13 · Subtask 6.13.2) — a page of
   * `public`, non-archived projects across ALL workspaces/orgs, ordered by a
   * DETERMINISTIC total order (`createdAt` desc, then `id` desc as the stable
   * tiebreak) and CURSOR-paginated via a keyset (finding #57 — a system-level
   * list could be thousands, so NEVER load-all / never OFFSET-the-world). This
   * is the second deliberately cross-org project read (alongside `listPublic`,
   * the sitemap): a public project is discoverable cross-org, so NO workspace
   * filter is applied. The `accessLevel = 'public'` predicate lives HERE, in
   * the single repository read, so no non-public project can leak through any
   * caller. Read-only path → `db` singleton + the app-layer public filter (the
   * RLS-secondary posture the other anonymous public reads use; finding #26).
   *
   * The keyset cursor encodes the previous page's last `(createdAt, id)`; the
   * predicate `createdAt < c.createdAt OR (createdAt = c.createdAt AND id < c.id)`
   * walks strictly past it, so paging skips/duplicates no row even when several
   * projects share a `createdAt`. Selects ONLY the card-projection columns + the
   * org join (no internal field). 6.13.4 swaps in the trending/popular/recent
   * sort keys over this same cursored shape.
   */
  async listPublicDirectory(options: {
    take: number;
    cursor?: ProjectDirectoryCursor;
  }): Promise<ProjectDirectoryRow[]> {
    const { take, cursor } = options;
    const rows = await db.project.findMany({
      where: {
        accessLevel: 'public',
        archivedAt: null,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        identifier: true,
        name: true,
        publicOverviewMd: true,
        createdAt: true,
        workspace: { select: { organization: { select: { name: true, slug: true } } } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      name: r.name,
      publicOverviewMd: r.publicOverviewMd,
      createdAt: r.createdAt,
      org: { name: r.workspace.organization.name, slug: r.workspace.organization.slug },
    }));
  },

  /**
   * A RANKED page of the PROJECT SQUARE (Story 6.13 · Subtask 6.13.4) — the same
   * cross-org `public`, non-archived projects {@link listPublicDirectory}
   * returns, but ordered by one of the three demand ranks instead of creation
   * order, and keyset-paginated over THAT rank's sort key (finding #57 — a
   * system-level list is never load-all). Each rank is a DETERMINISTIC TOTAL
   * order — the rank key with a stable `id DESC` tiebreak — so the keyset cursor
   * skips/duplicates no row across pages even on tied keys:
   *
   *   • `popular`  — LIFETIME total upvotes across the project's public requests
   *     (the "most-starred" axis; 6.12.6 shipped no viewer count, so upvotes are
   *     the real lifetime signal — the documented `ProjectSquareStatsDto` gap).
   *   • `trending` — RECENT demand inside `cutoff..now`: windowed upvotes
   *     (weighted {@link TRENDING_VOTE_WEIGHT}) + windowed work-item activity
   *     (weighted {@link TRENDING_ACTIVITY_WEIGHT}), so a freshly-surging project
   *     outranks a higher-lifetime-but-stale one. `cutoff` is a bound JS Date the
   *     SERVICE computes (`now - windowMs`) — NEVER SQL `NOW()` (a timestamp /
   *     timestamptz session-TZ skew, flaky in CI; the `aggregateCreatedByBucket`
   *     rule). REQUIRED for this rank.
   *   • `recent`   — newly-made-public: `COALESCE(madePublicAt, createdAt)` DESC,
   *     so a project sorts by when it became public, falling back to its creation
   *     moment when it predates the `made_public_at` column (every row therefore
   *     has a non-null key — no NULL-ordering ambiguity).
   *
   * The score subqueries are CORRELATED per project — computed at read time over
   * the live 6.12.6 vote/activity rows, NOT a denormalized rank column this story
   * must keep fresh. If this proves too costly at scale, the durable shape is a
   * bounded MATERIALIZED read (still deterministic + cursored), not a
   * load-all-then-sort-in-memory shortcut. Scalar subqueries (not joins) keep the
   * per-project aggregates from fanning out the row set. Read-only cross-org path
   * → `db` singleton + the in-SQL `accessLevel = 'public'` filter (the
   * RLS-secondary posture the other anonymous public reads use; finding #26).
   */
  async listPublicDirectoryRanked(options: {
    rank: ProjectSquareRank;
    take: number;
    cursor?: ProjectDirectoryRankCursor;
    /** Required for `trending` — the recency-window cutoff (a bound JS Date). */
    cutoff?: Date;
  }): Promise<ProjectDirectoryRankedRow[]> {
    const { rank, take, cursor, cutoff } = options;

    // The shared card projection + the cross-org join + the single public filter
    // (the `accessLevel = 'public'` predicate lives HERE so no non-public project
    // leaks through any rank). `public_overview_md` is `@map`-ed; the rest of the
    // project/org columns are camelCase, so they are quoted as-is.
    const cardCols = Prisma.sql`
      p."id" AS "id",
      p."identifier" AS "identifier",
      p."name" AS "name",
      p."public_overview_md" AS "publicOverviewMd",
      p."createdAt" AS "createdAt",
      o."name" AS "orgName",
      o."slug" AS "orgSlug"`;
    const fromPublic = Prisma.sql`
      FROM "project" p
      JOIN "workspace" w ON w."id" = p."workspaceId"
      JOIN "organization" o ON o."id" = w."organizationId"
      WHERE p."accessLevel" = 'public'::"project_access_level" AND p."archivedAt" IS NULL`;

    if (rank === 'recent') {
      // Timestamp rank: COALESCE(madePublicAt, createdAt) DESC, id DESC.
      const tsCursor = cursor && 'ts' in cursor ? cursor : undefined;
      const keyset = tsCursor
        ? Prisma.sql`WHERE ("sortTs" < ${tsCursor.ts} OR ("sortTs" = ${tsCursor.ts} AND "id" < ${tsCursor.id}))`
        : Prisma.empty;
      const rows = await db.$queryRaw<
        Array<{
          id: string;
          identifier: string;
          name: string;
          publicOverviewMd: string | null;
          createdAt: Date;
          orgName: string;
          orgSlug: string;
          sortTs: Date;
        }>
      >(Prisma.sql`
        WITH ranked AS (
          SELECT ${cardCols}, COALESCE(p."made_public_at", p."createdAt") AS "sortTs"
          ${fromPublic}
        )
        SELECT * FROM ranked
        ${keyset}
        ORDER BY "sortTs" DESC, "id" DESC
        LIMIT ${take}`);
      return rows.map((r) => ({ ...toRankedCardRow(r), sortScore: null, sortTs: r.sortTs }));
    }

    // Numeric ranks (`popular` / `trending`): score DESC, id DESC.
    const scoreExpr =
      rank === 'popular'
        ? Prisma.sql`(
            SELECT COUNT(*) FROM "public_request_vote" v
              JOIN "work_item" wi ON wi."id" = v."work_item_id"
             WHERE wi."projectId" = p."id"
          )::int`
        : // `trending` — windowed upvotes + windowed activity, weighted. The
          // `cutoff` Date is bound, never SQL NOW() (the timestamp-TZ-skew rule).
          Prisma.sql`(
              (SELECT COUNT(*) FROM "public_request_vote" v
                 JOIN "work_item" wi ON wi."id" = v."work_item_id"
                WHERE wi."projectId" = p."id" AND v."created_at" >= ${cutoff})::int * ${TRENDING_VOTE_WEIGHT}
            + (SELECT COUNT(*) FROM "work_item" wa
                WHERE wa."projectId" = p."id" AND wa."archivedAt" IS NULL
                  AND wa."triagedAt" IS NULL AND wa."updatedAt" >= ${cutoff})::int * ${TRENDING_ACTIVITY_WEIGHT}
          )::int`;
    const scoreCursor = cursor && 'score' in cursor ? cursor : undefined;
    const keyset = scoreCursor
      ? Prisma.sql`WHERE ("sortScore" < ${scoreCursor.score} OR ("sortScore" = ${scoreCursor.score} AND "id" < ${scoreCursor.id}))`
      : Prisma.empty;
    const rows = await db.$queryRaw<
      Array<{
        id: string;
        identifier: string;
        name: string;
        publicOverviewMd: string | null;
        createdAt: Date;
        orgName: string;
        orgSlug: string;
        sortScore: number;
      }>
    >(Prisma.sql`
      WITH ranked AS (
        SELECT ${cardCols}, ${scoreExpr} AS "sortScore"
        ${fromPublic}
      )
      SELECT * FROM ranked
      ${keyset}
      ORDER BY "sortScore" DESC, "id" DESC
      LIMIT ${take}`);
    return rows.map((r) => ({
      ...toRankedCardRow(r),
      sortScore: Number(r.sortScore),
      sortTs: null,
    }));
  },

  /**
   * Set the project's PUBLIC-facing fields (Story 6.12) — the authored
   * `publicOverviewMd` README body, the only public-safe content field
   * 6.12.3 added. Used by the 6.12.8 settings editor and by `db:seed` (to seed
   * Motir's own canonical overview). `tx` REQUIRED; the caller has already
   * tenant-/admin-gated the project. Only the provided fields are written.
   */
  async updatePublicFields(
    id: string,
    data: { publicOverviewMd?: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
  },

  /**
   * Acquire a row-level lock on the project inside the caller's transaction —
   * the guarding read for the key-change flow (Story 6.8 · projectsService
   * `changeKey`): lock the row, then run the collision guards + the bulk
   * identifier rewrite + the alias insert, all serialized against a concurrent
   * rename OR a concurrent `allocateWorkItemNumber`-backed issue creation on the
   * same project (the lock-before-read-derived-update rule). Without it two
   * renames could each read the pre-change identifier and clobber each other,
   * or an issue could be minted with the stale prefix mid-rewrite. Returns null
   * when the id doesn't exist. Mirrors workItemRepository.lockById /
   * userRepository.lockById.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "project" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async update(
    id: string,
    data: { name?: string; avatarIcon?: string | null; avatarColor?: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
  },

  /**
   * Set the project's `identifier` (the "key") — the project-row half of the
   * key-change transaction (Story 6.8). The work-item identifier rewrite is the
   * separate bulk op `workItemRepository.rewriteIdentifiersForProject`, and the
   * old key is recorded by `projectKeyAliasRepository.create`; the service
   * orchestrates all three plus the FOR-UPDATE lock in one transaction.
   */
  async updateIdentifier(
    id: string,
    identifier: string,
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data: { identifier } });
  },

  /**
   * Soft-delete: stamp archivedAt = now(). Projects are NEVER hard-deleted
   * — work-item history (Story 1.4) must survive an archive.
   */
  async archive(id: string, tx: Prisma.TransactionClient): Promise<Project> {
    return tx.project.update({ where: { id }, data: { archivedAt: new Date() } });
  },

  /** Flip the project's workflow policy mode (Subtask 2.2.5). */
  async updateWorkflowPolicyMode(
    id: string,
    mode: WorkflowPolicyMode,
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data: { workflowPolicyMode: mode } });
  },

  /**
   * Set the project's browse-access level (Story 6.4 · Subtask 6.4.4). When
   * `stampMadePublicAt` is set (the service passes it on a transition INTO
   * `public`, Subtask 6.13.4), also stamp `madePublicAt = now()` — the "newest"
   * axis the project square's Recent rank orders by. The service stamps only on
   * the not-public → public edge, so a re-save of an already-public project
   * keeps its original go-public moment; a re-publish after going private gets a
   * fresh stamp.
   */
  async setAccessLevel(
    id: string,
    accessLevel: ProjectAccessLevel,
    options: { stampMadePublicAt: boolean },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({
      where: { id },
      data: {
        accessLevel,
        ...(options.stampMadePublicAt ? { madePublicAt: new Date() } : {}),
      },
    });
  },

  /**
   * Set the project's public Overview/README Markdown body (Story 6.12 ·
   * Subtask 6.12.8). `null` clears it (the public Overview tab then falls back
   * to the slim auto-intro, 6.12.4). A public-safe field that rides the public
   * projection only when the project is `public`.
   */
  async setPublicOverview(
    id: string,
    publicOverviewMd: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data: { publicOverviewMd } });
  },

  // --- Estimation config (Story 4.3 · Subtask 4.3.3) ------------------------
  // The project-scoped estimation settings (`estimationStatistic` / `pointScale`
  // / `customScaleValues`; see the story-4.3 module header for the
  // project-scoped justified deviation). Single Prisma ops; the read is a
  // projection (the roll-up only needs the statistic) used by the read-only
  // roll-up paths, so it takes no `tx`; the update REQUIRES `tx`.

  /**
   * Read just a project's estimation config columns (the projection the roll-up
   * statistic resolution + the settings read need). Returns null when the
   * project doesn't exist — the caller (estimationService) owns the tenant gate
   * + the not-found error. Read-only path → `db` singleton.
   */
  async findEstimationConfig(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    estimationStatistic: EstimationStatistic;
    pointScale: PointScale;
    customScaleValues: number[];
  } | null> {
    const client = tx ?? db;
    return client.project.findUnique({
      where: { id },
      select: { estimationStatistic: true, pointScale: true, customScaleValues: true },
    });
  },

  /**
   * Update a project's estimation config (any subset of the three fields). `tx`
   * REQUIRED; the caller (estimationService) has already tenant-gated +
   * admin-gated the project, so this is a plain id-keyed update.
   */
  async updateEstimationConfig(
    id: string,
    data: {
      estimationStatistic?: EstimationStatistic;
      pointScale?: PointScale;
      customScaleValues?: number[];
    },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
  },

  /**
   * Atomically bump the per-project work-item counter and return the new
   * value. Uses UPDATE … RETURNING (NOT a read-then-write) so allocation is
   * gap-free under concurrency: each concurrent caller's UPDATE serializes
   * on the row, and the RETURNING value is the post-increment number. The
   * counter is per-project (the WHERE clause keys on id) so two projects
   * never share or interfere with each other's numbering.
   */
  async allocateWorkItemNumber(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ n: number }>>`
      UPDATE "project" SET "lastWorkItemNumber" = "lastWorkItemNumber" + 1
      WHERE "id" = ${id} RETURNING "lastWorkItemNumber" AS n`;
    if (rows.length === 0) throw new ProjectNotFoundError(id);
    return Number(rows[0]!.n);
  },
};
