import type { ApprovalGate, ApprovalGateKind, Prisma, WorkItem } from '@/generated/prisma/client';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { ApprovalGateKindUnregisteredError } from '@/lib/approvalGates/errors';
import { designResultGateHandler } from '@/lib/approvalGates/designResultHandler';

// THE APPROVAL-GATE REGISTRY (Story MOTIR-4778 · Subtask MOTIR-4790; ADR
// docs/decisions/approval-gates.md §1).
//
// One decide door serves every gate kind, so the thing that VARIES by kind has
// to live somewhere the door can dispatch to without knowing what a design or a
// pull request is. That is this file: a handler per kind, and a type-level
// contract that the set of handlers is TOTAL over the Prisma enum.
//
// ⚠️ WHY TOTALITY IS THE POINT, AND WHY IT IS A TYPE RATHER THAN A TEST. The
// claim the whole story rests on is that approving means ONE thing whatever is
// being approved. A registry that is merely *usually* complete cannot carry that
// claim: the failure mode is a kind that ships its schema, its surface and its
// creation path, and reaches the door with no handler — at which point the door
// either throws an `undefined is not a function` or, worse, falls through to a
// default and decides something. Consistency maintained by discipline decays;
// consistency maintained by the compiler does not, and the check then runs on
// every build forever with nobody having to remember this paragraph.
//
// THE TWO COMPILE-TIME GUARANTEES, and they are different guarantees:
//
//   1. **A NEW ENUM MEMBER FAILS THE BUILD.** `UnregisteredGateKind` is
//      `Exclude<ApprovalGateKind, RegisteredGateKind>`, and
//      `UNREGISTERED_GATE_KINDS` below is asserted to enumerate it exactly. Add
//      a fifth member to the Prisma enum and that assertion breaks until the
//      member is classified — registered, or deliberately not.
//   2. **PROMOTING A KIND FAILS THE BUILD UNTIL ITS HANDLER EXISTS.**
//      `APPROVAL_GATE_HANDLERS` is `Record<RegisteredGateKind, GateHandler>`, so
//      moving a kind into `RegisteredGateKind` is a missing-property error until
//      somebody writes it. That is the sentence the ADR asks for: *adding the
//      decision gate later is a type error until its handler exists.*
//
// ⚠️ THE HOLES ARE DECLARED, NOT LEFT. A `Record<ApprovalGateKind, Handler |
// null>` would also fail on a new member, and it was rejected: `null` is a
// value, so `decision_approval: null` compiles silently and the hole stops being
// a decision anybody made. Naming the unregistered kinds in their own union, in
// this file, with the card that fills each, is what keeps a hole reviewable.

/**
 * The kinds THIS BUILD registers a handler for.
 *
 * MOTIR-4790 registers exactly one. That is not a partial delivery — it is the
 * shape the epic was split along: this card ships the DOOR with one kind through
 * it, and each later kind is then a row in the enum, a handler, and a renderer
 * rather than a second approval feature.
 */
export type RegisteredGateKind = 'design_result';

/**
 * The kinds that are deliberately NOT registered yet — the registry's
 * compile-time holes, each owned by a named card:
 *
 * | kind                    | owner                                              |
 * | ----------------------- | -------------------------------------------------- |
 * | `decision_approval`     | MOTIR-4907 — the DECISION gate                     |
 * | `pull_request_approval` | MOTIR-4909 / MOTIR-4910 — approve a PR in Motir    |
 * | `pull_request_merge`    | MOTIR-4882 — Motir MERGES the pull request         |
 *
 * ⚠️ The card's own text names ONE hole (`pull_request_merge`), because it was
 * written before MOTIR-4911's ADR amendment added `decision_approval` and split
 * the pull-request kind in two. The merged enum has four members and three
 * holes; `prisma/schema.prisma`'s own comment on `ApprovalGateKind` already says
 * so, and the ADR §1 amendment is the authority.
 */
export type UnregisteredGateKind = Exclude<ApprovalGateKind, RegisteredGateKind>;

/**
 * The unregistered kinds, at RUNTIME — so a surface can say *"this kind is not
 * built yet"* rather than discovering it by a missing key.
 *
 * Its type is what enforces guarantee (1) above: `AssertExhaustive` below fails
 * to compile unless this tuple names every member of `UnregisteredGateKind`,
 * exactly once.
 */
export const UNREGISTERED_GATE_KINDS = [
  'decision_approval',
  'pull_request_approval',
  'pull_request_merge',
] as const satisfies readonly UnregisteredGateKind[];

// TOTALITY, asserted at the type level. `Exclude` gives us the complement of the
// registered set for free; what a type system will NOT give us for free is that
// the runtime list above kept up with it. These two lines are that check, in
// both directions — a member missing from the tuple, and a member in the tuple
// that is no longer unregistered, each fail here.
type _UnregisteredIsExhaustive = AssertEqual<
  (typeof UNREGISTERED_GATE_KINDS)[number],
  UnregisteredGateKind
>;
type _KindsAreExhaustive = AssertEqual<RegisteredGateKind | UnregisteredGateKind, ApprovalGateKind>;

/** Structural equality of two types, as a compile-time assertion. Resolves to
 *  `true` when they are identical and to an error otherwise. */
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : { ERROR: 'approval-gate kinds are not exhaustively classified'; A: A; B: B };

/**
 * What ONE decision DID to the product, returned by a handler's verb so the door
 * can report it and a test can assert it.
 *
 * `statusWritten` is `null` when the decision moved no work item — which is the
 * ordinary answer for `request_changes`, and is also the correct answer for an
 * approval whose card has a pull request coming (see the design-result handler).
 */
export interface GateEffect {
  /** The status key the decision wrote onto the work item, or null when it wrote
   *  none. */
  statusWritten: string | null;
  /** Why no status was written, when none was — for the report and the record.
   *  Absent when `statusWritten` is set. */
  statusDeferredReason?:
    | 'merge_writes_done'
    | 'request_changes_moves_nothing'
    | 'no_status_in_target_category';
}

/** Everything a handler's verb needs, threaded from the door's own transaction. */
export interface GateEffectArgs {
  /** The gate row as it was read UNDER THE LOCK — never a snapshot from before. */
  gate: Pick<ApprovalGate, 'id' | 'workspaceId' | 'projectId' | 'workItemId' | 'subjectId'>;
  /** The work item the gate hangs off, read in the same transaction. */
  item: WorkItem;
  ctx: ServiceContext;
  /** The door's transaction. A handler NEVER opens its own — one service method,
   *  one transaction (CLAUDE.md § 4-layer). */
  tx: Prisma.TransactionClient;
  /**
   * This project's concrete key for the handler's {@link GateHandler.statusIntent},
   * resolved by the door BEFORE its transaction opened. Null when the handler
   * owns no transition, or when a custom workflow has nothing in the target
   * category — a legitimate answer, which the handler turns into "wrote no
   * status" rather than a crash.
   *
   * ⚠️ RESOLVED OUTSIDE THE TRANSACTION, deliberately.
   * `workflowsService.resolveStatusKey` opens its own, so calling it from inside
   * the door's would take a SECOND pooled connection while this one holds the
   * gate's `FOR UPDATE` lock — the deadlock shape `workItemsService` warns about
   * at `applyStatusTransition`. It is reference data (a project's status
   * vocabulary), not a read the decision derives from, so reading it before the
   * lock is both cheaper and correct: CLAUDE.md § 4-layer — *reads of unrelated
   * reference data do NOT need `tx`*.
   */
  resolvedStatusKey: string | null;
}

/**
 * What a KIND must supply to join the one approval language — the table ADR §1
 * exists to make re-usable.
 *
 * A third kind is then *a row in the enum, a handler, and a renderer*: nothing
 * here is about a design or a pull request specifically, which is the property
 * that keeps the door from growing a second vocabulary.
 */
export interface GateHandler<TSubject = unknown> {
  /**
   * Resolve the SUBJECT the gate points at, or null when it no longer resolves.
   *
   * ⚠️ The gate stores an opaque `subjectId` and NOTHING in the schema knows
   * which table it names (ADR §1's amendment — the subject is a document with a
   * resolver). That indirection is what lets a decision document move into the
   * `pages` domain later as a resolver change rather than a migration on the one
   * table an auditor trusts.
   */
  resolveSubject(args: GateEffectArgs): Promise<TSubject | null>;

  /**
   * WHO the gate is shown to — ADR §2: `assigneeId ?? reporterId`, exactly ONE
   * recipient.
   *
   * ⚠️ ROUTING is not AUTHORITY. This answers *whose job is it to look?*; who may
   * PRESS is assignee OR reporter OR admin, applied by the door for every kind
   * (§2's amendment). A gate shown to one person can be decided by three, and
   * that is coherent rather than sloppy — widening authority costs the queue
   * nothing, because a reporter deciding from the item page never sees the gate
   * in their own tab.
   */
  routeTo(args: GateEffectArgs): string | null;

  /**
   * The PERMISSION floor this kind's decision sits on, checked before the
   * relationship test rather than instead of it (ADR §2's amendment: *"The
   * design gate keeps `work_item:edit` as its floor; the relationship test is
   * applied on top of it"*).
   */
  permission: PermissionKey;

  /**
   * **Which STATUS TRANSITION the gate owns, or NONE** — ADR §1's table, verbatim.
   *
   * An INTENT rather than a key, because a project may have renamed its
   * statuses: the door resolves it through `workflowsService.resolveStatusKey`,
   * which prefers the key and falls back to the CATEGORY. Hard-coding a key here
   * is the *never hard-code a status key* rule this indirection exists for.
   *
   * `null` for a kind that moves nothing — `pull_request_merge`, where the
   * webhook moves the card (§4) — and that is a real answer rather than a
   * not-yet: it is what keeps `done` to one writer.
   */
  statusIntent: { key: string; category: StatusCategoryDto } | null;

  /** What `approve` DOES, beyond recording the decision. */
  approve(args: GateEffectArgs): Promise<GateEffect>;

  /** What `request_changes` DOES, beyond recording the decision. */
  requestChanges(args: GateEffectArgs): Promise<GateEffect>;
}

/**
 * THE REGISTRY. Total over {@link RegisteredGateKind}, which is the half of
 * `ApprovalGateKind` this build implements.
 */
export const APPROVAL_GATE_HANDLERS: Record<RegisteredGateKind, GateHandler> = {
  design_result: designResultGateHandler,
};

/** Narrow a gate's kind to one this build can dispatch. */
export function isRegisteredGateKind(kind: ApprovalGateKind): kind is RegisteredGateKind {
  return kind in APPROVAL_GATE_HANDLERS;
}

/**
 * The handler for a gate's kind, or a NAMED refusal.
 *
 * The runtime check exists even though the compile-time one is stronger, because
 * they answer different questions: the type says *this build registers a handler
 * for every kind it claims to*, and this says *the row in front of me carries a
 * kind this build claims*. A row can carry an unregistered kind without any
 * source file being wrong — a fixture, a migration, a half-landed sibling — and
 * the honest answer to that row is a refusal that names the kind, never an
 * `undefined` handler.
 */
export function handlerFor(kind: ApprovalGateKind): GateHandler {
  if (!isRegisteredGateKind(kind)) throw new ApprovalGateKindUnregisteredError(kind);
  return APPROVAL_GATE_HANDLERS[kind];
}
