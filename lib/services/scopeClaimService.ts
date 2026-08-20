import type { Prisma } from '@/generated/prisma/client';
import type { ClaimActorDto } from '@/lib/dto/claim';
import type {
  ScopeClaimDto,
  ScopeClaimMemberDto,
  ScopeClaimOffenderDto,
  ScopeClaimOutcome,
  ScopeClaimScopeDto,
  ScopeClaimShapeDto,
} from '@/lib/dto/scopeClaim';
import type { SprintBlockerDto } from '@/lib/dto/sprints';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { NoActiveSprintError } from '@/lib/sprints/errors';
import {
  IN_PROGRESS_STATUS_CATEGORY,
  IN_PROGRESS_STATUS_KEY,
  isClaimableState,
  rankClaimRefusal,
  refusedClaimOutcome,
  type ClaimRefusalOutcome,
} from '@/lib/workItems/claimOutcome';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE SCOPE CLAIM (MOTIR-3049) — lock a whole story or sprint, all or nothing.
//
// ── Why this is its own service ─────────────────────────────────────────────
// The claim spans two aggregates: it validates a subtree through
// `workItemsService` and a sprint through `sprintsService`, and `sprintsService`
// already reaches `workItemsService` through `boardsService`. Putting the method
// on `workItemsService` would close that loop into an import cycle for no gain —
// `workItemsService` is the hub everything else composes, and it stays one. So
// the orchestration lives here, where it can import both, and nothing imports it
// but its route.
//
// ── The order of the steps is the design, not an implementation detail ──────
// VALIDATE, then SHAPE, then LOCK. A scope that cannot be finished should cost
// nothing: taking locks and only then discovering the sprint has an out-of-sprint
// blocker punishes every concurrent caller for a question that could have been
// answered without a single lock. And the shape check is cheap and pure, so it
// runs before the locks too.
//
// ── The trade this makes, accepted deliberately ────────────────────────────
// Every card in a claimed scope reads In Progress from t=0, while only one is
// being worked. The board over-reports activity for the length of the run, and
// the words change meaning: "In Progress" stops meaning *an agent is on this
// right now* and starts meaning *this run owns it*. That was weighed against
// exclusive ownership and ownership won (Yue, 2026-08-18) — and the operation's
// own OpenAPI description says so, because the first person to watch eight cards
// go In Progress at once will otherwise think something has broken.

/** What to claim: one container by key, or a project's ACTIVE sprint. */
export type ScopeClaimInput =
  | { kind: 'work_item'; projectId: string; identifier: string }
  | { kind: 'sprint'; projectId: string };

/**
 * How deep a claimable work-item scope may be: the root's DIRECT children and
 * nothing below them.
 *
 * The kind-parent matrix (`lib/issues/parentRules.ts`) permits
 * `story → task → subtask`, so a two-layer story is a legal tree — it is just
 * not a runnable SCOPE. A run that met an intermediate container would be
 * holding a "child" that is really a whole pull-request set, so the answer is a
 * re-plan rather than a dispatch.
 */
const MAX_SCOPE_DEPTH = 1;

/** A resolved scope, ready to lock — or the refusal that stopped it first. */
type ResolvedScope =
  | { ok: true; scope: ScopeClaimScopeDto; projectId: string; memberIds: string[] }
  | { ok: false; scope: ScopeClaimScopeDto; refusal: EarlyRefusal };

/** A refusal reached BEFORE any row was locked — the two scope-shaped ones. */
type EarlyRefusal =
  | { outcome: 'not_finishable'; blockers: SprintBlockerDto[] }
  | { outcome: 'wrong_shape'; shape: ScopeClaimShapeDto };

/** What the locked, re-asserted transaction returns to the presenter. */
type ClaimTransactionResult =
  | { claimed: true; members: ScopeClaimMemberDto[]; transitions: TransitionRecord[] }
  | {
      claimed: false;
      outcome: ClaimRefusalOutcome;
      offender: {
        key: string;
        title: string;
        status: { key: string; category: string | null };
        assigneeId: string | null;
        held: { changedById: string; changedAt: Date } | null;
      };
    };

/** One post-commit event to emit, captured inside the transaction. */
interface TransitionRecord {
  workItemId: string;
  fromStatusKey: string;
  toStatusKey: string;
  revisionId: string;
}

export const scopeClaimService = {
  /**
   * Claim a SCOPE — a container and its children, or a project's active sprint —
   * so that a scoped run owns the WHOLE set before its first agent starts.
   *
   * ONE transaction, all or nothing:
   *
   *   1. Resolve the scope, under the same access checks as every other read.
   *   2. VALIDATE it (`validateWorkItem` for a subtree, `validateSprint` for the
   *      sprint) and refuse an unfinishable one, naming its blockers — BEFORE
   *      taking a single lock.
   *   3. Apply the shape rule for the scope's kind (below).
   *   4. `SELECT … FOR UPDATE` every row, ordered by `id`.
   *   5. Re-assert that EVERY locked row is in the to-do CATEGORY — the same
   *      rule as the keyed claim, so `blocked` stays claimable and `--force`
   *      keeps working.
   *   6. If all hold: assign every row to the caller and flip every row to
   *      `in_progress`, in the same transaction.
   *   7. If ANY row fails, NOTHING is written and the result names the offender,
   *      its status and its holder.
   *
   * ⚠️ THE TWO SCOPE SHAPES ARE ASYMMETRIC, AND THE ASYMMETRY IS THE POINT.
   *
   * A **story is ONE LAYER, and that is checked** — reaching a leaf in more than
   * one hop returns a typed `wrong_shape` carrying the offending child and its
   * depth. It is a RESULT rather than an error because the caller's response is
   * to submit a re-plan, not to retry.
   *
   * A **sprint may have MANY layers, and no shape check applies** — not as a
   * relaxation, but because `validate_sprint` has already done the equivalent
   * work by the time this runs: it refuses any sprint holding an item whose
   * children are neither done nor also in the sprint. Membership is a DIRECT
   * field (`work_item.sprintId`), never inherited, so once that validator passes
   * the member list is already the complete scope at whatever depth it spans.
   * A layer check on top would reject perfectly ordinary sprints in exchange for
   * catching nothing the validator lets through.
   *
   * ⚠️ CLAIMING THE CONTAINER IS DELIBERATE. The story — and, for a sprint, every
   * container among its members — is claimed alongside the leaves: assigned to
   * the caller and moved to `in_progress`. That is consistent with the shipped
   * upward rollup (`autoRollupParentStatus`, default `true`), which only ever
   * ADVANCES a parent, so the run setting it and the rollup managing it do not
   * fight.
   *
   * ⚠️ WHAT THIS CANNOT SEE, exactly as the keyed claim cannot: a session that
   * dies mid-run leaves a working tree behind and no status change at all. The
   * lock and a worktree pre-flight answer different questions.
   */
  async claimScope(input: ScopeClaimInput, ctx: ServiceContext): Promise<ScopeClaimDto> {
    const resolved =
      input.kind === 'work_item'
        ? await resolveWorkItemScope(input.projectId, input.identifier, ctx)
        : await resolveSprintScope(input.projectId, ctx);

    if (!resolved.ok) return presentEarlyRefusal(resolved.scope, resolved.refusal);

    // The CI-credit gate (MOTIR-1901 · `ci-minutes-allowance.md` §6.2–6.3). This
    // is the FIFTH dispatch entry point, and the rule `getNextReady` states holds
    // here too: a gate on some of them is a gate a caller can walk around.
    // Deliberately BEFORE the claim transaction — a refusal must not consume a
    // scope, and flipping a story to `in_progress` and then refusing would strand
    // every card in it.
    await ciAllowanceService.assertDispatchAllowed(ctx);

    // Deterministic lock order. `lockByIds` sorts in SQL as well — this sort is
    // what makes the transitions below run in the same order the locks were
    // taken, so a reader of the revision trail sees one sequence and not two.
    const orderedIds = [...resolved.memberIds].sort();

    const result = await withWorkspaceContext(ctx, (tx) =>
      runScopeClaim(orderedIds, resolved.projectId, ctx, tx),
    );

    // Post-commit, exactly like `claimWorkItem` and `updateStatus` (the 5.1.2
    // rule): a side effect after a durable write never rides inside it. One event
    // per member, because each is a real transition somebody may be watching.
    if (result.claimed) {
      for (const t of result.transitions) {
        await sendEvent('work-item/transitioned', {
          workspaceId: ctx.workspaceId,
          workItemId: t.workItemId,
          actorId: ctx.userId,
          fromStatusKey: t.fromStatusKey,
          toStatusKey: t.toStatusKey,
          revisionId: t.revisionId,
        });
      }
      return {
        scope: resolved.scope,
        outcome: 'claimed',
        claimed: true,
        members: result.members,
        offender: null,
        shape: null,
        blockers: [],
      };
    }

    return {
      scope: resolved.scope,
      outcome: result.outcome,
      claimed: false,
      members: [],
      offender: await presentOffender(result.offender),
      shape: null,
      blockers: [],
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Scope resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a WORK-ITEM scope: the container plus its direct children.
 *
 * The tenant gate, the browse gate and the 404-not-403 answer for a key in
 * another workspace all come from `getWorkItemByIdentifier` — the SAME read
 * every other keyed operation opens with, so this surface cannot disagree with
 * `get_work_item` about what exists.
 *
 * A CHILDLESS target resolves to a scope of one and is claimed as such. Refusing
 * it would be a special case that buys nothing: the caller would have to know
 * the shape before choosing which endpoint to call, which is the branch this
 * result shape exists to remove.
 */
async function resolveWorkItemScope(
  projectId: string,
  identifier: string,
  ctx: ServiceContext,
): Promise<ResolvedScope> {
  const root = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
  const scope: ScopeClaimScopeDto = {
    kind: 'work_item',
    key: root.identifier,
    sprintId: null,
    name: root.title,
  };

  // VALIDATE FIRST — before the shape read and long before any lock.
  const validity = await workItemsService.validateWorkItem(projectId, identifier, ctx);
  if (!validity.valid) {
    return {
      ok: false,
      scope,
      refusal: { outcome: 'not_finishable', blockers: validity.blockers },
    };
  }

  const children = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findChildren(root.id, tx),
  );

  // THE SHAPE RULE. One batched read of the grandchildren answers it, and it
  // answers it with the truth rather than with a constant: `depth` is where the
  // work under the offending child actually sits, which is the number a re-plan
  // has to flatten.
  const grandchildren = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findChildrenForItems(
      children.map((c) => c.id),
      ctx.workspaceId,
      tx,
    ),
  );
  if (grandchildren.length > 0) {
    const offendingIds = new Set(grandchildren.map((g) => g.parentId));
    // `findChildren` is `position`-ordered, so "the first offending child" is the
    // first one a reader of the board would meet — a stable, human-meaningful
    // pick rather than whichever cuid sorted lowest.
    const child = children.find((c) => offendingIds.has(c.id));
    /* v8 ignore next -- every grandchild's parentId came from `children`, so a miss is unreachable */
    if (!child) throw new WorkItemNotFoundError(identifier);
    return {
      ok: false,
      scope,
      refusal: {
        outcome: 'wrong_shape',
        shape: {
          child: child.identifier,
          childTitle: child.title,
          depth: MAX_SCOPE_DEPTH + 1,
        },
      },
    };
  }

  return {
    ok: true,
    scope,
    projectId: root.projectId,
    memberIds: [root.id, ...children.map((c) => c.id)],
  };
}

/**
 * Resolve a SPRINT scope: exactly the items whose OWN `sprintId` is the active
 * sprint's, at whatever depth they sit.
 *
 * Membership is a direct field, not inherited — the shipped `claimNextReady`
 * already scopes with `ready.filter(r => r.sprintId === sprintId)` — so an item
 * sitting UNDER an in-sprint parent but not itself in the sprint is NOT in this
 * set and is NOT claimed. That is the same scope every other sprint read uses,
 * and widening it here would make the claim disagree with the validator that
 * just approved it.
 *
 * Throws `NoActiveSprintError` (409) when the project has no active sprint —
 * the same answer `validate_sprint` gives, since there is nothing to claim.
 */
async function resolveSprintScope(projectId: string, ctx: ServiceContext): Promise<ResolvedScope> {
  const sprint = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    sprintRepository.findActiveByProject(projectId, ctx.workspaceId, tx),
  );
  if (!sprint) throw new NoActiveSprintError(projectId);

  const scope: ScopeClaimScopeDto = {
    kind: 'sprint',
    key: null,
    sprintId: sprint.id,
    name: sprint.name,
  };

  // VALIDATE FIRST, for the same reason as the subtree — and here the validator
  // is also what makes the missing shape check SOUND rather than merely absent:
  // it guarantees that every in-sprint item's children are done or also in the
  // sprint, so the member set below needs no descent to be complete.
  const validity = await sprintsService.validateSprint(projectId, sprint.id, ctx);
  if (!validity.valid) {
    return {
      ok: false,
      scope,
      refusal: { outcome: 'not_finishable', blockers: validity.blockers },
    };
  }

  const members = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findSprintIssuesExcludingStatuses(sprint.id, ctx.workspaceId, [], tx),
  );
  return { ok: true, scope, projectId, memberIds: members.map((m) => m.id) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The one transaction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lock every member, re-assert the category on ALL of them, then write — or
 * write nothing at all.
 *
 * ⚠️ EVERY ROW IS CHECKED BEFORE ANY ROW IS WRITTEN, which is what makes "one
 * un-claimable member rolls the whole claim back" observable as *no row moved*
 * rather than as *some rows moved and were undone*. The transaction is still
 * what guarantees atomicity if a WRITE throws (an illegal edge, a revoked edit
 * right); the pre-check is what guarantees the ordinary refusal costs nothing.
 */
async function runScopeClaim(
  orderedIds: string[],
  projectId: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<ClaimTransactionResult> {
  // The EDIT gate, once, before the batched assignment. `applyStatusTransition`
  // re-runs it per member under the same `tx`; running it here as well is what
  // gates the assignment write, which is not a status move and would otherwise
  // reach the row first. Parent↔child and sprint membership are both
  // same-project, so one project answers for every member.
  await projectAccessService.assertCanEdit(projectId, ctx, tx);

  const locked = await workItemRepository.lockByIds(orderedIds, tx);
  // A row that vanished between the resolve and the lock. Deleting a card
  // mid-claim is not a refusal the caller can act on — the scope it asked for no
  // longer exists — so it is the ordinary not-found answer, and the transaction
  // unwinds having written nothing.
  /* v8 ignore next -- requires a DELETE landing between two statements of one request */
  if (locked.length !== orderedIds.length) throw new WorkItemNotFoundError(orderedIds.join(', '));

  const states = await workItemRepository.findClaimStatesByIds(orderedIds, tx);

  // ── Step 5: re-assert the CATEGORY on EVERY row ──────────────────────────
  const offenders = states
    .filter((s) => !isClaimableState(s))
    .map((s) => ({ state: s, outcome: refusedClaimOutcome(s.status, s.assigneeId, ctx.userId) }));

  if (offenders.length > 0) {
    // Ranked, not first-by-id — see `rankClaimRefusal`. `states` is `id`-ordered,
    // and `reduce` keeps the FIRST maximum, so within one severity class the
    // named offender is the first in lock order.
    const worst = offenders.reduce((best, candidate) =>
      rankClaimRefusal(candidate.outcome) > rankClaimRefusal(best.outcome) ? candidate : best,
    );
    const held = await workItemRevisionRepository.findLatestStatusChange(worst.state.id, tx);
    return {
      claimed: false,
      outcome: worst.outcome,
      offender: {
        key: worst.state.identifier,
        title: worst.state.title,
        status: { key: worst.state.status, category: worst.state.statusCategory },
        assigneeId: worst.state.assigneeId,
        held,
      },
    };
  }

  // ── Step 6: assign every row, then flip every row ────────────────────────
  // The assignment is ONE batched write (the repository's job); the status is a
  // per-member `applyStatusTransition` (the keyed claim's shape, reused rather
  // than re-derived) because that is what validates the edge against the
  // project's workflow and records the revision the trail is read from. A
  // batched status UPDATE would be faster and would write neither.
  await workItemRepository.assignManyTo(orderedIds, ctx.userId, tx);

  const transitions: TransitionRecord[] = [];
  const members: ScopeClaimMemberDto[] = [];
  const byId = new Map(states.map((s) => [s.id, s]));
  for (const id of orderedIds) {
    const moved = await workItemsService.applyStatusTransition(id, IN_PROGRESS_STATUS_KEY, ctx, tx);
    if (moved.transition) transitions.push({ workItemId: id, ...moved.transition });
    const state = byId.get(id);
    members.push({
      /* v8 ignore next 2 -- `byId` is built from the same id set this loop walks */
      key: state?.identifier ?? moved.dto.identifier,
      title: state?.title ?? moved.dto.title,
      status: { key: moved.dto.status, category: IN_PROGRESS_STATUS_CATEGORY },
    });
  }

  // Ordered by KEY for the wire — the lock order is `id`, which is a cuid and
  // reads as noise to anybody looking at the response.
  members.sort((a, b) => a.key.localeCompare(b.key, 'en'));
  return { claimed: true, members, transitions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation
// ─────────────────────────────────────────────────────────────────────────────

/** A refusal reached before the lock — nothing was read about a holder. */
function presentEarlyRefusal(scope: ScopeClaimScopeDto, refusal: EarlyRefusal): ScopeClaimDto {
  const outcome: ScopeClaimOutcome = refusal.outcome;
  return {
    scope,
    outcome,
    claimed: false,
    members: [],
    offender: null,
    shape: refusal.outcome === 'wrong_shape' ? refusal.shape : null,
    blockers: refusal.outcome === 'not_finishable' ? refusal.blockers : [],
  };
}

/**
 * Name the offender's holder — the assignee AND the actor of the transition that
 * put it where it is.
 *
 * BOTH, because either can be the only one that answers: the assignee column is
 * a LABEL a dispatcher writes for its teammates and nothing guarantees it was
 * written, so `transitionedBy` is what names a holder in the MOTIR-2958 shape.
 * ONE bounded read for at most two ids. An id that resolves to no user yields
 * `null` rather than a cuid — §7 forbids naming a person by internal id whatever
 * the reason.
 */
async function presentOffender(offender: {
  key: string;
  title: string;
  status: { key: string; category: string | null };
  assigneeId: string | null;
  held: { changedById: string; changedAt: Date } | null;
}): Promise<ScopeClaimOffenderDto> {
  const ids = [...new Set([offender.assigneeId, offender.held?.changedById].filter(isPresentId))];
  const users = await userRepository.findByIds(ids);
  const actor = (id: string | null | undefined): ClaimActorDto | null => {
    if (!id) return null;
    const user = users.find((u) => u.id === id);
    return user ? { id: user.id, name: user.name } : null;
  };
  return {
    key: offender.key,
    title: offender.title,
    status: offender.status,
    assignee: actor(offender.assigneeId),
    transitionedBy: actor(offender.held?.changedById),
    transitionedAt: offender.held?.changedAt.toISOString() ?? null,
  };
}

/** A narrowing filter that keeps `Array.filter`'s result type honest. */
function isPresentId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
