import { Prisma, type PlanTargetLock } from '@/generated/prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { planTargetLockRepository } from '@/lib/repositories/planTargetLockRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { PlanTargetLockedError } from '@/lib/planChange/errors';
import {
  PLANNING_STATUS_KEY,
  PLAN_TARGET_LOCK_SWEEP_BATCH_SIZE,
  isExpired,
  leaseExpiryFrom,
  shouldHoldStatus,
} from '@/lib/planChange/targetLock';

// THE PLANNING-TARGET LOCK (Story MOTIR-2786 · MOTIR-2787) — acquire, hand off,
// release, and recover.
//
// ── THE GAP IT CLOSES ───────────────────────────────────────────────────────
// A planning thread is addressed by SCOPE — `(project, anchor set)`,
// `@@unique([projectId, scopeKey])`. That makes re-opening an IDENTICAL target
// set resume one thread, and does nothing at all about OVERLAPPING ones:
// `[MOTIR-9]` and `[MOTIR-9, MOTIR-4]` are two scope keys naming one common
// item, and both would happily expand it. The exclusion therefore has to live on
// the ITEM, which is what `plan_target_lock.work_item_id UNIQUE` is.
//
// Nothing has collided yet for a reason worth being uncomfortable about: the
// planner runs one job at a time on one machine, so every planning turn in the
// product is globally serialized. That is a far stronger guarantee than anything
// designed, and MOTIR-2783 removes it.
//
// ── WHY IT IS ENFORCED HERE AND NOT IN motir-ai ─────────────────────────────
// motir-core owns the session row, the work item AND the status machine, so
// acquire-or-refuse is one transaction against one database. Setting the status
// from motir-ai over HTTP would make the check-then-act non-atomic across a
// service boundary for no gain. motir-ai's half is only "never run two turns of
// one session concurrently" (MOTIR-2788).
//
// ── THE ROW IS THE LOCK; THE STATUS IS THE AFFORDANCE ───────────────────────
// See `lib/planChange/targetLock.ts` and the migration header. The short version:
// `planning` is also set by hand (MOTIR-2425 parks an unimplementable card there
// until a human acts, and `defaultWorkflow.ts` forbids auto-returning it), and
// only `todo`/`in_progress` have a legal edge into it. So the lease row is the
// authority and the status is its visible face — release and recovery touch ONLY
// items that have a row here, and an item parked at `planning` without one is
// never disturbed.
//
// ── CONCURRENCY ─────────────────────────────────────────────────────────────
// Acquire locks the WORK ITEM row (`SELECT … FOR UPDATE`) before reading the
// lease. That is deliberate rather than locking the lease row: the lease may not
// exist yet, and a `FOR UPDATE` over zero rows locks NOTHING, so every racer
// would fall through the guard together. The work item always exists, so the
// lock is real. The `work_item_id` unique index is still the backstop, and its
// P2002 is translated to `PlanTargetLockedError` — one condition, one outcome,
// however the race was lost.
//
// Multi-item scopes take their row locks in ONE fixed order (work item id,
// ascending) in every path — acquire, hand-off and release alike. Two operations
// touching the same pair of items in opposite orders deadlock instead of queuing.
//
// 4-layer (CLAUDE.md): this service owns the transactions; `planTargetLockRepository`
// is a single-op leaf; the status write goes through `workItemsService.applyStatusTransition`
// (the one validated status path, which this never re-implements).

/**
 * What the lock needs to know about who is asking: the actor plus the project the
 * targets live in.
 *
 * Deliberately NARROWER than `ProjectContext` — a `ProjectContext` carries the
 * resolved project ROW, which every caller here already had a cheaper way to
 * avoid loading. `plansService` releases from a post-commit hook that holds only
 * ids, and making it re-read a project row purely to satisfy a parameter type
 * would be a database round trip bought with nothing. A `ProjectContext` is
 * structurally assignable to this, so the session paths pass theirs unchanged.
 */
export interface PlanTargetLockContext {
  userId: string;
  workspaceId: string;
  projectId: string;
}

/** What one acquire did to one target — returned so callers and tests can assert
 *  the hand-off's shape without re-reading the database. */
export interface PlanTargetLockOutcome {
  workItemId: string;
  identifier: string;
  /** `acquired` — a fresh lease. `refreshed` — this session already held it.
   *  `reclaimed` — the previous holder's lease had expired. */
  disposition: 'acquired' | 'refreshed' | 'reclaimed';
  /** Whether the status was moved to `planning` (or, on a refresh/reclaim, is
   *  being held there by this lease). */
  statusHeld: boolean;
  expiresAt: Date;
}

export interface PlanTargetHandOff {
  /** Identifiers to RELEASE — restored to their prior status. */
  release: readonly string[];
  /** Identifiers to ACQUIRE. */
  acquire: readonly string[];
}

/** One expired lease the sweep dealt with. */
export interface PlanTargetLockSweepEntry {
  workItemId: string;
  outcome: 'restored' | 'left_as_is' | 'unattributable';
}

/**
 * Resolve the scope's identifiers to work items IN this project, ordered by id —
 * the fixed lock order every path uses. An identifier naming nothing is skipped
 * rather than raising: the caller resolved and permission-gated the anchor set
 * before it ever became a scope key, so a miss here means the item was deleted
 * between then and now, and a deleted item is not something to hold.
 */
async function resolveTargets(
  identifiers: readonly string[],
  projectId: string,
  tx: Prisma.TransactionClient,
) {
  if (identifiers.length === 0) return [];
  const items = await workItemRepository.findByIdentifiers(projectId, [...identifiers], tx);
  return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The holder's display name for a refusal, or null when the user is gone. */
async function holderName(
  heldById: string | null,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  if (!heldById) return null;
  const user = await userRepository.findById(heldById, tx);
  return user?.name ?? null;
}

/**
 * Acquire ONE target inside the caller's transaction. The work item's row lock is
 * already held by the caller, so what this reads cannot move underneath it.
 */
async function acquireOne(
  item: { id: string; identifier: string; projectId: string; status: string },
  sessionId: string,
  pctx: PlanTargetLockContext,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<PlanTargetLockOutcome> {
  const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
  const expiresAt = leaseExpiryFrom(now);
  const existing = await planTargetLockRepository.findByWorkItemId(item.id, tx);

  if (existing) {
    if (existing.sessionId !== sessionId && !isExpired(existing.expiresAt, now)) {
      throw new PlanTargetLockedError(
        item.identifier,
        await holderName(existing.heldById, tx),
        existing.expiresAt,
      );
    }
    // Ours (refresh) or expired (reclaim). EITHER WAY `priorStatus` and
    // `statusHeld` are INHERITED, never recomputed: the item is sitting at
    // `planning` right now precisely BECAUSE of this lease, so recomputing would
    // conclude "nothing to hold" and the eventual release would strand it there.
    const updated = await planTargetLockRepository.update(
      existing.id,
      { sessionId, heldById: pctx.userId, expiresAt },
      tx,
    );
    return {
      workItemId: item.id,
      identifier: item.identifier,
      disposition: existing.sessionId === sessionId ? 'refreshed' : 'reclaimed',
      statusHeld: updated.statusHeld,
      expiresAt: updated.expiresAt,
    };
  }

  // Asked of the project's REAL graph rather than a constant, because a project
  // may customize its workflow. `canTransition` opens its own short read
  // transaction on another connection — the same thing `applyStatusTransition`
  // does from inside `boardsService.moveCard`'s transaction — so it neither
  // nests nor contends with the row lock held here.
  const planningIsLegal = await workflowsService.canTransition(
    item.projectId,
    item.status,
    PLANNING_STATUS_KEY,
    pctx.workspaceId,
  );
  const statusHeld = shouldHoldStatus(item.status, planningIsLegal);

  try {
    await planTargetLockRepository.create(
      {
        workspaceId: pctx.workspaceId,
        projectId: item.projectId,
        workItemId: item.id,
        sessionId,
        heldById: pctx.userId,
        priorStatus: item.status,
        statusHeld,
        expiresAt,
      },
      tx,
    );
  } catch (err) {
    // The `work_item_id` unique fired: a racer claimed it without holding the row
    // lock this path takes (or from a connection that saw an older snapshot).
    // Same outcome as losing the lock — a raw P2002 never escapes the service.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new PlanTargetLockedError(item.identifier, null, now);
    }
    throw err;
  }

  if (statusHeld) {
    await workItemsService.applyStatusTransition(item.id, PLANNING_STATUS_KEY, ctx, tx);
  }
  return {
    workItemId: item.id,
    identifier: item.identifier,
    disposition: 'acquired',
    statusHeld,
    expiresAt,
  };
}

/**
 * Release ONE lease inside the caller's transaction, restoring the item's prior
 * status.
 *
 * ⚠️ The restore is CONDITIONAL on the item still being at `planning`. A user who
 * dragged the card out of the Planning column has performed a MANUAL RELEASE —
 * that is the deliberate answer to "ordinary users can still move the status by
 * hand", and it is the right one: a lock whose only escape hatch is a background
 * sweep is a lock a person cannot get out of. Writing our remembered status back
 * over their move would silently undo a human decision.
 */
async function releaseOne(
  lock: PlanTargetLock,
  actor: ServiceContext,
  tx: Prisma.TransactionClient,
  opts: { system?: boolean } = {},
): Promise<'restored' | 'left_as_is'> {
  await workItemRepository.lockById(lock.workItemId, tx);
  const item = await workItemRepository.findById(lock.workItemId, tx);
  await planTargetLockRepository.deleteById(lock.id, tx);

  if (!lock.statusHeld || !item || item.status !== PLANNING_STATUS_KEY) return 'left_as_is';
  await workItemsService.applyStatusTransition(lock.workItemId, lock.priorStatus, actor, tx, {
    // The restore is AUTHORITATIVE, not an interactive move: it puts the item
    // back where it was, and `planning → <prior>` may not be an edge the project's
    // graph carries in the restricted policy. Refusing to undo our own change
    // would leave the item stuck, which is the failure this whole card is about.
    system: opts.system ?? true,
  });
  return 'restored';
}

export const planTargetLockService = {
  /**
   * Take the lock on every target in a scope — the acquire that runs when a
   * planning session OPENS or RESUMES.
   *
   * ALL-OR-NOTHING. One transaction over the whole set, so a scope that overlaps
   * a held item acquires none of it. A partial acquire would leave a caller
   * holding half a scope with no way to name what it holds, and would make a
   * refusal depend on which anchor happened to sort first.
   *
   * Idempotent for the holding session: re-opening the same thread refreshes its
   * lease instead of failing, which is what makes the mount read safe to repeat.
   */
  async acquireForScope(
    sessionId: string,
    identifiers: readonly string[],
    pctx: PlanTargetLockContext,
    now: Date = new Date(),
  ): Promise<PlanTargetLockOutcome[]> {
    if (identifiers.length === 0) return [];
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      (tx) => planTargetLockService.acquireForScopeWithin(sessionId, identifiers, pctx, now, tx),
    );
  },

  /**
   * The transactional CORE of {@link acquireForScope}, factored out so it can run
   * INSIDE a caller-supplied transaction — the same shape, and for the same
   * reason, as `workItemsService.applyStatusTransition`.
   *
   * The caller that needs it is the session OPEN: a thread row that commits while
   * its leases do not is precisely the split the story forbids, because the thread
   * would then exist, be resumable, and hold nothing. So `getOrCreateForScope`
   * creates the row and takes the lock in ONE transaction, and a refusal rolls the
   * whole open back — the conversation was never opened, because its targets were
   * taken. `tx` is REQUIRED; this method never opens a transaction.
   */
  async acquireForScopeWithin(
    sessionId: string,
    identifiers: readonly string[],
    pctx: PlanTargetLockContext,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<PlanTargetLockOutcome[]> {
    if (identifiers.length === 0) return [];
    const targets = await resolveTargets(identifiers, pctx.projectId, tx);
    const outcomes: PlanTargetLockOutcome[] = [];
    for (const item of targets) {
      await workItemRepository.lockById(item.id, tx);
      outcomes.push(await acquireOne(item, sessionId, pctx, now, tx));
    }
    return outcomes;
  },

  /**
   * Move the lock DOWN a level — release one set and acquire another, in ONE
   * transaction.
   *
   * This is the operation the story's hand-off table describes: an epic is held
   * while it is being expanded, and the moment its stories exist the epic goes
   * back to `to do` and the story being broken down takes the lock. Both halves
   * have to commit together. A window where NEITHER is held lets a second session
   * in; a window where BOTH are held blocks a sibling story for no reason.
   *
   * Release runs first WITHIN that transaction, so handing a lock from a parent
   * to a child (or between overlapping sets) does not deadlock against itself.
   */
  async handOff(
    sessionId: string,
    moves: PlanTargetHandOff,
    pctx: PlanTargetLockContext,
    now: Date = new Date(),
  ): Promise<PlanTargetLockOutcome[]> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const releasing = await resolveTargets(moves.release, pctx.projectId, tx);
        for (const item of releasing) {
          const lock = await planTargetLockRepository.findByWorkItemId(item.id, tx);
          // Only OUR leases. A hand-off that could release someone else's lock
          // would be a way around the exclusion rather than a use of it.
          if (lock && lock.sessionId === sessionId) await releaseOne(lock, ctx, tx);
        }
        const acquiring = await resolveTargets(moves.acquire, pctx.projectId, tx);
        const outcomes: PlanTargetLockOutcome[] = [];
        for (const item of acquiring) {
          await workItemRepository.lockById(item.id, tx);
          // Re-read: the release above may have just moved this very item's
          // status, and the acquire's `priorStatus` must be what it is NOW.
          const fresh = await workItemRepository.findById(item.id, tx);
          if (!fresh) continue;
          outcomes.push(await acquireOne(fresh, sessionId, pctx, now, tx));
        }
        return outcomes;
      },
    );
  },

  /**
   * Give back everything one session holds — the terminal path.
   *
   * Called when the level's output exists (the plan was approved) and when it
   * never will (declined). It is deliberately idempotent and total: a session
   * holding nothing releases nothing and returns an empty list, so every caller
   * can call it unconditionally rather than deciding whether there is anything to
   * release. A release that callers have to remember to guard is a release that
   * gets skipped on the error path, which is the path that matters.
   */
  async releaseForSession(
    sessionId: string,
    pctx: PlanTargetLockContext,
  ): Promise<Array<{ workItemId: string; outcome: 'restored' | 'left_as_is' }>> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const locks = await planTargetLockRepository.listBySessionId(sessionId, tx);
        const results: Array<{ workItemId: string; outcome: 'restored' | 'left_as_is' }> = [];
        for (const lock of locks) {
          results.push({ workItemId: lock.workItemId, outcome: await releaseOne(lock, ctx, tx) });
        }
        return results;
      },
    );
  },

  /**
   * Push the session's leases out by a fresh window — the heartbeat, called when
   * the thread does something (a submit).
   *
   * Without it a conversation longer than one lease would have its own targets
   * swept out from under it. With it, the window only starts running down once
   * the session goes quiet, which is precisely the condition it exists to detect.
   */
  async refreshForSession(
    sessionId: string,
    pctx: PlanTargetLockContext,
    now: Date = new Date(),
  ): Promise<number> {
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      (tx) => planTargetLockRepository.extendBySessionId(sessionId, leaseExpiryFrom(now), tx),
    );
  },

  /**
   * RECOVERY — release every lease whose window has run out.
   *
   * This is the path that reaches the case nothing else can. A planner that
   * crashes, a machine that vanishes mid-job, a redeploy, a user who closes the
   * tab: none of them produce an event. The plan stays `generating` until the
   * MOTIR-3064 abandoned-plan sweep asks its job about it (`PlanStatus` still has
   * no `failed` member — that reconciler writes `declined`), and that answer
   * arrives hourly and only for an EMPTY plan, so there is still no product
   * signal to hang a release on — only the passage of time.
   *
   * CROSS-TENANT discovery, PER-TENANT release. The expired set spans workspaces,
   * so the read runs under `withSystemContext` (the table's `FOR SELECT`
   * `app.system_admin` arm exists for exactly this). Each release then binds
   * `app.workspace_id` to that row's own workspace, so no write is ever
   * untenanted.
   *
   * Attribution: the lease's holder, falling back to the workspace owner — the
   * same answer `childStatusCascadeService` gives for a background status write.
   * A status change is signed by somebody in this product, and a lease whose
   * holder was deleted is one of the cases this sweep exists for.
   */
  async releaseExpired(
    now: Date = new Date(),
    batchSize: number = PLAN_TARGET_LOCK_SWEEP_BATCH_SIZE,
  ): Promise<{ released: number; entries: PlanTargetLockSweepEntry[] }> {
    const expired = await withSystemContext((tx) =>
      planTargetLockRepository.listExpired(now, batchSize, tx),
    );
    if (expired.length === 0) return { released: 0, entries: [] };

    const entries: PlanTargetLockSweepEntry[] = [];
    for (const lock of expired) {
      // Resolve the signer in ITS OWN workspace-bound read, then release in a
      // second bound transaction. Two short transactions rather than one bare one
      // that binds mid-flight: the workspace is already known here (it came off
      // the lease), so there is nothing a mid-block bind would buy, and a bound
      // wrapper is the shape every other tenant write in this codebase has.
      const actorId = await withWorkspaceServiceContext(lock.workspaceId, async (tx) => {
        const owner = await workspaceMembershipRepository.findOwnerByWorkspace(
          lock.workspaceId,
          tx,
        );
        return lock.heldById ?? owner?.userId ?? null;
      });

      if (!actorId) {
        // Nobody to sign the restore with. Still drop the lease — a held item
        // nobody can plan is the failure this sweep exists for, and leaving the
        // row would preserve it in order to protect a status nobody can attribute.
        await withWorkspaceServiceContext(lock.workspaceId, (tx) =>
          planTargetLockRepository.deleteById(lock.id, tx),
        );
        entries.push({ workItemId: lock.workItemId, outcome: 'unattributable' });
        continue;
      }

      const actor: ServiceContext = { userId: actorId, workspaceId: lock.workspaceId };
      const outcome = await withWorkspaceContext(
        { userId: actorId, workspaceId: lock.workspaceId, projectId: lock.projectId },
        async (tx) => {
          // RE-READ under the transaction that will act. The row was chosen from
          // a snapshot taken in a different transaction, and the session may have
          // released it in between — a sweep that deletes on a stale read raises
          // P2025 on a lease somebody already gave back.
          const fresh = await planTargetLockRepository.findByWorkItemId(lock.workItemId, tx);
          if (!fresh || fresh.id !== lock.id) return 'left_as_is' as const;
          return releaseOne(fresh, actor, tx, { system: true });
        },
      );
      entries.push({ workItemId: lock.workItemId, outcome });
    }
    return { released: entries.length, entries };
  },
};
