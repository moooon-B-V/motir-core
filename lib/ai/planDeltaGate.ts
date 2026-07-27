// The CONFIRMATION GATE's validation half (7.12.5 · MOTIR-911) — the pure,
// WRITE-FREE re-validation of a human-approved PlanDelta, run BEFORE the persist
// transaction opens.
//
// WHY IT EXISTS. `parsePlanDelta` (lib/ai/planDelta.ts) is a SHAPE gate: it proves
// the body is a well-formed operations array, nothing more. What reaches the
// approve route is the delta the human REVIEWED AND EDITED in the rail — nodes
// re-titled, nodes excluded — so it is a client-submitted document, not the
// planner's own output, and it is never trusted. This module re-derives the
// structural rules INDEPENDENTLY of whatever the planner self-checked:
//
//   * every `create.kind` is a real issue type, and its `type` obeys the
//     leaf-only rule (a `type` on an epic/story is rejected);
//   * every `priority` is one of the five enum values (an unchecked string would
//     otherwise reach Prisma as a raw enum violation — a 500 for a 400 cause);
//   * every intra-delta `parentRef` resolves to a `create` in the SAME delta, no
//     ref is declared twice, and the ref graph is ACYCLIC;
//   * every (parent, child) edge — whether the parent is an existing item
//     (`parentKey`) or a sibling create (`parentRef`) — satisfies the kind-parent
//     grammar via `assertValidParent`, the SAME single-source-of-truth matrix
//     `workItemsService` enforces (lib/issues/parentRules.ts).
//
// It also returns the creates in TOPOLOGICAL order, so the persist pass can
// insert a parent before the child that references it in one forward sweep.
//
// Everything here throws `PlanDeltaValidationError` → HTTP 400: an illegal edge
// in a submitted delta is a MALFORMED REQUEST (the same body will never succeed
// on retry), not a state conflict. `assertValidParent`'s own
// `IllegalParentTypeError` (a 422 in the interactive create/re-parent flows) is
// deliberately translated: at this boundary it describes the document, not the
// tree. Nothing in this module touches the database — it is a pure function of
// (delta, the kinds of the existing nodes it references), which is what lets the
// whole check run before a single row is written.

import {
  PlanDeltaValidationError,
  type PlanDelta,
  type PlanDeltaCreateOp,
  type PlanDeltaUpdateOp,
} from '@/lib/ai/planDelta';
import { assertValidParent, isIssueType, type IssueType } from '@/lib/issues/parentRules';
import { isTypeableKind, isWorkItemType } from '@/lib/issues/executorDefaults';
import { IllegalParentTypeError } from '@/lib/workItems/errors';
import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';

/** The five priority values `WorkItemPriorityDto` admits, as a runtime guard set. */
const PRIORITIES: ReadonlySet<string> = new Set<WorkItemPriorityDto>([
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
]);

/** The only thing the gate needs to know about an ALREADY-EXISTING node: its
 *  kind, which is the left-hand side of every grammar edge it parents. */
export interface ExistingNodeKind {
  readonly kind: string;
}

export interface GatedPlanDelta {
  /** The `create` ops in TOPOLOGICAL order — a parent always precedes a child
   *  that names it through `parentRef`. */
  readonly creates: readonly PlanDeltaCreateOp[];
  /** The `update` ops, in submission order (they have no inter-dependencies). */
  readonly updates: readonly PlanDeltaUpdateOp[];
}

/**
 * Every EXISTING work item the delta references by key — each `update`'s
 * `targetKey` and each `create`'s `parentKey`. The caller resolves these against
 * the active project (which is what makes a foreign node read as absent rather
 * than forbidden) and hands the resolved kinds back to {@link gatePlanDelta}.
 */
export function collectReferencedKeys(delta: PlanDelta): string[] {
  const keys = new Set<string>();
  for (const op of delta.operations) {
    if (op.op === 'create') {
      if (op.parentKey) keys.add(op.parentKey);
    } else {
      keys.add(op.targetKey);
    }
  }
  return [...keys];
}

/**
 * Re-validate an approved delta and return its ops ready to persist. Throws
 * `PlanDeltaValidationError` (→ 400) on the first violation, having written
 * nothing — the whole point of running it before the transaction opens.
 *
 * `existingByKey` must contain an entry for every key {@link collectReferencedKeys}
 * reported; a missing one is itself a violation (the caller could not resolve the
 * node in this project).
 */
export function gatePlanDelta(
  delta: PlanDelta,
  existingByKey: ReadonlyMap<string, ExistingNodeKind>,
): GatedPlanDelta {
  const creates: PlanDeltaCreateOp[] = [];
  const updates: PlanDeltaUpdateOp[] = [];
  // ref → the create op that declares it. Built first, because a `parentRef` may
  // legitimately point FORWARD at a sibling declared later in the array.
  const byRef = new Map<string, PlanDeltaCreateOp>();

  delta.operations.forEach((op, i) => {
    const where = `operations[${i}]`;
    if (op.op === 'create') {
      assertKind(op.kind, where);
      assertFieldEnums(op, where);
      if (op.ref !== undefined) {
        if (byRef.has(op.ref)) {
          throw new PlanDeltaValidationError(`${where}.ref "${op.ref}" is declared twice`);
        }
        byRef.set(op.ref, op);
      }
      creates.push(op);
    } else {
      assertFieldEnums(op, where);
      updates.push(op);
    }
  });

  // STRUCTURE first, then SEMANTICS — the two are different failures and a
  // caller is better served by the more fundamental one. A `parentRef` that
  // names nothing, or a ref cycle, makes the document incoherent; only once it
  // describes a real forest is it meaningful to ask whether its edges are legal.
  for (const [i, op] of creates.entries()) {
    if (op.parentRef !== undefined && !byRef.has(op.parentRef)) {
      throw new PlanDeltaValidationError(
        `create[${i}].parentRef "${op.parentRef}" names no create in this delta`,
      );
    }
  }
  const ordered = topoOrder(creates, byRef);

  for (const [i, op] of ordered.entries()) {
    const where = `create[${i}]`;
    const parentKind = resolveParentKind(op, byRef, existingByKey, where);
    try {
      assertValidParent(parentKind, op.kind as IssueType);
    } catch (err) {
      if (err instanceof IllegalParentTypeError) {
        throw new PlanDeltaValidationError(`${where}: ${err.message}`);
      }
      /* istanbul ignore next -- assertValidParent throws nothing else */
      throw err;
    }
  }

  return { creates: ordered, updates };
}

function assertKind(kind: WorkItemKindDto, where: string): asserts kind is IssueType {
  if (!isIssueType(kind)) {
    throw new PlanDeltaValidationError(`${where}.kind "${kind}" is not a work-item kind`);
  }
}

/**
 * The enum-valued fields, re-checked. `parsePlanDelta` passes `type` and
 * `priority` through as opaque strings (it is a shape gate), so an arbitrary
 * value would otherwise reach the Prisma enum column and surface as a 500 for
 * what is really a malformed request. The LEAF-ONLY rule for `type` is the same
 * one `workItemsService` applies (`isTypeableKind`) — checked here on a create,
 * where the kind is known; an update's kind is the target's and is not changed by
 * a delta, so its `type` is validated for value only.
 */
function assertFieldEnums(op: PlanDeltaCreateOp | PlanDeltaUpdateOp, where: string): void {
  const { type, priority } = op.fields;
  if (type !== undefined && type !== null) {
    if (!isWorkItemType(type)) {
      throw new PlanDeltaValidationError(`${where}.fields.type "${type}" is not a work type`);
    }
    if (op.op === 'create' && !isTypeableKind(op.kind)) {
      throw new PlanDeltaValidationError(
        `${where}.fields.type may not be set on a ${op.kind} (types are leaf-only)`,
      );
    }
  }
  if (priority !== undefined && !PRIORITIES.has(priority)) {
    throw new PlanDeltaValidationError(`${where}.fields.priority "${priority}" is not a priority`);
  }
}

function resolveParentKind(
  op: PlanDeltaCreateOp,
  byRef: ReadonlyMap<string, PlanDeltaCreateOp>,
  existingByKey: ReadonlyMap<string, ExistingNodeKind>,
  where: string,
): IssueType | null {
  if (op.parentRef !== undefined) {
    // Present by the check above.
    const kind = byRef.get(op.parentRef)!.kind;
    assertKind(kind, `${where}.parentRef target`);
    return kind;
  }
  if (op.parentKey !== undefined) {
    const parent = existingByKey.get(op.parentKey);
    if (!parent) {
      throw new PlanDeltaValidationError(`${where}.parentKey "${op.parentKey}" did not resolve`);
    }
    if (!isIssueType(parent.kind)) {
      /* istanbul ignore next -- a persisted row always carries one of the five kinds */
      throw new PlanDeltaValidationError(
        `${where}.parentKey "${op.parentKey}" has an unknown kind "${parent.kind}"`,
      );
    }
    return parent.kind;
  }
  return null; // a root create — `assertValidParent(null, kind)` rules on it
}

/**
 * Order the creates so a parent always precedes the children that reference it,
 * and reject a `parentRef` CYCLE (which no ordering could satisfy, and which a
 * naive one-pass insert would deadlock on or silently mis-parent). Depth-first
 * with a three-colour walk; ops with no ref relationship keep their submitted
 * order, so a delta without intra-delta parenting persists exactly as reviewed.
 */
function topoOrder(
  creates: readonly PlanDeltaCreateOp[],
  byRef: ReadonlyMap<string, PlanDeltaCreateOp>,
): PlanDeltaCreateOp[] {
  const ordered: PlanDeltaCreateOp[] = [];
  const state = new Map<PlanDeltaCreateOp, 'visiting' | 'done'>();

  const visit = (op: PlanDeltaCreateOp, trail: string[]): void => {
    const seen = state.get(op);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      throw new PlanDeltaValidationError(
        `parentRef cycle among creates: ${[...trail, op.ref ?? '(anonymous)'].join(' → ')}`,
      );
    }
    state.set(op, 'visiting');
    if (op.parentRef !== undefined) {
      const parent = byRef.get(op.parentRef);
      /* istanbul ignore else -- gatePlanDelta rejected a dangling parentRef already */
      if (parent) visit(parent, [...trail, op.ref ?? '(anonymous)']);
    }
    state.set(op, 'done');
    ordered.push(op);
  };

  for (const op of creates) visit(op, []);
  return ordered;
}
