import type { AgentInstance, AgentInstanceState, Prisma } from '@/generated/prisma/client';
import { RUNNING_STATES } from '@/lib/agentInstances/stateMachine';

// Single Prisma operations on `agent_instance` — one developer's long-lived
// agent machine and its home volume (Story MOTIR-6860 · MOTIR-6870,
// `docs/decisions/agent-instances.md` §4).
//
// ⚠️ EVERY METHOD TAKES `tx`, READS INCLUDED — the departure
// `dispatchRunRepository` makes, for its reason: every row is gated by an RLS
// policy on `app.workspace_id`, bound only on a transaction, and a read through
// the bare singleton returns an EMPTY LIST rather than failing. Requiring `tx`
// makes that a type error. The cross-tenant reads (the fleet-wide count, the
// sweep's discovery) run under `withSystemContext` against the table's
// `FOR SELECT` system arm; every write runs bound to the row's own workspace.
//
// No business logic, no transactions, no DTO mapping — the lifecycle service
// (MOTIR-6872) composes these.

/** The create payload, named here so callers above never spell a Prisma input type. */
export type AgentInstanceCreateInput = Prisma.AgentInstanceUncheckedCreateInput;

/** The persistent handle `provisionPersistent` returns (§1), as stored on the row. */
export interface AgentInstanceHandleColumns {
  flyApp: string;
  machineId: string;
  volumeId: string;
}

/** What a guarded transition may write beside the new state. */
export interface AgentInstanceTransitionPatch {
  /** `failed`'s reason in words; `null` clears it (a later wake). */
  failureReason?: string | null;
  /** Bump the idle signal in the same write (create and wake do). */
  lastActivityAt?: Date;
}

/** One page of the owner's list. */
export interface AgentInstanceOwnerPage {
  ownerId: string;
  /** Narrow to one project; omit for every project in the bound workspace. */
  projectId?: string | undefined;
  take: number;
  skip: number;
}

/** A live row — `deletedAt IS NULL` — the only rows any list or owner read returns. */
const LIVE = { deletedAt: null } as const;

export const agentInstanceRepository = {
  /** Insert an instance at `starting`. `tx` required — a write. */
  async create(
    data: AgentInstanceCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance> {
    return tx.agentInstance.create({ data });
  },

  /** A live instance by id, ONLY if `ownerId` owns it (§8 — no key opens another's). */
  async findLiveForOwner(
    id: string,
    ownerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance | null> {
    return tx.agentInstance.findFirst({ where: { id, ownerId, ...LIVE } });
  },

  /** An instance by id, deleted or not — the sweep's and the charge's read. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<AgentInstance | null> {
    return tx.agentInstance.findUnique({ where: { id } });
  },

  /** The owner's live instances, newest first, one page. */
  async listLiveForOwner(
    page: AgentInstanceOwnerPage,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance[]> {
    return tx.agentInstance.findMany({
      where: {
        ownerId: page.ownerId,
        ...(page.projectId ? { projectId: page.projectId } : {}),
        ...LIVE,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.take,
      skip: page.skip,
    });
  },

  /** The total behind {@link listLiveForOwner}, for the page's pagination. */
  async countLiveForOwner(
    page: Pick<AgentInstanceOwnerPage, 'ownerId' | 'projectId'>,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.agentInstance.count({
      where: {
        ownerId: page.ownerId,
        ...(page.projectId ? { projectId: page.projectId } : {}),
        ...LIVE,
      },
    });
  },

  /**
   * THE GUARDED TRANSITION (§4) — ONE conditional UPDATE that applies only while
   * the row is live and still in one of `from`. Returns how many rows moved: `1`
   * for the winner, `0` for a caller whose prior state was already stale. Two
   * concurrent callers from the same state therefore cannot both win: Postgres
   * re-evaluates the `WHERE` on the row the first one committed, and the second
   * finds it no longer matches.
   *
   * `stateChangedAt` is written by the same statement, so the timestamp can
   * never disagree with the state it dates.
   */
  async transition(
    id: string,
    from: readonly AgentInstanceState[],
    to: AgentInstanceState,
    at: Date,
    patch: AgentInstanceTransitionPatch,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, state: { in: [...from] }, ...LIVE },
      data: {
        state: to,
        stateChangedAt: at,
        ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
        ...(patch.lastActivityAt ? { lastActivityAt: patch.lastActivityAt } : {}),
      },
    });
    return result.count;
  },

  /** Record the persistent handle once `provisionPersistent` answers. `tx` required. */
  async setHandle(
    id: string,
    handle: AgentInstanceHandleColumns,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, ...LIVE },
      data: handle,
    });
    return result.count;
  },

  /** Bump the idle signal (§2) — later stories' relay and runs call it. `tx` required. */
  async touchActivity(id: string, at: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, ...LIVE },
      data: { lastActivityAt: at },
    });
    return result.count;
  },

  /**
   * The end of `deleting` (§4): stamp `deletedAt`, only from `deleting`, so a
   * row that never passed through the guard cannot be hidden from its owner.
   */
  async markDeleted(id: string, at: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, state: 'deleting', ...LIVE },
      data: { deletedAt: at },
    });
    return result.count;
  },

  /**
   * Running instances for §6's caps — every live row in {@link RUNNING_STATES},
   * narrowed to one organisation when given. The fleet-wide count spans tenants
   * and runs under `withSystemContext`.
   */
  async countRunning(
    scope: { organizationId?: string | undefined },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.agentInstance.count({
      where: {
        state: { in: [...RUNNING_STATES] },
        ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
        ...LIVE,
      },
    });
  },

  /** Live instances a user holds in ANY project — §6's per-user cap. */
  async countLiveForOwnerEverywhere(
    ownerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.agentInstance.count({ where: { ownerId, ...LIVE } });
  },

  /** Live instances in any of `states`, oldest state change first — the sweep's discovery. */
  async listLiveInStates(
    states: readonly AgentInstanceState[],
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance[]> {
    return tx.agentInstance.findMany({
      where: { state: { in: [...states] }, ...LIVE },
      orderBy: [{ stateChangedAt: 'asc' }, { id: 'asc' }],
      take,
    });
  },

  /**
   * Every live record in one instance app — the reconcile's "who owns this
   * machine / volume" read. Deleted rows are excluded, so a machine or volume
   * that only a deleted record names is an orphan.
   */
  async listLiveInApp(app: string, tx: Prisma.TransactionClient): Promise<AgentInstance[]> {
    return tx.agentInstance.findMany({ where: { flyApp: app, ...LIVE } });
  },

  /**
   * Every instance app any record (live or deleted) has ever named — the
   * reconcile walks each one. Distinct, sorted for a stable pass.
   */
  async listDistinctApps(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.agentInstance.findMany({
      where: { flyApp: { not: null } },
      distinct: ['flyApp'],
      select: { flyApp: true },
      orderBy: { flyApp: 'asc' },
    });
    return rows.flatMap((r) => (r.flyApp ? [r.flyApp] : []));
  },
};
