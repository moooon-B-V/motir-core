import type { CodeGraphOffboarding, Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// Data access for the CODE-GRAPH OFFBOARDING QUEUE (MOTIR-2166 ·
// `docs/decisions/code-graph-index-fleet.md` §14.5) — one row per pending removal
// of a tenant's derived code graph. Single-op methods only (CLAUDE.md 4-layer);
// every write requires a `tx`.
//
// The policy — which trigger enqueues what, with which `dueAt`, and when a row is
// cancelled — lives in `codeGraphOffboardingService`. Nothing in this file knows
// what a retention window is.
//
// ⚠️ Every method here runs under `withSystemContext`: the table's RLS policy is
// `app.system_admin` and nothing else (see the migration for why a `workspace_id`
// policy would make the row invisible in the one case it exists for).

export interface CodeGraphOffboardingUpsertInput {
  coreWorkspaceId: string;
  coreProjectId: string;
  /** `owner/name`, or `OFFBOARD_ALL_REPOS` for the whole project. */
  repoRef: string;
  dueAt: Date;
  /** A `CodeGraphOffboardReason`. Typed as the string the column holds, because a
   *  repository does not import the policy layer that names them. */
  reason: string;
}

export interface CodeGraphOffboardingScope {
  coreWorkspaceId: string;
  coreProjectId: string;
  repoRef: string;
}

export const codeGraphOffboardingRepository = {
  /**
   * Enqueue one pending removal, idempotently on `(workspace, project, repoRef)`.
   *
   * An UPSERT rather than a create, because the triggers are naturally repeatable:
   * a repo disconnected, reconnected and disconnected again must hold ONE row
   * carrying the LATEST `dueAt`, not a stack of rows whose oldest would remove the
   * graph on a clock the user's most recent action already reset. The update also
   * re-stamps `reason`, so a project archived after one of its repos was
   * disconnected reads as the wider trigger it now is.
   */
  async upsert(
    input: CodeGraphOffboardingUpsertInput,
    tx: Prisma.TransactionClient,
  ): Promise<CodeGraphOffboarding> {
    return tx.codeGraphOffboarding.upsert({
      where: {
        coreWorkspaceId_coreProjectId_repoRef: {
          coreWorkspaceId: input.coreWorkspaceId,
          coreProjectId: input.coreProjectId,
          repoRef: input.repoRef,
        },
      },
      create: input,
      update: { dueAt: input.dueAt, reason: input.reason },
    });
  },

  /**
   * Cancel the pending removals for a scope — the re-onboard path (§14.3).
   *
   * `deleteMany` rather than `delete` so it is idempotent: cancelling when
   * nothing is pending is the common case (most re-indexes follow no disconnect
   * at all) and must be a silent zero, never a P2025.
   *
   * Passing `repoRef` cancels that repo's row ONLY. It deliberately does not also
   * clear the project-wide row: a repo re-connected inside an ARCHIVED project's
   * window has not un-archived the project, and clearing the wider row would
   * cancel a removal the user never reversed.
   */
  async deleteByScope(
    scope: CodeGraphOffboardingScope,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.codeGraphOffboarding.deleteMany({ where: scope });
    return result.count;
  },

  /**
   * The rows whose `dueAt` has passed, oldest first — the sweep's only read
   * (MOTIR-2168). Bounded, so one tick's work is bounded.
   */
  async findDue(
    now: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<CodeGraphOffboarding[]> {
    return tx.codeGraphOffboarding.findMany({
      where: { dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
      take: limit,
    });
  },

  /**
   * How many rows are due — what the sweep reports as REMAINING after a capped
   * tick (MOTIR-2168).
   *
   * Counted from the database rather than inferred from the batch, so a row that
   * came due mid-tick is included: the queue depth is the honest signal, and a
   * silent cap is how a backlog becomes invisible.
   */
  async countDue(now: Date, tx: Prisma.TransactionClient): Promise<number> {
    return tx.codeGraphOffboarding.count({ where: { dueAt: { lte: now } } });
  },

  /** Delete one row by id — how the sweep retires a removal motir-ai confirmed. */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.codeGraphOffboarding.deleteMany({ where: { id } });
    return result.count;
  },

  /** Every pending row for a project, oldest-due first. Read-only (tests, ops). */
  async findByProject(
    coreWorkspaceId: string,
    coreProjectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CodeGraphOffboarding[]> {
    const client = tx ?? db;
    return client.codeGraphOffboarding.findMany({
      where: { coreWorkspaceId, coreProjectId },
      orderBy: { dueAt: 'asc' },
    });
  },
};
