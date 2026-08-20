import {
  Prisma,
  type PlanChangeTurn,
  type PlanChangeTurnIntent,
  type PlanChangeTurnRole,
} from '@/generated/prisma/client';
import { db } from '@/lib/db';

// Single Prisma operations on the `plan_change_turn` table (Story 7.30 ·
// MOTIR-1728). Its own repository, not a corner of the session's: the entity
// name wins over the call site (the 4-layer repository-naming rule). Writes
// require `tx`; the thread read takes an optional `tx` so an append can return
// the freshly-extended thread from inside its own transaction.
export const planChangeTurnRepository = {
  async create(
    data: Prisma.PlanChangeTurnUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn> {
    return tx.planChangeTurn.create({ data });
  },

  /** The `assistant` turn a given job already produced on this session, if any —
   *  the IDEMPOTENCY read behind "one planning job, at most one planner turn"
   *  (MOTIR-2226). The client records the turn when its stream settles, and a
   *  reload, a second tab or a retried read all replay that call; keying on the
   *  job makes every replay a no-op instead of a duplicate bubble. Takes `tx`
   *  because it guards a write and must be read UNDER the session's row lock. */
  async findByJobIdAndRole(
    sessionId: string,
    jobId: string,
    role: PlanChangeTurnRole,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn | null> {
    return tx.planChangeTurn.findFirst({ where: { sessionId, workspaceId, jobId, role } });
  },

  /** ONE turn of a session, by id — the read a CORRECTION makes before it re-runs
   *  a turn under the other intent (MOTIR-1818; ADR §3). Scoped by `sessionId`
   *  AND `workspaceId`, so a turn id from another thread — or another tenant —
   *  resolves to null rather than to somebody else's sentence. `tx` is required:
   *  every caller reads it to guard a following write. */
  async findByIdInSession(
    id: string,
    sessionId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn | null> {
    return tx.planChangeTurn.findFirst({ where: { id, sessionId, workspaceId } });
  },

  /** Patch ONE turn in place. Exactly three fields are ever updated — its INTENT,
   *  the flag recording a correction, and the JOB that ran for it — and a turn's
   *  `body`, `seq` and `role` are immutable by design, because the thread is a
   *  record of who said what. Typed to those three rather than to the full update
   *  input so that immutability is a compile-time fact, not a convention.
   *  Requires `tx` (the write rule) — and it is called under the session's row
   *  lock, so a concurrent correction cannot interleave with an append.
   *
   *  ⚠️ `jobId` on a USER turn is MOTIR-1819's addition, and it widens what the
   *  column's own comment said ("Null on `user` turns"). Before the ask path a
   *  user turn produced no job of its own: submitting was a separate gesture that
   *  wrote a `system` marker. An ask submit IS the turn, so the turn is the
   *  natural key for its job — which is what makes the settle a single keyed,
   *  replayable lookup instead of "the most recent user turn", a guess that is
   *  wrong under exactly the concurrency the row lock exists for. */
  async updateIntent(
    id: string,
    data: { intent?: PlanChangeTurnIntent; intentCorrected?: boolean; jobId?: string },
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn> {
    return tx.planChangeTurn.update({ where: { id }, data });
  },

  /** The session's FULL thread in `seq` order — the ordering contract every
   *  consumer (the resume payload, the accumulated intent) depends on, applied
   *  here ONCE rather than at each call site. Workspace-scoped: a session id from
   *  another tenant yields an empty thread. */
  async listBySessionId(
    sessionId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn[]> {
    const client = tx ?? db;
    return client.planChangeTurn.findMany({
      where: { sessionId, workspaceId },
      orderBy: { seq: 'asc' },
    });
  },
};
