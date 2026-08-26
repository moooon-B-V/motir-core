import {
  Prisma,
  type Plan,
  type PlanItem,
  type WorkItem,
  type WorkItemKind,
} from '@/generated/prisma/client';

import { keyForAppend } from '@/lib/workItems/positioning';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  classifyBlockerReadiness,
  type BlockerReadinessState,
} from '@/lib/workItems/blockerReadiness';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import {
  planRevisionsService,
  type PlanRevisionAgentActor,
} from '@/lib/services/planRevisionsService';

import { planRepository } from '@/lib/repositories/planRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { normalizeBodyRefs } from '@/lib/workItems/normalizeBodyRefs';
import { autoRelateWorkItemMentions } from '@/lib/workItems/autoRelateMentions';
import { rewriteIntraPlanRefs } from '@/lib/mentions/workItemRefs';
import { sendEvent } from '@/lib/jobs/sendEvent';

import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';

import { ProjectNotFoundError } from '@/lib/projects/errors';
import { NoInitialStatusError } from '@/lib/workItems/errors';
import {
  TEMP_REF_PREFIX,
  assertTempRefsResolvable,
  tempRefsOf,
  type ProposalRefCarrier,
} from '@/lib/plans/refs';
import {
  assertProposalSetSelfConsistent,
  collectReferencedWorkItemIds,
  validatePlanProposals,
  type LiveWorkItemState,
  type ProposalNode,
} from '@/lib/plans/validateProposals';
import { validateStoryPoints, validateEstimateMinutes } from '@/lib/estimation/validate';
import { PLANNING_SOURCES } from '@/lib/api/v1/workItems/schema';
import {
  DuplicatePlanTargetError,
  InvalidProposalError,
  PlanGrammarError,
  PlanItemNotFoundError,
  PlanItemTargetMissingError,
  PlanItemUnknownTargetRepoError,
  PlanNotEditableError,
  PlanProposalReferencedError,
  PlanItemUnknownTargetRepoRoleError,
  PlanNotFoundError,
  PlanNotGeneratingError,
  NoPlanForWorkItemError,
  PlanApproveTimedOutError,
  PlanNotInExpectedStatusError,
  PlanPersistenceError,
  PlanRefGraphError,
  PlanTargetImmutableError,
  type PlanTargetOp,
  UnresolvedPlanRefError,
} from '@/lib/plans/errors';
import { resolveAuthoredTargetRepoInProject } from '@/lib/workItems/dispatchRepo';
import { UnknownTargetRepoError } from '@/lib/workItems/errors';
import { PROJECT_REPO_ROLES, isProjectRepoRole } from '@/lib/projectRepos/vocabulary';

import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import type {
  CreatePlanInput,
  ListPlansOptions,
  PlanDto,
  PlanItemPatch,
  PlanItemProposedFields,
  PlanListPageDto,
  PlanApprovabilityRejectionDto,
  PlanStatusCountsDto,
  PlanWithItemsDto,
  ProposalInput,
  UpdateProposalInput,
  CorrectProposalInput,
} from '@/lib/dto/plans';
import { PLAN_STATUS_DTO_VALUES } from '@/lib/dto/plans';
import { toPlanDto, toPlanItemDto, toPlanWithItemsDto } from '@/lib/mappers/planMappers';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { buildScope } from '@/lib/planChange/scope';
import { planTargetLockService } from '@/lib/services/planTargetLockService';

// The AI-planning Plan substrate (Story 7.21 · MOTIR-1336) — the foundation
// every planner produces into. A `Plan` bundles proposed `PlanItem` operations
// the user reviews and approves/declines as ONE unit. A PlanItem is a PROPOSAL,
// never a row in the work-item tree: an `add` lives only as a PlanItem (no
// WorkItem until approve), and `modify`/`remove` leave their targets untouched
// until approve. On approve the items MATERIALIZE; on decline they drop with
// the tree untouched.
//
// 4-layer (CLAUDE.md): this service owns the transactions + the materialize
// orchestration; every DB op goes through a repository. NOTE — the materialize
// composes the work-item LEAF repositories (`workItemRepository`,
// `workItemLinkRepository`, `workItemRevisionsService`,
// `projectRepository.allocateWorkItemNumber`) directly INSIDE the approve
// transaction rather than calling `workItemsService.createWorkItem` /
// `updateWorkItem`, because those service methods own their OWN
// `db.$transaction` and Prisma cannot nest interactive transactions — calling
// them here would break the "approve applies in ONE transaction" guarantee.
// Composing the tx-aware leaves is the architecturally correct way to materialize
// atomically (the card's `workItemsService.create(proposedFields)` intent, at the
// layer transactional composition actually allows).

// The workflow status a materialized `add` is born at when its edges say it
// cannot start (MOTIR-3050). It is the KEY, not a category: `blocked` sits in
// the `todo` category alongside `todo` itself, so there is nothing structural to
// match on — `lib/workflows/defaultWorkflow.ts` seeds this key into every
// project, and a workflow customized to drop it simply keeps the initial status
// (the resolve-then-check in `materialize` handles that).
const BLOCKED_STATUS_KEY = 'blocked';

// Ten rows a page (MOTIR-3235, down from 20). The Plans list streams — a first
// page, then a bottom sentinel that loads the next — and ten is the number the
// tabbed surface is drawn to. `listPlans` has exactly two callers, both on that
// surface, so the CONSTANT moves rather than each caller passing a literal.
// `MAX_PAGE_LIMIT` is untouched: a caller may still ask for more.
const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(limit)));
}

// The intra-plan temp-ref prefix: a `parentRef` / `blockedByRef` of the form
// `planItem:<planItemId>` points at another `add` in the SAME plan (resolved to
// the created work-item id at materialize). It now LIVES in `lib/plans/refs.ts`
// (so the persist gate can share it without importing this service — that would
// be a cycle) and is RE-EXPORTED here unchanged, so the pre-commit projection
// engine (7.28.1 / planValidityService) keeps resolving refs through the EXACT
// same contract materialize uses — no second source of truth.
export { TEMP_REF_PREFIX };

/**
 * Validate the leaf SIZING of an `add`'s proposed fields (MOTIR-1433) — the
 * SAME rules the create path applies: a Fibonacci-range story-point value
 * (`validateStoryPoints`) and a non-negative integer-minute time estimate
 * (`validateEstimateMinutes`). Both `undefined`/`null` pass (an unsized or
 * non-leaf `add`). Throws `InvalidEstimateError` on a malformed value, so a bad
 * size is rejected at the proposal boundary rather than silently reaching the
 * `estimateMinutes` / `storyPoints` columns at materialize (which bypasses the
 * MCP/route Zod boundary the human-create path validates behind).
 */
function validateProposedSizing(pf: PlanItemProposedFields): void {
  validateStoryPoints(pf.storyPoints ?? null);
  validateEstimateMinutes(pf.estimateMinutes ?? null);
}

/**
 * A SELF-REPORTED free-text provenance value (MOTIR-2986) — the authoring
 * agent's harness or model. Stored as-supplied per
 * `docs/decisions/work-item-provenance.md` Decision 2 ("no server-side
 * validation against a fixed list"), with the one normalization that decision
 * itself names: trimmed, empty → null. An all-whitespace value is not an
 * attribution, and letting one through would render as a blank the reader cannot
 * distinguish from a real harness name.
 */
function normalizeSelfReported(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The planning SOURCE materialize will stamp from an `add` proposal
 * (MOTIR-2990) — validated as a member of the closed `WorkItemPlanningSource`
 * set, or rejected.
 *
 * This is the narrow guard that lets `docs/decisions/work-item-provenance.md`
 * Decision 5's PIN be lifted without weakening the property it protected. The
 * pin held "a proposal cannot CLAIM a source" by never reading the value; the
 * property is now held by the WRITE SEAMS (every one of which sets the source
 * server-side — ADR Q4), and this is the backstop that keeps the COLUMN total:
 * an unrecognised value fails at the proposal boundary rather than reaching a
 * column whose display switch is closed over four members.
 *
 * Absent / null passes — that is the default case, and by far the common one.
 */
function assertKnownPlanningSource(pf: PlanItemProposedFields, label: string): void {
  const source = pf.planningProvenance?.source;
  if (source == null) return;
  if (!(PLANNING_SOURCES as readonly string[]).includes(source)) {
    throw new InvalidProposalError(
      `${label}: unknown planning source \`${source}\` — expected one of ${PLANNING_SOURCES.join(', ')}.`,
    );
  }
}

function validateProposal(p: ProposalInput): void {
  if (p.op === 'add') {
    if (!p.proposedFields || !p.proposedFields.title?.trim()) {
      throw new InvalidProposalError('An `add` proposal requires proposedFields.title.');
    }
    validateProposedSizing(p.proposedFields);
    assertKnownPlanningSource(
      p.proposedFields,
      proposalLabel({ op: p.op, title: p.proposedFields.title }),
    );
    // The repo ROLE (MOTIR-1912) — checked HERE, at the append, because the check
    // is pure (a closed vocabulary, no repository need exist) and the producer is
    // a machine: telling motir-ai its role is unknown while it is still writing
    // the plan is worth far more than discovering it at approve, when a human is
    // waiting. Approve re-checks anyway, for the proposals that predate this.
    assertKnownRepoRole(
      p.proposedFields.targetRepoRole,
      null,
      proposalLabel({ op: p.op, title: p.proposedFields.title }),
    );
  } else if (p.op === 'modify') {
    if (!p.workItemId) throw new InvalidProposalError('A `modify` proposal requires workItemId.');
    if (!p.patch) throw new InvalidProposalError('A `modify` proposal requires a patch.');
    // A `modify` may RE-SCOPE the target's sizing (MOTIR-1532) — validate the
    // patched-in points/estimate at the boundary, the SAME rules the `add` path
    // applies (`validateProposedSizing`), so a malformed re-scope is rejected here
    // (422) rather than reaching the `storyPoints`/`estimateMinutes` columns at
    // materialize. Absent (`undefined`/`null`) passes — a modify that leaves
    // sizing alone, or an explicit `null` that clears it.
    validateStoryPoints(p.patch.storyPoints ?? null);
    validateEstimateMinutes(p.patch.estimateMinutes ?? null);
    // A `modify` may RE-PIN the role (MOTIR-1912) — same vocabulary check as the
    // `add` path, so the two cannot disagree about what a role is.
    assertKnownRepoRole(
      p.patch.targetRepoRole,
      null,
      proposalLabel({ op: p.op, workItemId: p.workItemId }),
    );
  } else {
    // remove
    if (!p.workItemId) throw new InvalidProposalError('A `remove` proposal requires workItemId.');
  }
}

/**
 * Convert a PRISMA failure escaping a plan boundary into a typed
 * {@link PlanPersistenceError} (MOTIR-3194); pass everything else through
 * untouched.
 *
 * ⚠️ THE POINT IS THE `else` BRANCH, not the mapping. `toToolError` RE-THROWS
 * what it does not recognise, and the MCP SDK renders a re-thrown error's
 * `message` into a JSON-RPC internal error — so any Prisma error reaching an MCP
 * boundary IS the caller's error text. Before this, the duplicate-target
 * constraint arrived as ``Invalid `prisma.planItem.create()` invocation: Unique
 * constraint failed on the (not available)``: the ORM's method name, no subject,
 * and a constraint field rendering as nothing.
 *
 * Catching only the one known constraint would have left every other ORM failure
 * on the same path escaping the same way, so this catches the WHOLE Prisma error
 * family by class. It must therefore be conservative in the other direction: the
 * service's own typed errors (`PlanNotFoundError`, `PlanNotGeneratingError`,
 * `DuplicatePlanTargetError`, …) are thrown from INSIDE the same transaction and
 * are returned unchanged — a wrapper that swallowed them would trade one opaque
 * failure for another.
 *
 * The five classes are the complete set the client can throw
 * (`generated/prisma/internal/prismaNamespace.ts`), enumerated rather than matched
 * on a name prefix so a hand-thrown `Error` named like one cannot be mistaken for
 * an ORM failure.
 */
function containPrismaFailure(err: unknown, operation: string): unknown {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientValidationError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError
  ) {
    const ormCode = err instanceof Prisma.PrismaClientKnownRequestError ? err.code : null;
    return new PlanPersistenceError(operation, ormCode);
  }
  return err;
}

/**
 * The targets a plan's proposals already claim — `workItemId → op` (MOTIR-3194).
 *
 * Only a `modify`/`remove` has a target while a plan is `generating`: an `add`
 * carries `workItemId: null` until materialize writes the created id back
 * (`planItemRepository.setWorkItemId`), which is the same reason Postgres's
 * NULL-distinct semantics let a plan hold many `add`s under
 * `@@unique([planId, workItemId])`.
 */
function claimedTargets(items: readonly PlanItem[]): Map<string, PlanTargetOp> {
  const claimed = new Map<string, PlanTargetOp>();
  for (const item of items) {
    if (item.op !== 'add' && item.workItemId) claimed.set(item.workItemId, item.op);
  }
  return claimed;
}

/**
 * Apply an `UpdateProposalInput` over an `add`'s existing `proposedFields`
 * (7.21.6 · MOTIR-1370). SPARSE: only the keys PRESENT in the input change; an
 * absent key (`undefined`) is left as-is, an explicit `null` on a nullable field
 * clears it. The result is re-validated by the caller (title must stay non-empty).
 *
 * ⚠️ `executor` JOINED the editable set on 2026-08-19 (`agent-authored-plans.md`
 * AMENDMENT 4 D3a · MOTIR-3089). This comment used to read "`executor` is never
 * touched (not in the editable set)", which was true and is now the opposite of
 * true. The reason it moved: `type` was always deepenable, `executor` is DERIVED
 * from `type` by `defaultExecutorForType`, and `materialize` writes
 * `pf.executor ?? null` (below) without ever consulting that map — so a
 * titles-first proposal that gained its type on a deepen turn materialized with a
 * null executor and nothing on the way there said so. The ADR rejects the
 * alternative repair (seeding the default inside `materialize`) on the record.
 *
 * ⚠️ STILL NOT in the set, and deliberately: `targetRepo` / `targetRepoRole` (the
 * repo pin is part of a leaf's identity and is settled at append; widening here
 * would give an agent a re-pin the human review surface does not have) and the
 * ref graph `parentRef` / `blockedByRefs` (which live on the PlanItem row, not in
 * `proposedFields`, and whose mutability would let a cycle be built inside a
 * `generating` plan that nothing catches until approve).
 */
function mergeProposedFields(
  current: PlanItemProposedFields,
  input: UpdateProposalInput,
): PlanItemProposedFields {
  const next: PlanItemProposedFields = { ...current };
  if (input.title !== undefined) next.title = input.title;
  if (input.kind !== undefined) next.kind = input.kind;
  if (input.descriptionMd !== undefined) next.descriptionMd = input.descriptionMd;
  if (input.type !== undefined) next.type = input.type;
  if (input.priority !== undefined) next.priority = input.priority;
  if (input.storyPoints !== undefined) next.storyPoints = input.storyPoints;
  if (input.estimateMinutes !== undefined) next.estimateMinutes = input.estimateMinutes;
  if (input.explanationMd !== undefined) next.explanationMd = input.explanationMd;
  // AMENDMENT 4 D3a (MOTIR-3089) — the deepen turn's one widening. Sparse like
  // every key above it: absent leaves the proposal's executor alone, an explicit
  // `null` clears it back to unassigned.
  if (input.executor !== undefined) next.executor = input.executor;
  return next;
}

/** A created-row revision diff ({ field: { from: null, to } }) for a materialized add. */
function buildAddDiff(row: WorkItem): Record<string, { from: null; to: unknown }> {
  const diff: Record<string, { from: null; to: unknown }> = {
    title: { from: null, to: row.title },
    kind: { from: null, to: row.kind },
    status: { from: null, to: row.status },
  };
  if (row.descriptionMd != null) diff.descriptionMd = { from: null, to: row.descriptionMd };
  // AI-drafted explanation (MOTIR-850) — record it when set (null = none is
  // omitted). `explanationMd` has an `editedField()` disposition in
  // lib/activity/renderers.ts, so the created-revision feed renders it; the
  // `explanationSource` metadata column is deliberately NOT diffed (no renderer
  // disposition — the same rule the `modify` path follows for undispositioned keys).
  if (row.explanationMd != null) diff.explanationMd = { from: null, to: row.explanationMd };
  if (row.type != null) diff.type = { from: null, to: row.type };
  if (row.executor != null) diff.executor = { from: null, to: row.executor };
  // Leaf sizing (MOTIR-1433) — mirror `buildCreatedDiff`: record the estimate
  // when set (null = unestimated is omitted). `storyPoints` is a Prisma Decimal,
  // so record it numeric (the same `Number(...)` shape estimationService logs).
  if (row.estimateMinutes != null) diff.estimateMinutes = { from: null, to: row.estimateMinutes };
  if (row.storyPoints != null) diff.storyPoints = { from: null, to: Number(row.storyPoints) };
  // The repo pin (MOTIR-1884) — recorded when the proposal carried one (null =
  // unpinned is omitted, like every other optional field here). `targetRepo` has a
  // `textField()` disposition in lib/activity/renderers.ts, so the created-revision
  // feed renders it.
  if (row.targetRepo != null) diff.targetRepo = { from: null, to: row.targetRepo };
  return diff;
}

/**
 * Topologically order `add` PlanItems so a child (whose `parentRef` is an
 * intra-plan temp-ref `planItem:<id>`) is created AFTER its parent — the parent
 * work item must exist when the child is inserted (a subtask cannot be
 * transiently parent-less under the kind-parent DB trigger). Refs to real ids /
 * null impose no ordering. Throws on a missing intra-plan parent or a cycle.
 */
function topoOrderAdds(adds: PlanItem[]): PlanItem[] {
  const byId = new Map(adds.map((a) => [a.id, a]));
  const ordered: PlanItem[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (a: PlanItem): void => {
    if (visited.has(a.id)) return;
    if (visiting.has(a.id)) throw new UnresolvedPlanRefError(`${TEMP_REF_PREFIX}${a.id}`);
    visiting.add(a.id);
    if (a.parentRef && a.parentRef.startsWith(TEMP_REF_PREFIX)) {
      const parentId = a.parentRef.slice(TEMP_REF_PREFIX.length);
      const parent = byId.get(parentId);
      if (!parent) throw new UnresolvedPlanRefError(a.parentRef);
      visit(parent);
    }
    visiting.delete(a.id);
    visited.add(a.id);
    ordered.push(a);
  };

  for (const a of adds) visit(a);
  return ordered;
}

// ── The confirmation gate at PERSIST (Subtask 7.12.5 · MOTIR-911) ─────────────
//
// `approvePlan` is the ONLY path from a proposal to a row, and it re-validates
// the proposal set INDEPENDENTLY before it writes anything — the grammar
// (`lib/issues/parentRules.ts`) and done-work immutability. The verdict itself
// lives in the pure `lib/plans/validateProposals` module; these three helpers
// are its I/O shell: project the Prisma rows onto its shape, resolve the live
// state it needs, and (inside the transaction) take the row locks first.
//
// It runs TWICE, deliberately:
//   • BEFORE the transaction opens — the cheap typed rejection, with the tree
//     and the plan status provably untouched (nothing has been read FOR UPDATE,
//     nothing written).
//   • INSIDE the transaction, after the plan lock and under the TARGETS' row
//     locks — because a pre-transaction snapshot goes STALE under a concurrent
//     transition or `updateProposal` (`notes.html` #35). This is the verdict
//     that actually gates the write.
// Both calls run the same pure function, so there is no second code path and no
// way to reach `materialize` around it.

/**
 * The synthetic id an INCOMING proposal wears inside the append-time gate
 * (MOTIR-3573). A proposal has no id until `planItemRepository.create` writes
 * one (`PlanItem.id` is `@default(cuid())` and `ProposalInput` carries no id
 * field), so a rejection can only identify it by its POSITION in the batch —
 * which is what the caller sent and can therefore act on.
 */
const INCOMING_PROPOSAL_ID_PREFIX = 'incoming#';

/** Project an unsaved `ProposalInput` onto the gate's shape, by batch position.
 *  Mirrors the `PlanItemUncheckedCreateInput` built below field for field, so
 *  the gate judges exactly what the insert would write. */
function toIncomingProposalNode(p: ProposalInput, index: number): ProposalNode {
  return {
    id: `${INCOMING_PROPOSAL_ID_PREFIX}${index}`,
    op: p.op,
    workItemId: p.op === 'add' ? null : (p.workItemId ?? null),
    parentRef: p.parentRef ?? null,
    blockedByRefs: p.blockedByRefs ?? [],
    proposedFields: (p.proposedFields ?? null) as ProposalNode['proposedFields'],
    patch: (p.patch ?? null) as ProposalNode['patch'],
  };
}

/** Project a Prisma `PlanItem` row onto the gate's minimal proposal shape. */
function toProposalNode(item: PlanItem): ProposalNode {
  return {
    id: item.id,
    op: item.op,
    workItemId: item.workItemId,
    parentRef: item.parentRef,
    blockedByRefs: item.blockedByRefs,
    proposedFields: (item.proposedFields ?? null) as ProposalNode['proposedFields'],
    patch: (item.patch ?? null) as ProposalNode['patch'],
  };
}

/**
 * Run the gate over a proposal set: resolve every REAL work item the plan
 * references in ONE batched, workspace-scoped read, then ask the pure
 * validator. Throws a typed rejection; writes nothing.
 */
async function runPersistGate(
  items: PlanItem[],
  ctx: ServiceContext,
  terminalStatusKeys: ReadonlySet<string>,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const nodes = items.map(toProposalNode);
  // Bound when the caller holds no transaction (MOTIR-2846) — pass 1 runs before
  // the approve transaction opens. Unbound, every referenced work item read as
  // absent and the gate rejected the plan with `PlanRefGraphError` for parents
  // that exist.
  const referenced = collectReferencedWorkItemIds(nodes);
  const rows = tx
    ? await workItemRepository.findByIdsInWorkspace(referenced, ctx.workspaceId, tx)
    : await withWorkspaceServiceContext(ctx.workspaceId, (t) =>
        workItemRepository.findByIdsInWorkspace(referenced, ctx.workspaceId, t),
      );
  const liveById = new Map<string, LiveWorkItemState>(
    rows.map((r) => [r.id, { id: r.id, kind: r.kind, status: r.status }]),
  );
  validatePlanProposals({ items: nodes, liveById, terminalStatusKeys });
}

/**
 * The in-transaction half of the gate: LOCK every `modify`/`remove` target
 * (`SELECT … FOR UPDATE`) before re-reading it, so the immutability verdict is
 * taken against state a concurrent transition can no longer move (`notes.html`
 * #35 — a count/status read before the transaction is not a guarantee). Locks
 * are taken in a stable id order so two approves touching the same items queue
 * instead of deadlocking. Runs BEFORE `materialize` writes anything, so a
 * rejection leaves the tree byte-identical.
 */
async function assertProposalsPersistable(
  items: PlanItem[],
  ctx: ServiceContext,
  terminalStatusKeys: ReadonlySet<string>,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const targetIds = [
    ...new Set(
      items.filter((i) => i.op !== 'add' && i.workItemId != null).map((i) => i.workItemId!),
    ),
  ].sort();
  for (const id of targetIds) await workItemRepository.lockById(id, tx);
  await runPersistGate(items, ctx, terminalStatusKeys, tx);
}

// ── The proposed REPO PIN, resolved before the transaction (MOTIR-1884) ───────
//
// A project's repository SET is sized by its architecture (MOTIR-1780), so
// `resolveDispatchRepo`'s "the single repo" default stops answering the moment a
// project has two: an item with no pin resolves to `null` and no agent is told
// where to build. The planner therefore pins each proposed item (motir-ai,
// MOTIR-1885) and the pin rides `proposedFields` / `patch` to here.
//
// It is resolved OUTSIDE the approve transaction, for the reason
// `lib/workItems/targetRepo.ts` documents and the direct-write path already
// obeys: the domain read opens its OWN workspace context (the
// `project_repository` / `github_repo` RLS policies are workspace-keyed) and
// Prisma cannot nest interactive transactions. Resolving first also means an
// unknown repo is rejected while the tree is still byte-identical — the same
// property the confirmation gate's pre-transaction pass has.

/** Each PlanItem's RESOLVED pin, keyed by plan-item id. A key is present only
 *  when that proposal actually carried a `targetRepo`, so an `add` with no pin
 *  and a `modify` that doesn't touch the pin are indistinguishable from the
 *  pre-MOTIR-1884 behaviour (absent ≠ explicit null). */
type ResolvedRepoPins = ReadonlyMap<string, string | null>;

/**
 * The project's repository rows, keyed the two ways a PROPOSAL can name one
 * (Story MOTIR-2732 · MOTIR-3033).
 *
 * A proposal pins either a settled NAME (`project-repository-set.md` §5.4) or a
 * portable ROLE (§5.2). Both have to become the same thing — a reference to the
 * `project_repository` row — so both lookups are built once, before the
 * transaction, from one read.
 *
 * The ROLE map holds ONLY roles carried by exactly ONE row. §5.3 is explicit that
 * a repeated role resolves to nothing rather than to an arbitrary pick, counted
 * over rows in ANY state so the verdict is a property of the SET and not of which
 * row was established first. A role with two rows is therefore simply absent here,
 * and the item lands unrouted — the honest answer, and the one the reference model
 * makes rarer rather than more common (MOTIR-3045 lets a planner pin the ROW).
 */
interface ProposalRepoRefs {
  byName: ReadonlyMap<string, string>;
  byRole: ReadonlyMap<string, string>;
}

async function resolveProposalRepoRefs(
  projectId: string,
  ctx: ServiceContext,
): Promise<ProposalRepoRefs> {
  const { projectRepoSetService } = await import('@/lib/services/projectRepoSetService');
  const rows = await projectRepoSetService.listByProject(projectId, ctx);
  const byName = new Map<string, string>();
  const roleCounts = new Map<string, number>();
  for (const row of rows) {
    // The RESOLVED name, same rule as everywhere else (§A4): the realized
    // repository's own once it is realized, else the row's authored intent.
    const name = (row.realizedRepo?.name ?? row.name).trim().toLowerCase();
    if (name.length > 0 && !byName.has(name)) byName.set(name, row.id);
    roleCounts.set(row.role, (roleCounts.get(row.role) ?? 0) + 1);
  }
  const byRole = new Map<string, string>();
  for (const row of rows) {
    if (roleCounts.get(row.role) === 1) byRole.set(row.role, row.id);
  }
  return { byName, byRole };
}

/** The reference a single proposal resolves to, or `null` when it names nothing
 *  this project has — a NAME first (it is the settled, unambiguous pin), then the
 *  ROLE, which is what a plan written before the repositories existed carries. */
function proposalRepoRef(
  pinnedName: string | null,
  role: string | null,
  refs: ProposalRepoRefs,
): string | null {
  if (pinnedName !== null) {
    const byName = refs.byName.get(pinnedName.trim().toLowerCase());
    if (byName !== undefined) return byName;
  }
  if (role !== null) return refs.byRole.get(role) ?? null;
  return null;
}

/** The authored `targetRepo` a proposal carries, or `undefined` when it carries
 *  none (an `add` without the field, a `modify` whose patch omits it). */
function authoredTargetRepo(item: PlanItem): string | null | undefined {
  if (item.op === 'add') {
    return ((item.proposedFields ?? null) as PlanItemProposedFields | null)?.targetRepo;
  }
  if (item.op === 'modify') {
    return ((item.patch ?? null) as PlanItemPatch | null)?.targetRepo;
  }
  return undefined;
}

/**
 * Normalize + VALIDATE every proposed pin against the PROJECT's repository set,
 * BEFORE the approve transaction opens. Returns the value each proposal
 * materializes (`null` = explicitly unpinned).
 *
 * Validation is `resolveAuthoredTargetRepoInProject` — the SAME resolver the
 * direct work-item write path calls, so the `owner/name` and bare-name forms, the
 * case-insensitive match, the stored casing, and the project-vs-workspace scope
 * ladder behave identically however the pin arrived. That also means a pin to a
 * set row that is still `proposed` is ACCEPTED (the pin domain is every row, not
 * just the established ones): the plan names repositories before it creates them,
 * so recording that intent is ordinary. What is still caught is the typo and the
 * SIBLING project's repo.
 *
 * An unknown name becomes a `PlanItemUnknownTargetRepoError` naming the offending
 * PROPOSAL — the reviewer of a hundred-item plan needs to know which one, and the
 * underlying message (which lists the project's repositories) rides along.
 *
 * Resolutions are memoized per authored spelling: a plan pins many items to the
 * same few repos, and the domain read is per-call. A plan carrying NO pins does
 * no reads at all.
 */
async function resolveProposedTargetRepos(
  items: PlanItem[],
  projectId: string,
  ctx: ServiceContext,
): Promise<ResolvedRepoPins> {
  const resolved = new Map<string, string | null>();
  const memo = new Map<string, string | null>();

  for (const item of items) {
    const authored = authoredTargetRepo(item);
    if (authored === undefined) continue;
    const cacheKey = authored ?? '';
    if (!memo.has(cacheKey)) {
      try {
        memo.set(cacheKey, await resolveAuthoredTargetRepoInProject(authored, projectId, ctx));
      } catch (err) {
        if (err instanceof UnknownTargetRepoError) {
          throw new PlanItemUnknownTargetRepoError(item.id, authored ?? '', err.message);
        }
        throw err;
      }
    }
    resolved.set(item.id, memo.get(cacheKey)!);
  }
  return resolved;
}

// ── The proposed REPO ROLE — the PORTABLE pin (MOTIR-1912) ────────────────────
//
// The pin above names a REPOSITORY; this one names a ROLE of the project's set,
// and ADR §5.2 calls the difference load-bearing: at generation the repositories
// DO NOT EXIST — the set is derived from the tree (§0.1) and the user may rename
// any row before it is created — so a name pinned then is stale the moment a row
// is edited and meaningless before the row exists at all. A role is stable across
// both, which is what lets the ONBOARDING path pin anything at all.
//
// Two things follow, and they are why this sits beside the name resolver rather
// than inside it:
//
//   * VALIDATION is against the closed vocabulary (`PROJECT_REPO_ROLES`), NOT the
//     project's set — which is precisely what makes a role emittable before the
//     set exists. So it is PURE: no DB read, no memo, and nothing to await.
//   * The distinct roles ARE §0.1.1's derivation signal, the primary rung of the
//     ladder `deriveRepoSetProposal` walks. Collecting them is therefore not a
//     side errand of validation but the point: a `web` + `api` plan is what makes
//     the proposer emit TWO rows, and without this the ladder always falls through
//     to `preplan-platform` / `default-web` and a two-repo project can never be
//     proposed.

/** The `targetRepoRole` a proposal carries, as UNKNOWN — the value rides in
 *  producer-written JSON persisted verbatim, so `'backend'` and a number are as
 *  possible as a role, and only {@link assertKnownRepoRole} may narrow it. */
function authoredTargetRepoRole(item: PlanItem): unknown {
  if (item.op === 'add') {
    return ((item.proposedFields ?? null) as PlanItemProposedFields | null)?.targetRepoRole;
  }
  if (item.op === 'modify') {
    return ((item.patch ?? null) as PlanItemPatch | null)?.targetRepoRole;
  }
  return undefined;
}

/** Name a proposal the way its author can recognise it: an `add` by the title it
 *  proposes, a `modify` by the item it targets. */
function proposalLabel(p: { op: string; workItemId?: string | null; title?: string }): string {
  if (p.op === 'add') return p.title?.trim() ? `“${p.title.trim()}”` : 'an untitled `add`';
  return `the \`${p.op}\` of work item ${p.workItemId ?? '(unknown)'}`;
}

/**
 * REJECT a repo role outside ADR §1.1's vocabulary, naming the offending
 * proposal. `undefined` (the proposal carries no role) and `null` (an explicit
 * "unpinned") both PASS — absent is not an error, and the `null` case is what
 * lets a `modify` clear a pin, exactly as the name path's does.
 */
/**
 * A `ProposalInput` in the shape the append-time temp-ref check reads
 * (MOTIR-3539) — the four ref carriers plus the label a refusal names it by.
 * `patch` rides along because an intra-plan edge on a `modify` travels there and
 * nowhere else, which is the carrier the live artifact used.
 */
function refCarrier(p: ProposalInput): ProposalRefCarrier {
  return {
    label: proposalLabel({ op: p.op, workItemId: p.workItemId, title: p.proposedFields?.title }),
    parentRef: p.parentRef,
    blockedByRefs: p.blockedByRefs,
    patch: p.patch ?? null,
  };
}

/**
 * A persisted `PlanItem` ROW in the ref-carrier shape (MOTIR-3540) — the twin of
 * `refCarrier` above, which reads an inbound `ProposalInput`. The withdraw path
 * needs the stored side: which proposals ALREADY on the plan point at the one
 * being taken off it.
 */
function refCarrierOfRow(item: PlanItem): ProposalRefCarrier {
  return {
    label: item.id,
    parentRef: item.parentRef,
    blockedByRefs: item.blockedByRefs,
    patch: item.patch as ProposalRefCarrier['patch'],
  };
}

/**
 * The FROZEN-status gate shared by `correctProposal` and `withdrawProposal`
 * (MOTIR-3540). `generating` and `planned` are editable; anything else is not.
 *
 * Written as a DENY of the terminal states rather than an allow of the two, so a
 * future status is refused by default — the safe direction for a gate whose job
 * is to keep two editable records of one thing from existing.
 */
function assertPlanProposalsEditable(plan: Pick<Plan, 'id' | 'status'>): void {
  if (plan.status !== 'generating' && plan.status !== 'planned') {
    throw new PlanNotEditableError(plan.id, plan.status);
  }
}

function assertKnownRepoRole(role: unknown, planItemId: string | null, label: string): void {
  if (role === undefined || role === null || isProjectRepoRole(role)) return;
  const printed = typeof role === 'string' ? role : String(JSON.stringify(role) ?? role);
  throw new PlanItemUnknownTargetRepoRoleError(
    planItemId,
    label,
    printed,
    `Proposal ${label} pins the unknown repository role \`${printed}\`. A role must be one of: ${PROJECT_REPO_ROLES.join(', ')}.`,
  );
}

/**
 * Validate EVERY proposal's role and return the DISTINCT roles the plan's `add`
 * proposals pin, deduped and ordered by FIRST APPEARANCE in the plan — ADR
 * §0.1.1's signal, handed to `proposeRepositorySet` as `itemRoles`.
 *
 * Ordered by first appearance rather than sorted because the plan's own order is
 * the only ordering that carries meaning here (the tree is generated
 * primary-surface-first), and because the derivation re-orders anyway: §1.3 puts
 * the platform's primary role first and the rest in §1.1 vocabulary order. Two
 * layers, one deciding what the signals ARE and one deciding how a SET is
 * ordered — this is the first.
 *
 * Adds ONLY: a `modify` re-pins an item that already exists, which is not
 * evidence about the set's cardinality (the set was derived when the tree was
 * generated). Its role is still validated — an unknown one must materialize
 * nothing — it simply does not vote.
 */
function resolveProposedRepoRoles(items: PlanItem[]): ProjectRepoRoleDto[] {
  const ordered: ProjectRepoRoleDto[] = [];
  const seen = new Set<ProjectRepoRoleDto>();

  for (const item of items) {
    const role = authoredTargetRepoRole(item);
    assertKnownRepoRole(
      role,
      item.id,
      proposalLabel({
        op: item.op,
        workItemId: item.workItemId,
        title: ((item.proposedFields ?? null) as PlanItemProposedFields | null)?.title,
      }),
    );
    if (item.op !== 'add' || role == null) continue;
    const known = role as ProjectRepoRoleDto;
    if (!seen.has(known)) {
      seen.add(known);
      ordered.push(known);
    }
  }
  return ordered;
}

/**
 * Apply every PlanItem of a (locked, `planned`, GATED) plan inside the caller's
 * approve transaction. `add` → MATERIALIZE a WorkItem (intra-plan refs
 * resolved); `modify` → update the target (same id, ONE revision logged);
 * `remove` → archive the target. Runs entirely on `tx`.
 *
 * PRECONDITION: `assertProposalsPersistable` has already passed on `items`
 * under this same transaction — this function does not re-check the grammar or
 * done-work immutability, it applies an already-confirmed proposal set. The repo
 * pins in `repoPins` are likewise ALREADY resolved + validated
 * (`resolveProposedTargetRepos`, outside this transaction) — this function only
 * writes them.
 *
 * RETURNS the ids of the work items it created or modified — the MATERIALIZE
 * trigger of the plan-tree embedding write path (Story MOTIR-2694 · MOTIR-2696,
 * `docs/decisions/plan-tree-embeddings.md` §6.3.1). It returns them rather than
 * enqueueing here because the enqueue must happen AFTER this transaction commits
 * (§6.3.2): a rolled-back approve must not leave a job embedding rows that do
 * not exist. `remove` targets are excluded — archiving keeps the embedding row
 * (§5), so un-archiving restores candidacy with no re-embed.
 *
 * A modify whose text did NOT move is included too, and that is deliberate: the
 * job recomputes the content hash and skips, which costs one local read and no
 * provider call. Filtering precisely here would mean a second definition of "did
 * the document change", and two of those is how they drift apart.
 */
async function materialize(
  items: PlanItem[],
  plan: Plan,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
  repoPins: ResolvedRepoPins,
  repoRefs: ProposalRepoRefs,
): Promise<string[]> {
  const project = await projectRepository.findById(plan.projectId, tx);
  if (!project) throw new ProjectNotFoundError(plan.projectId);
  const statusKey = await workflowsService.getInitialStatusKey(plan.projectId, ctx.workspaceId);
  if (statusKey == null) throw new NoInitialStatusError(plan.projectId);

  const adds = items.filter((i) => i.op === 'add');
  // The provenance guard, RE-RUN here (MOTIR-2990). `addProposals` already
  // rejects an unknown `planningProvenance.source` at the append, and this is the
  // same check at the persist boundary — the "core re-checks, defense in depth"
  // doctrine `lib/plans/validateProposals.ts` states for the whole approve path,
  // applied to the one field materialize now READS rather than pins. It is what
  // makes "never written through to the column" a property of the write rather
  // than a property of every writer having behaved, and it fails the approve
  // ATOMICALLY: before the first row is created, so a rejection leaves the tree
  // byte-identical.
  for (const item of adds) {
    const pf = (item.proposedFields as PlanItemProposedFields | null) ?? null;
    if (pf) assertKnownPlanningSource(pf, proposalLabel({ op: 'add', title: pf.title }));
  }
  const planItemToWorkItem = new Map<string, string>();
  // The created adds, collected for the post-creation body pass (Pass 3) — the
  // intra-plan item-link tokens in a body can reference a sibling created LATER
  // (a forward ref), so resolving them must wait until every add's id exists.
  const createdAdds: Array<{ created: WorkItem; prefix: string }> = [];

  const resolveRef = (ref: string): string => {
    if (ref.startsWith(TEMP_REF_PREFIX)) {
      const target = planItemToWorkItem.get(ref.slice(TEMP_REF_PREFIX.length));
      if (!target) throw new UnresolvedPlanRefError(ref);
      return target;
    }
    return ref;
  };

  // Pass 1 — create each add's WorkItem (parent resolved at insert, in topo order).
  for (const item of topoOrderAdds(adds)) {
    const pf = (item.proposedFields ?? {}) as unknown as PlanItemProposedFields;
    const kind = (pf.kind as WorkItemKind | undefined) ?? 'task';
    const parentId = item.parentRef ? resolveRef(item.parentRef) : null;

    const number = await projectRepository.allocateWorkItemNumber(plan.projectId, tx);
    // Re-read the identifier prefix under the lock allocateWorkItemNumber took
    // (a racing `changeKey` could have committed a new prefix — the same re-read
    // workItemsService.createWorkItem does).
    const refreshed = await projectRepository.findById(plan.projectId, tx);
    const prefix = refreshed?.identifier ?? project.identifier;
    const identifier = `${prefix}-${number}`;

    // Normalize bare REAL work-item refs in the generated description AND the
    // AI-drafted explanation (MOTIR-850) to canonical link tokens (bug MOTIR-1440)
    // so a materialized body chips (5.8.6) rather than staying plain text — the
    // same write-path rule the service create/update applies (it normalizes both
    // `descriptionMd` and `explanationMd`), here on the inlined materialize insert.
    // (Intra-plan temp refs are a separate concern, resolved at materialize by
    // the temp-ref → motir:<id> pass; this only resolves EXISTING bare keys.)
    const [normalizedDescriptionMd, normalizedExplanationMd] = await normalizeBodyRefs(
      {
        projectId: plan.projectId,
        projectIdentifier: prefix,
        fields: [pf.descriptionMd, pf.explanationMd],
      },
      tx,
    );

    const siblings = await workItemRepository.findSiblings(plan.projectId, parentId, tx);
    const position = keyForAppend(siblings.length ? siblings[siblings.length - 1]!.position : null);
    const lastRank = await workItemRepository.findBoundaryBacklogRank(
      plan.projectId,
      ctx.workspaceId,
      null,
      'max',
      tx,
    );
    const backlogRank = keyForAppend(lastRank);

    const data: Prisma.WorkItemUncheckedCreateInput = {
      workspaceId: ctx.workspaceId,
      projectId: plan.projectId,
      parentId,
      kind,
      key: number,
      identifier,
      title: pf.title,
      descriptionMd: normalizedDescriptionMd ?? null,
      // AI-drafted explanation (MOTIR-850): flow `explanationMd` + its source onto
      // the created item. `explanationSource` is set ONLY when an explanation is
      // present — respect an explicit source the proposal carried, else default to
      // `ai_draft` (the generator drafted it); with no explanation the column stays
      // at its schema default (`user_authored`). Intra-plan temp-ref tokens in the
      // explanation are rewritten in Pass 3, like the description.
      explanationMd: normalizedExplanationMd ?? null,
      ...(typeof normalizedExplanationMd === 'string' && normalizedExplanationMd.trim() !== ''
        ? {
            explanationSource:
              (pf.explanationSource as Prisma.WorkItemUncheckedCreateInput['explanationSource']) ??
              'ai_draft',
          }
        : {}),
      status: statusKey,
      ...(pf.priority
        ? { priority: pf.priority as Prisma.WorkItemUncheckedCreateInput['priority'] }
        : {}),
      reporterId: ctx.userId,
      // PLANNING provenance (Story MOTIR-1685; the PIN LIFTED by MOTIR-2990,
      // docs/decisions/work-item-provenance.md Decision 5 as amended 2026-08-18
      // and argued in docs/decisions/agent-authored-plans.md Q4).
      //
      // This block used to read: "`source: native` (PINNED — never read from the
      // proposal), `harness: Motir`", on the premise that "every item materialized
      // from an approved plan was planned NATIVELY by Motir". That premise was
      // true while motir-ai's generator was the only writer of a `Plan`, and
      // MOTIR-2982 falsifies it: an agent authors a plan over the MCP, a person
      // approves it, and these rows are what it creates. Left pinned, every one of
      // them would claim Motir planned it — a false statement written into the
      // exact record this ADR exists to keep honest.
      //
      // Reading the field does NOT weaken what the pin was protecting — that a
      // proposal cannot CLAIM to have been planned natively — because no caller
      // can reach it on any of the three write paths: `add_plan_items` stamps it
      // server-side and does not accept it as an argument (the discipline
      // `create_work_item` applies to `source: 'mcp'`); the internal
      // `/api/internal/ai/plan-proposals` route is a §4 job-token seam a PAT
      // cannot reach; and the proposal-EDIT path cannot touch it at all
      // (`UpdateProposalInput` has no such member and `mergeProposedFields` is an
      // explicit key-by-key merge). `assertKnownPlanningSource` at the append is
      // the backstop that keeps the column total.
      //
      // The DEFAULT is what keeps every shipped native path byte-identical: an
      // older proposal carries no provenance and takes `native`/`Motir`; MOTIR-1690's
      // producer sends exactly that pair. `planningModel` is unchanged — RECORDED
      // for internal analysis, and STRIPPED for `native` by `toWorkItemDto`, so
      // Motir still never exposes its own model. An `mcp` item is not stripped and
      // therefore shows the model the agent self-reported, which is what Decision 5
      // already prescribed ("MCP/BYOK keep + expose their model").
      planningSource: (pf.planningProvenance?.source ??
        'native') as Prisma.WorkItemUncheckedCreateInput['planningSource'],
      planningHarness: pf.planningProvenance?.harness ?? 'Motir',
      planningModel: pf.planningProvenance?.model ?? null,
      type: (pf.type as Prisma.WorkItemUncheckedCreateInput['type']) ?? null,
      executor: (pf.executor as Prisma.WorkItemUncheckedCreateInput['executor']) ?? null,
      // Leaf sizing (MOTIR-1433): flow the validated point + minute estimates
      // onto the created item so the estimation gate satisfied on the proposal
      // survives materialize (Prisma accepts a number for the Decimal(6,2)
      // storyPoints column). Null when the `add` carried no estimate.
      estimateMinutes: pf.estimateMinutes ?? null,
      storyPoints: pf.storyPoints ?? null,
      // WHICH REPO this item ships in (MOTIR-1884) — already normalized to the
      // bare name and validated against the project's set before the transaction
      // opened. Absent from the map = the proposal carried no pin, which stores
      // `null` exactly as it did before the field existed (the shipped resolver's
      // single-repo fallback still serves those projects unchanged).
      targetRepo: repoPins.get(item.id) ?? null,
      // ⚠️ `targetRepoRole` IS GONE FROM `work_item` (Story MOTIR-2732 ·
      // MOTIR-3040, ADR "Amendment 2026-08-18" §A3's RETIRE branch). The role was
      // the PORTABLE stand-in a plan recorded because a NAME is meaningless before
      // the repository exists — and a row REFERENCE is not, so the proposal's role
      // is resolved to a reference above (`proposalRepoRef`) and nothing is stored
      // on the item. `PlanItemProposedFields.targetRepoRole` still exists and is
      // still how a plan pins before any row exists; it simply no longer survives
      // onto the work item as a second way to say where a card ships.
      position,
      backlogRank,
    };

    const created = await workItemRepository.create(data, tx);

    // THE REPOSITORY REFERENCE (Story MOTIR-2732 · MOTIR-3033). This path builds
    // its create-input by hand and calls the repository directly, bypassing
    // `workItemsService` — which is exactly why the reference had to be written
    // here explicitly and why the column it replaces was never written at all: two
    // writers existed for one fact and only one of them was exercised by the
    // work-item tests.
    //
    // Resolved from the row set proposed BEFORE this transaction (§A3), so a card
    // planned before its repositories existed points at one from birth. A proposal
    // naming nothing this project has resolves to `null` and the item lands with
    // no reference — unrouted and honest, never a guess.
    const createdRef = proposalRepoRef(
      repoPins.get(item.id) ?? null,
      pf.targetRepoRole ?? null,
      repoRefs,
    );
    if (createdRef !== null) {
      await workItemRepoRepository.createMany(
        [
          {
            workspaceId: ctx.workspaceId,
            workItemId: created.id,
            projectRepoId: createdRef,
            position: 0,
          },
        ],
        tx,
      );
    }
    planItemToWorkItem.set(item.id, created.id);
    await planItemRepository.setWorkItemId(item.id, created.id, tx);
    // The `created` revision is recorded in Pass 3, after the body's intra-plan
    // item-link tokens are resolved — so the revision (and the live row) carry the
    // FINAL chip body, never the temp-ref form.
    createdAdds.push({ created, prefix });
  }

  // Pass 2 — blocked-by edges for the adds (all add targets now exist).
  //
  // ⚠️ ONE STATEMENT FOR THE WHOLE GRAPH, NOT ONE PER EDGE (MOTIR-3396). This
  // pass used to `await workItemLinkRepository.create(...)` inside a nested
  // loop, so a plan's edge count was its round-trip count: 27 edges meant 27
  // sequential Fly→Neon waits, at the END of an interactive transaction that had
  // already spent itself creating 15 work items. That is what exhausted Prisma's
  // default 5 000 ms budget and made approve return P2028 — and the raised
  // budget this path now passes is the SECOND fix, deliberately: the first is
  // simply not doing the work.
  //
  // `resolveRef` still runs in the collection loop, so an unresolvable temp-ref
  // is still an `UnresolvedPlanRefError` raised before any edge is written. The
  // per-row structural triggers are unaffected by batching (see
  // `createManyIfAbsent`), and `skipDuplicates` makes a plan that proposes the
  // same edge twice idempotent instead of aborting the approve.
  const blockedByRows = adds.flatMap((item) => {
    const fromId = planItemToWorkItem.get(item.id)!;
    return item.blockedByRefs.map((ref) => ({
      workspaceId: ctx.workspaceId,
      fromId,
      toId: resolveRef(ref),
      kind: 'is_blocked_by' as const,
      createdById: ctx.userId,
    }));
  });
  await workItemLinkRepository.createManyIfAbsent(blockedByRows, tx);

  // Pass 2b — DERIVE THE BIRTH STATUS from the edges Pass 2 just wired
  // (MOTIR-3050). Pass 1 gives every created row the workflow's INITIAL status,
  // which for the default workflow is `todo` — "the only thing between this card
  // and the ready set is who picks it up". A card proposed with a
  // `blockedByRefs` naming unfinished work is not that, and a person reading the
  // approved tree was being shown a `todo` column full of cards nobody could
  // start.
  //
  // ⚠️ WHY AT BIRTH, AND ONLY AT BIRTH. `blocked` is deliberately NOT a
  // projection of the edges in this product: `lib/workflows/defaultWorkflow.ts`
  // documents it as the human annotation for "can't proceed, full stop",
  // INCLUDING blockers that have no edge at all (an external dependency), and
  // MOTIR-2425 records that readiness is computed from the edges and never from
  // the status. A recompute that owned the column would therefore CLEAR a
  // human's externally-motivated block the moment no edge remained, and would
  // fight `run.md`'s own guards, which move a card to `blocked` for reasons the
  // graph cannot see. A newly created row has no such annotation to clobber —
  // choosing its FIRST status from its edges strictly adds information and
  // overwrites nothing. That is the whole scope of this pass, and it is what
  // makes the two authoring doors agree (the direct path's planner types this
  // status by hand right after `create_work_item`).
  //
  // The verdict comes from `classifyBlockerReadiness`, the SAME predicate the
  // ready set uses (`lib/workItems/blockerReadiness.ts`) — so `blocked` here can
  // never mean something different from "not ready" there. It is a snapshot of
  // that predicate at creation, not a second source of truth for it: readiness
  // stays computed, and it is what dispatch reads.
  if (createdAdds.length > 0) {
    const createdIds = createdAdds.map(({ created }) => created.id);
    const blockerRows = await workItemLinkRepository.findBlockerStatesForItems(createdIds, tx);
    if (blockerRows.length > 0) {
      // A blocker may live in ANOTHER project (a cross-project edge), so
      // "terminal" is resolved per blocker-project — the same batched read
      // `getReadinessForItems` makes.
      const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
        blockerRows.map((b) => b.projectId),
        ctx.workspaceId,
        tx,
      );
      const byItem = new Map<string, BlockerReadinessState[]>();
      for (const row of blockerRows) {
        const bucket = byItem.get(row.fromId);
        if (bucket) bucket.push(row);
        else byItem.set(row.fromId, [row]);
      }
      const unready = createdIds.filter(
        (id) => !classifyBlockerReadiness(byItem.get(id) ?? [], terminalByProject).ready,
      );
      if (unready.length > 0) {
        // Resolve the project's own blocked status rather than assuming one: a
        // project whose workflow was customized may not have it, and under the
        // `restricted` policy the initial → blocked move must be a declared
        // transition. Either check failing leaves the initial status in place —
        // a status the workflow does not offer is never written, and a workflow
        // that has been reshaped to forbid the hop is not overridden here.
        const blockedStatus = await workflowsRepository.findStatusByKey(
          plan.projectId,
          BLOCKED_STATUS_KEY,
          ctx.workspaceId,
          tx,
        );
        const initialStatus = await workflowsRepository.findStatusByKey(
          plan.projectId,
          statusKey,
          ctx.workspaceId,
          tx,
        );
        const legal =
          blockedStatus != null &&
          initialStatus != null &&
          (project.workflowPolicyMode === 'open' ||
            (await workflowsRepository.findTransition(
              plan.projectId,
              initialStatus.id,
              blockedStatus.id,
              ctx.workspaceId,
              tx,
            )) !== null);
        if (legal) {
          for (const id of unready) {
            const updated = await workItemRepository.update(id, { status: blockedStatus.key }, tx);
            // Feed the refreshed row back to Pass 3, which records the `created`
            // revision from it — so the item's history shows ONE create, at the
            // status it was actually born at, and not a create plus a phantom
            // status change nobody made.
            const entry = createdAdds.find((c) => c.created.id === id);
            if (entry) entry.created = updated;
          }
        }
      }
    }
  }

  // Pass 3 — resolve intra-plan item-link tokens in each add's body, then
  // auto-relate + record the create revision (MOTIR-1418). Every add's WorkItem
  // id now exists, so a `[label](motir-ref:planItem:<id>)` token (the form the
  // 7.4 generator emits for a sibling it was still proposing) rewrites to a real
  // `[label](motir:<workItemId>)` — even a forward ref to a later sibling. After
  // the rewrite the body carries only real `motir:<id>` tokens, so the SAME
  // auto-relate-on-mention pass workItemsService runs at create (5.8.3) wires the
  // `relates_to` edges here too — materialize composes the leaf repos directly
  // (it cannot nest `workItemsService.createWorkItem`'s own transaction), so this
  // is where that hook belongs. ADD-only + idempotent, so it never duplicates or
  // downgrades the structural `is_blocked_by` edges from Pass 2.
  for (const { created, prefix } of createdAdds) {
    let finalRow = created;
    const { body: rewrittenDescription, unresolved } = rewriteIntraPlanRefs(
      created.descriptionMd ?? '',
      planItemToWorkItem,
    );
    // The AI-drafted explanation (MOTIR-850) follows the SAME item-link convention
    // as the description (rendered through the same markdown pipeline), so resolve
    // its intra-plan `motir-ref:planItem:<id>` tokens into real `motir:<id>` links
    // here too — even a forward ref to a sibling created later in this pass.
    const { body: rewrittenExplanation, unresolved: unresolvedExplanation } = rewriteIntraPlanRefs(
      created.explanationMd ?? '',
      planItemToWorkItem,
    );
    for (const ref of [...unresolved, ...unresolvedExplanation]) {
      // A dangling intra-plan ref is left inert (never dropped/crashed); surface
      // it — it means the generator referenced a sibling that wasn't proposed.
      console.warn(
        `[plansService.materialize] plan ${plan.id}: intra-plan ref planItem:${ref} in ${created.identifier} resolved to no item — left inert`,
      );
    }
    const bodyUpdate: Prisma.WorkItemUncheckedUpdateInput = {};
    if (rewrittenDescription !== (created.descriptionMd ?? '')) {
      bodyUpdate.descriptionMd = rewrittenDescription;
    }
    if (rewrittenExplanation !== (created.explanationMd ?? '')) {
      bodyUpdate.explanationMd = rewrittenExplanation;
    }
    if (Object.keys(bodyUpdate).length > 0) {
      finalRow = await workItemRepository.update(created.id, bodyUpdate, tx);
    }
    // Auto-relate mentions in BOTH the description AND the explanation (5.8.3) —
    // ADD-only + idempotent, so wiring `relates_to` from either body never
    // duplicates or downgrades the structural `is_blocked_by` edges from Pass 2.
    await autoRelateWorkItemMentions(
      {
        source: {
          id: finalRow.id,
          workspaceId: ctx.workspaceId,
          projectId: plan.projectId,
          projectIdentifier: prefix,
        },
        text: `${finalRow.descriptionMd ?? ''}\n${finalRow.explanationMd ?? ''}`,
        ctx,
      },
      tx,
    );
    await workItemRevisionsService.recordRevision(
      {
        workItemId: finalRow.id,
        changedById: ctx.userId,
        changeKind: 'created',
        diff: buildAddDiff(finalRow),
      },
      tx,
    );
  }

  // Every item this pass created — the embedding trigger's first half. Collected
  // from `createdAdds` rather than re-derived, so a create that Pass 3 rewrote
  // is named exactly once.
  const touchedWorkItemIds: string[] = createdAdds.map(({ created }) => created.id);

  // modify + remove against existing targets (locked + re-read inside the tx).
  for (const item of items) {
    if (item.op === 'modify') {
      await applyModify(item, ctx, resolveRef, tx, repoPins, repoRefs);
      // `applyModify` has already thrown `PlanItemTargetMissingError` on an unset
      // target, so this is non-null by the time we get here — asserted rather
      // than re-guarded, which would add a branch nothing can take.
      touchedWorkItemIds.push(resolveRef(item.workItemId!));
    } else if (item.op === 'remove') {
      if (!item.workItemId) throw new PlanItemTargetMissingError('(unset)');
      const locked = await workItemRepository.lockById(item.workItemId, tx);
      if (!locked) throw new PlanItemTargetMissingError(item.workItemId);
      await workItemRepository.archive(item.workItemId, tx);
      await workItemRevisionsService.recordRevision(
        { workItemId: item.workItemId, changedById: ctx.userId, changeKind: 'archived', diff: {} },
        tx,
      );
    }
  }

  // THE CONTAINER ROLLUP, ONCE PER CONTAINER (Story MOTIR-2732 · MOTIR-3033, ADR
  // §A6). A plan creates a whole tree in one transaction and a parent is created
  // BEFORE its children, so recomputing per insert would be both quadratic and
  // wrong-order: every container would derive its set from the children that
  // happened to exist at the moment it was written.
  //
  // So it runs here, after every add and every modify has landed, over the
  // DISTINCT ancestors of everything this pass touched — each container derived
  // exactly once no matter how many of its descendants moved. Inside the same
  // transaction, so a plan and the repository sets it implies commit together.
  await recomputeContainersForTouched(touchedWorkItemIds, ctx.workspaceId, tx);

  return touchedWorkItemIds;
}

/**
 * Recompute the derived repository set of every CONTAINER above `touchedIds`,
 * each one ONCE (MOTIR-3033).
 *
 * The ancestor chains are collected first and de-duplicated, then walked deepest
 * -first so a parent derives from children that have already been derived — an
 * epic's set is the union of its stories', and a story's is only correct once its
 * own subtasks have been rolled up.
 *
 * Locked per container, exactly as the service-path rollup is: a plan approve is
 * one transaction, but it is not the only writer, and a rollup is a
 * read-derive-write either way.
 */
async function recomputeContainersForTouched(
  touchedIds: readonly string[],
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (touchedIds.length === 0) return;
  // depth → the containers at that depth, so the walk can go deepest-first.
  const byDepth = new Map<string, number>();
  for (const id of touchedIds) {
    const ancestors = await workItemRepository.findAncestors(id, workspaceId, tx);
    // `findAncestors` returns ROOT→self, so the LAST entry is the immediate
    // parent: index from the end to get a depth that compares across chains.
    ancestors.forEach((a, i) => {
      const depth = ancestors.length - 1 - i;
      const seen = byDepth.get(a.id);
      if (seen === undefined || depth < seen) byDepth.set(a.id, depth);
    });
  }
  const ordered = [...byDepth.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  for (const containerId of ordered) {
    await workItemRepository.lockById(containerId, tx);
    const refs = await workItemRepoRepository.listDerivedRefsForContainer(
      containerId,
      workspaceId,
      tx,
    );
    await workItemRepoRepository.deleteByWorkItem(containerId, tx);
    await workItemRepoRepository.createMany(
      refs.map((projectRepoId, position) => ({
        workspaceId,
        workItemId: containerId,
        projectRepoId,
        position,
      })),
      tx,
    );
  }
}

/** A single `modify` materialize: patch the target (same id), one revision. */
async function applyModify(
  item: PlanItem,
  ctx: ServiceContext,
  resolveRef: (ref: string) => string,
  tx: Prisma.TransactionClient,
  repoPins: ResolvedRepoPins,
  repoRefs: ProposalRepoRefs,
): Promise<void> {
  if (!item.workItemId) throw new PlanItemTargetMissingError('(unset)');
  const locked = await workItemRepository.lockById(item.workItemId, tx);
  if (!locked) throw new PlanItemTargetMissingError(item.workItemId);
  const current = await workItemRepository.findById(item.workItemId, tx);
  if (!current) throw new PlanItemTargetMissingError(item.workItemId);

  const patch = (item.patch ?? {}) as unknown as PlanItemPatch;
  const update: Prisma.WorkItemUncheckedUpdateInput = {};
  // Holds per-field { from, to } cells AND the `links` edge-change cell
  // ({ added, removed }) — the work-item revision diff is a heterogeneous map.
  const diff: Record<string, unknown> = {};

  if (patch.title !== undefined && patch.title !== current.title) {
    update.title = patch.title;
    diff.title = { from: current.title, to: patch.title };
  }
  // Normalize bare REAL work-item refs in a modified description to canonical
  // link tokens (bug MOTIR-1440) so the patched body chips. The prefix is the
  // target's own identifier minus its `-<key>` suffix (same derivation the
  // quick-view read uses); a key that doesn't resolve is left plain.
  //
  // BOTH bodies travel through ONE resolve (MOTIR-3111) — the same `fields:
  // [descriptionMd, explanationMd]` pair the `add`-path materialize passes, not a
  // second call. The explanation is a chip-rendering surface too, and one resolve
  // is what keeps a patch that mentions the same key in both bodies from costing
  // two lookups. `normalizeBodyRefs` preserves the presence shape, so `undefined`
  // still means "the patch did not carry this key" on the way out.
  const prefix = current.identifier.slice(
    0,
    current.identifier.length - String(current.key).length - 1,
  );
  const [normalizedDescriptionMd, normalizedExplanationMd] = await normalizeBodyRefs(
    {
      projectId: current.projectId,
      projectIdentifier: prefix,
      fields: [patch.descriptionMd, patch.explanationMd],
    },
    tx,
  );
  if (normalizedDescriptionMd !== undefined && normalizedDescriptionMd !== current.descriptionMd) {
    update.descriptionMd = normalizedDescriptionMd;
    diff.descriptionMd = { from: current.descriptionMd, to: normalizedDescriptionMd };
  }
  // REWRITE the WHY (MOTIR-3111) — the `modify` mirror of the `add` path's
  // explanation, so THE REPLAN ACTION's "patch BOTH bodies" has a door. Sparse
  // exactly like the description above: absent leaves it alone, an explicit
  // `null` clears it. `explanationMd` already has an `editedField()` disposition
  // in lib/activity/renderers.ts (`buildAddDiff` emits the same key), so this
  // revision renders with no new registry entry.
  //
  // ⚠️ `explanationSource` is NOT written here, deliberately: it is not the
  // caller's to set (`user_authored` default, `ai_draft` → `user_edited` on the
  // service edit path), and a patch that could write it would let a plan forge
  // provenance. Its column is also undispositioned in the renderer registry — the
  // same rule the `add` path's `buildAddDiff` follows when it omits it.
  if (normalizedExplanationMd !== undefined && normalizedExplanationMd !== current.explanationMd) {
    update.explanationMd = normalizedExplanationMd;
    diff.explanationMd = { from: current.explanationMd, to: normalizedExplanationMd };
  }
  if (patch.priority !== undefined && patch.priority !== current.priority) {
    update.priority = patch.priority as Prisma.WorkItemUncheckedUpdateInput['priority'];
    diff.priority = { from: current.priority, to: patch.priority };
  }
  if (patch.type !== undefined && patch.type !== current.type) {
    update.type = patch.type as Prisma.WorkItemUncheckedUpdateInput['type'];
    diff.type = { from: current.type, to: patch.type };
  }
  // Leaf sizing re-scope (MOTIR-1532) — the SAME point/estimate columns the `add`
  // path materializes, applied here as an in-place modify. `storyPoints` is a
  // Prisma Decimal, so compare + record the diff NUMERICALLY (the `Number(...)`
  // shape estimationService.setEstimate logs); `estimateMinutes` is a plain
  // nullable int. Both diff keys already have a `lib/activity/renderers.ts`
  // disposition (buildAddDiff / estimationService emit them), so the modify
  // revision renders with no new registry entry.
  if (patch.storyPoints !== undefined) {
    const from = current.storyPoints === null ? null : Number(current.storyPoints);
    if (patch.storyPoints !== from) {
      update.storyPoints = patch.storyPoints;
      diff.storyPoints = { from, to: patch.storyPoints };
    }
  }
  if (patch.estimateMinutes !== undefined && patch.estimateMinutes !== current.estimateMinutes) {
    update.estimateMinutes = patch.estimateMinutes;
    diff.estimateMinutes = { from: current.estimateMinutes, to: patch.estimateMinutes };
  }
  // RE-PIN the repo (MOTIR-1884) — present in `repoPins` ONLY when the patch
  // carried a `targetRepo` key, which is what keeps "leave it alone" distinct
  // from "unpin it" (an explicit null resolves to null and clears the column).
  // The value is already normalized + validated against the project's set; the
  // `targetRepo` diff key has a `textField()` disposition in
  // lib/activity/renderers.ts, so this revision renders with no new registry entry.
  if (repoPins.has(item.id)) {
    const nextTargetRepo = repoPins.get(item.id)!;
    if (nextTargetRepo !== current.targetRepo) {
      update.targetRepo = nextTargetRepo;
      diff.targetRepo = { from: current.targetRepo, to: nextTargetRepo };
    }
  }

  // …and the REFERENCE moves with it (MOTIR-3033). A `modify` that re-pins an
  // existing leaf changes where that card ships, so it changes its ancestors'
  // unions too — the recompute is not run here but ONCE at the end of the pass,
  // over every touched item's chain, which is what keeps a plan that re-pins six
  // subtasks of one story from deriving that story six times.
  //
  // Written whenever the pin key is PRESENT, including when the NAME did not
  // change: a card whose project only just gained its repository rows resolves to
  // a reference for the first time here, with `targetRepo` identical on both
  // sides — the same case the service path's update handles ahead of its own
  // empty-diff return.
  if (repoPins.has(item.id) || (item.patch as PlanItemPatch | null)?.targetRepoRole !== undefined) {
    const patched = (item.patch as PlanItemPatch | null) ?? null;
    const nextRef = proposalRepoRef(
      repoPins.get(item.id) ?? null,
      patched?.targetRepoRole ?? null,
      repoRefs,
    );
    await workItemRepoRepository.deleteByWorkItem(current.id, tx);
    if (nextRef !== null) {
      await workItemRepoRepository.createMany(
        [
          {
            workspaceId: ctx.workspaceId,
            workItemId: current.id,
            projectRepoId: nextRef,
            position: 0,
          },
        ],
        tx,
      );
    }
  }
  // RE-PIN / UNPIN the repo ROLE (MOTIR-1912) — the same sparse contract as the
  // name above. ⚠️ The ROLE no longer lands on the work item at all (MOTIR-3040,
  // §A3's RETIRE branch): a `modify` carrying `targetRepoRole` re-pins the card by
  // resolving that role to a REFERENCE — done above, beside the name — and there
  // is no column left for it to also be recorded in. The plan keeps the field;
  // the work item does not.
  if (Object.keys(update).length > 0) {
    await workItemRepository.update(item.workItemId, update, tx);
  }

  // Edge changes: add/remove `is_blocked_by` links (the target is the `from`).
  // Recorded under the EXISTING `links` revision-diff key + shape that
  // workItemsService uses ({ added/removed: [{ toId, kind }] }) — so the activity
  // feed renders them through the already-registered `links` disposition
  // (lib/activity/renderers.ts) rather than a new, undispositioned key.
  // ⚠️ A `modify` WIRES THE EDGE AND LEAVES THE STATUS ALONE — deliberately
  // (MOTIR-3050 AC 3). The `add` path above derives a materialized card's FIRST
  // status from its edges, and the obvious symmetry would be to move an existing
  // card to `blocked` when a `blockedByAdd` newly gates it. It is not symmetric,
  // for one reason: an `add` has no prior status to overwrite, and a `modify`
  // target has one that somebody RECORDED. That card may be `in_progress` with a
  // live worktree — the exact state `run.md`'s guards produce — or `in_review`
  // with an open PR, or `done`, from which `blocked` is not even a legal move.
  // An approve cannot see any of that, so writing the column here would silently
  // walk back a fact in order to display a dependency the edge already carries
  // and readiness already computes. The mover stays explicit: whoever finds the
  // missing prerequisite calls `transition_status` themselves.
  const linkAdded: Array<{ toId: string; kind: string }> = [];
  for (const ref of patch.blockedByAdd ?? []) {
    const toId = resolveRef(ref);
    await workItemLinkRepository.create(
      {
        workspaceId: ctx.workspaceId,
        fromId: item.workItemId,
        toId,
        kind: 'is_blocked_by',
        createdById: ctx.userId,
      },
      tx,
    );
    linkAdded.push({ toId, kind: 'is_blocked_by' });
  }
  const linkRemoved: Array<{ toId: string; kind: string }> = [];
  for (const ref of patch.blockedByRemove ?? []) {
    const toId = resolveRef(ref);
    const link = await workItemLinkRepository.findReciprocal(
      item.workItemId,
      toId,
      'is_blocked_by',
      tx,
    );
    if (link) {
      await workItemLinkRepository.delete(link.id, tx);
      linkRemoved.push({ toId, kind: 'is_blocked_by' });
    }
  }
  if (linkAdded.length > 0 || linkRemoved.length > 0) {
    diff.links = {
      ...(linkAdded.length > 0 ? { added: linkAdded } : {}),
      ...(linkRemoved.length > 0 ? { removed: linkRemoved } : {}),
    };
  }

  // ONE revision for the whole modify (same id — lands as a single entry in the
  // existing work-item revision/activity log; identity is never re-minted).
  await workItemRevisionsService.recordRevision(
    { workItemId: item.workItemId, changedById: ctx.userId, changeKind: 'updated', diff },
    tx,
  );
}

/**
 * Shared body of the two proposal-edit paths: lock the plan, assert it is in
 * `expectedStatus`, sparse-merge the `UpdateProposalInput` over the `add`'s
 * `proposedFields`, re-validate (non-empty title + leaf sizing), and persist —
 * NO WorkItem. The plan row is locked + its status re-read inside the tx, so an
 * edit racing the next lifecycle hop is rejected once the plan leaves
 * `expectedStatus`. Only an `add` is editable. The two callers differ ONLY in
 * which status the edit is legal from:
 *   • `updateProposal` — the user review edit, `planned`        (7.21.6 · MOTIR-1370)
 *   • `deepenProposal` — the generation-time deepen, `generating` (7.4.4a · MOTIR-1441)
 */
async function editAddProposal(
  planId: string,
  planItemId: string,
  input: UpdateProposalInput,
  ctx: ServiceContext,
  expectedStatus: 'planned' | 'generating',
): Promise<PlanWithItemsDto> {
  const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planRepository.findById(planId, ctx.workspaceId, tx),
  );
  if (!plan) throw new PlanNotFoundError(planId);
  // `ai:view_plan` (Story MOTIR-2291 · Subtask MOTIR-2363; SPLIT by MOTIR-3188).
  //
  // ⚠️ THE KEY GATES THE AUTHOR WRITES, AND IT GATES NO VIEW. Reading a plan is
  // `canBrowse` and always was — `planReviewService.getPlanReview` says so in its
  // own doc comment, and the v1 plan routes and the `get_plan` / `get_plan_status`
  // MCP rows all declare `project:browse`. What this key governs is WRITING to a
  // plan row without deciding it: `addProposals`, `markPlanned`, and this
  // function's two callers. The two DECISIONS — `approvePlan`, which materializes
  // the proposed subtree into work items, and `declinePlan` — assert
  // `ai:decide_plan` instead.
  //
  // ⚠️ WHAT THIS COMMENT USED TO ARGUE, AND WHY IT NO LONGER DOES. It read: "this
  // key governs reading a generated plan AND acting on it, because they are the
  // same surface and a reviewer who may not act has nothing to review for" — a
  // write key wearing a read's name. That was sound under three built-in roles
  // (`member` held it, `viewer` did not, so nobody could see a plan without being
  // able to approve one). MOTIR-2257's CUSTOM roles grant exactly what an admin
  // ticks off a grid, which turned the misleading name into a privilege
  // escalation; and MOTIR-2984/-2988 gave the surface a machine author, which is
  // the reviewer-who-may-not-act the old sentence said could not exist. The name
  // is still wrong — `ai:author_plan` is the honest one — and renaming it is a
  // migration over a persisted `role_definition.permissions` value, deliberately
  // left to its own card (`docs/decisions/agent-authored-plans.md` AMENDMENT 5).
  //
  // The project comes from the PLAN row, never from the actor's active project.
  await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

  const { row, items } = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
    async (tx) => {
      const locked = await planRepository.lockById(planId, tx);
      if (!locked) throw new PlanNotFoundError(planId);
      const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
      if (!fresh) throw new PlanNotFoundError(planId);
      if (fresh.status !== expectedStatus) {
        throw new PlanNotInExpectedStatusError(planId, fresh.status, expectedStatus);
      }
      const item = await planItemRepository.findById(planItemId, tx);
      if (!item || item.planId !== planId) throw new PlanItemNotFoundError(planItemId);
      if (item.op !== 'add') {
        throw new InvalidProposalError(
          'Only an `add` proposal can be edited; modify/remove target existing items.',
        );
      }
      const current = (item.proposedFields ?? {}) as unknown as PlanItemProposedFields;
      const next = mergeProposedFields(current, input);
      if (!next.title?.trim()) {
        throw new InvalidProposalError('An `add` proposal requires a non-empty title.');
      }
      // Re-validate sizing on the MERGED result (MOTIR-1433) so a patched-in bad
      // point/minute value is rejected here, the same as at create.
      validateProposedSizing(next);
      await planItemRepository.update(
        planItemId,
        { proposedFields: next as unknown as Prisma.InputJsonValue },
        tx,
      );
      // The edit, on the plan's content trail (MOTIR-3535), in the same
      // transaction as the merge it records — and the row this whole story
      // exists for: `editAddProposal` merges into `proposedFields` IN PLACE, so
      // without it a proposal deepened five times is byte-indistinguishable from
      // one written once.
      //
      // ⚠️ WHO acted is decided by `expectedStatus`, which is the ONLY thing that
      // tells the two callers apart and is exactly the right discriminator:
      // `deepenProposal` edits a `generating` plan and is the generator, so it
      // takes the generation actor (null on a cadence plan, the agent triple
      // beside it); `updateProposal` edits a `planned` one and is only ever
      // reached by a person reviewing it, so it records that person and NO agent.
      // Reading the plan's `authorSource` for both would file a reviewer's edit
      // under the agent that wrote what they were reviewing.
      //
      // The diff records the fields the edit SUPPLIED, not a value diff: the old
      // side of a proposal is already gone by the time it is written, and the
      // timeline shows a count rather than values in any case
      // (`design/ai-planning/design-notes.md` Part X §5).
      await planRevisionsService.recordRevision(
        {
          planId,
          planItemId,
          changeKind: 'edited',
          ...(expectedStatus === 'generating'
            ? generationActor(fresh, ctx)
            : { changedById: ctx.userId, actor: null }),
          diff: { fields: Object.keys(input), proposalCount: 1 },
        },
        tx,
      );
      const allItems = await planItemRepository.findByPlan(planId, tx);
      return { row: fresh, items: allItems };
    },
  );
  return toPlanWithItemsDto(row, items);
}

/**
 * Give the plan's planning conversation its TARGETS back (Story MOTIR-2786 ·
 * MOTIR-2787) — the release half of the target lock, run when a plan is decided.
 *
 * A decision is exactly the moment the story's hand-off table describes as "that
 * level's output exists": approve materializes the epic's stories, decline says
 * they never will. Either way the conversation has finished with the items it was
 * holding, and holding them any longer blocks a colleague for nothing.
 *
 * Resolved through `plan.sourceJobId` → the session whose `lastJobId` it is, which
 * is the same link the resume path (`findPendingPlanIdForJob`) walks in the other
 * direction. A plan with no source job, or one whose thread has since been
 * deleted, releases nothing.
 *
 * BEST-EFFORT and AFTER the commit, like the two triggers beside it: a lock that
 * fails to release is recoverable (the lease expires and the sweep clears it),
 * while a plan approval that fails after materializing the tree is not. So the
 * ordering of harms is unambiguous, and it is the reason this cannot be inside the
 * transaction — the alternative is rolling back a materialized tree because a
 * status write lost a race.
 */
async function releasePlanTargetLocks(
  plan: { id: string; projectId: string; sourceJobId: string | null },
  ctx: ServiceContext,
): Promise<void> {
  if (!plan.sourceJobId) return;
  try {
    const session = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planChangeSessionRepository.findByProjectAndLastJobId(
        plan.projectId,
        plan.sourceJobId!,
        ctx.workspaceId,
        tx,
      ),
    );
    if (!session) return;
    await planTargetLockService.releaseForSession(session.id, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      projectId: plan.projectId,
    });
  } catch (err) {
    console.warn(
      `[plansService] releasing planning-target locks for plan ${plan.id} failed; the lease will expire and the sweep will clear it`,
      err,
    );
  }
}

/**
 * The raised transaction budget for `approvePlan` (MOTIR-3396) — the ONE plan
 * path that gets one, and {@link TransactionBudget} asks for the argument here
 * rather than a number, so here it is.
 *
 * **Why it needs one at all.** Approve is the only path from a proposal to a
 * row, and it is a whole SUBTREE per click: for each add, allocate the project's
 * next number, insert the row, derive its birth status, rewrite its body's
 * intra-plan refs, auto-relate its mentions and record a revision — then the
 * edges, then every modify and remove. The work is proportional to the plan, and
 * a plan worth reviewing is not small. It must all be ONE transaction: a partial
 * materialize would leave a half-built tree that the plan can no longer be
 * re-approved to finish.
 *
 * **Why the numbers.** 30 s / 10 s, matching `projectRunnerGroupService`'s
 * `SYNC_TX_BUDGET` — deliberately the same shape, because the useful property is
 * "bounded well past the worst realistic case", not a tuned figure. The failing
 * fixture was 15 adds + 27 edges at ~5.03 s against Neon from Fly `iad`; with
 * the edge pass batched (one statement, not 27) the same plan's statement count
 * falls by ~26, so 30 s leaves room for a plan several times larger before
 * anybody has to think about this again. `maxWait` at 10 s covers a pool under
 * load rather than a slow body — the first of the four observed failures was
 * `maxWait` (2 000 ms), never reaching the body at all.
 *
 * **What raising it does NOT buy, and why the ordering matters.** A bigger
 * budget makes a slow transaction legal, not fast; it holds a Neon pool slot and
 * the plan's row lock for as long as it runs. So the round trips were removed
 * FIRST (`workItemLinkRepository.createManyIfAbsent`) and this is the margin
 * around the result. If a plan ever exhausts 30 s, the answer is again to do
 * less work in the transaction — not to raise this.
 */
const APPROVE_TX_BUDGET = { timeoutMs: 30_000, maxWaitMs: 10_000 } as const;

/**
 * Translate Prisma's P2028 into {@link PlanApproveTimedOutError} (MOTIR-3396).
 * Both halves of the interactive-transaction budget raise P2028 — `maxWait`
 * ("Unable to start a transaction in the given time") and `timeout` ("A query
 * cannot be executed on an expired transaction") — and both mean the same thing
 * to a caller: nothing was written, the plan still awaits a decision, retrying
 * is legitimate. Anything else is rethrown untouched, so a typed plan error
 * still reaches the route's own map.
 */
function translateApproveTimeout(err: unknown, planId: string, itemCount: number): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2028') {
    throw new PlanApproveTimedOutError(planId, itemCount);
  }
  throw err;
}

/**
 * WHO to record on a plan's content trail (Story MOTIR-3532 · MOTIR-3535), for
 * the four GENERATION-TIME writes — the open, an append, a deepen, the close.
 *
 * Two facts, and they are orthogonal:
 *
 *  1. **The acting USER, or null.** The null is the `cadence` case, and it is the
 *     same abstention `Plan.createdById` documents for itself: the auto-plan
 *     watcher runs under the PROJECT OWNER's credential so the job has one, and
 *     `ctx.userId` on that path names somebody who did nothing. Recording them
 *     would put a person's name on a machine's act, on the one plan whose whole
 *     point is that nobody asked.
 *  2. **WHICH AGENT acted**, copied onto the row rather than read off the plan at
 *     render time. The plan's `authorSource` answers who WROTE the plan; on a
 *     generation-time write that is also who performed it, which is exactly why
 *     these four sites may use it — and why the review edit and both decisions
 *     below may NOT: a person editing or deciding an agent-written plan is a
 *     different actor from its author, and a row that stores its own cannot come
 *     to disagree with itself.
 */
function generationActor(
  plan: Pick<Plan, 'origin' | 'authorSource' | 'authorHarness' | 'authorModel'>,
  ctx: ServiceContext,
): { changedById: string | null; actor: PlanRevisionAgentActor } {
  return {
    changedById: plan.origin === 'cadence' ? null : ctx.userId,
    actor: {
      source: plan.authorSource,
      harness: plan.authorHarness,
      model: plan.authorModel,
    },
  };
}

export const plansService = {
  /**
   * Open a `generating` Plan — the producer (7.4 generation / 7.11 re-planning)
   * calls this before emitting proposals. No WorkItem is created.
   */
  async createPlan(
    projectId: string,
    input: CreatePlanInput,
    ctx: ServiceContext,
  ): Promise<PlanDto> {
    await projectAccessService.assertCanEdit(projectId, ctx);
    // The trail's own values, resolved ONCE so the row and its revision cannot
    // disagree about who wrote the plan (MOTIR-3535).
    const origin = input.origin ?? 'user';
    const authorSource = input.authorSource ?? null;
    const authorHarness = normalizeSelfReported(input.authorHarness);
    const authorModel = normalizeSelfReported(input.authorModel);
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        const created = await planRepository.create(
          {
            workspaceId: ctx.workspaceId,
            projectId,
            status: 'generating',
            title: input.title ?? null,
            summary: input.summary ?? null,
            sourceJobId: input.sourceJobId ?? null,
            // WHY the plan was started (MOTIR-916). Defaults to `user`, so every
            // request-path producer keeps recording a human-initiated plan
            // without passing anything; only the cadence watcher passes
            // `cadence`.
            origin,
            // WHO ASKED for it (MOTIR-2986). EXPLICIT — deliberately NOT
            // `ctx.userId`, which is always present and is the project OWNER's on
            // the cadence path (`autoPlanCadenceService` substitutes it so the
            // job has a credential). Defaulting from the context would attribute
            // a request to somebody who never made one, on the single plan whose
            // whole point is that no person asked. Absent ⇒ null ⇒ `origin`
            // answers who set it going.
            createdById: input.createdById ?? null,
            // WHO authored it (MOTIR-2986) — the orthogonal fact, written in the
            // SAME insert rather than by an update-after-insert, because these
            // are write-once values on a row nobody else holds yet. No lock and
            // no concurrency guard: not a read-then-write, not a counter, not a
            // status guard.
            //
            // Every shipped producer omits all three, so this spread stores
            // nulls and the row is identical to one written before the columns
            // existed. The harness/model are self-reported free text
            // (`work-item-provenance.md` Decision 2) — trimmed here, empty → null,
            // so a caller sending `""` cannot make the surface render a blank
            // attribution that reads as a value.
            authorSource,
            authorHarness,
            authorModel,
          },
          tx,
        );
        // The trail's first row, in the SAME transaction as the insert it
        // records (MOTIR-3535). The plan-level acts carry no `planItemId` —
        // there is no proposal yet, and there never is one for the open.
        await planRevisionsService.recordRevision(
          {
            planId: created.id,
            changeKind: 'created',
            ...generationActor({ origin, authorSource, authorHarness, authorModel }, ctx),
            diff: { title: created.title, summary: created.summary, origin },
          },
          tx,
        );
        return created;
      },
    );
    return toPlanDto(row, 0);
  },

  /**
   * Append proposed `add`/`modify`/`remove` PlanItems to a `generating` plan
   * (the producer calls this per node / per batch). NO WorkItem is created here.
   * The plan row is locked + its status re-read so an append racing a
   * `markPlanned` is rejected once the plan leaves `generating`.
   *
   * ⚠️ ONE PROPOSAL PER EXISTING TARGET, AND IT IS REFUSED IN WORDS (MOTIR-3194).
   * `PlanItem @@unique([planId, workItemId])` admits at most one `modify`/`remove`
   * per target, and the rule is KEPT — {@link DuplicatePlanTargetError} argues why
   * on the record. What changed is how it announces itself: a check under the plan
   * lock, BEFORE the insert, naming the work item and the alternatives, instead of
   * an ORM string naming `prisma.planItem.create()`.
   */
  async addProposals(
    planId: string,
    proposals: ProposalInput[],
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');
    if (plan.status !== 'generating') throw new PlanNotGeneratingError(planId, plan.status);
    proposals.forEach(validateProposal);

    let result: { row: Plan; items: PlanItem[] };
    try {
      result = await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
        async (tx) => {
          const locked = await planRepository.lockById(planId, tx);
          if (!locked) throw new PlanNotFoundError(planId);
          const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
          if (!fresh) throw new PlanNotFoundError(planId);
          if (fresh.status !== 'generating') throw new PlanNotGeneratingError(planId, fresh.status);

          // The plan's already-appended proposals, read under the row lock the
          // append holds — so a second call cannot observe a stale set.
          //
          // ⚠️ READ UNCONDITIONALLY (MOTIR-3573). It used to be skipped when the
          // batch neither targeted anything existing nor carried a temp-ref —
          // right while its only readers were the duplicate-target check and
          // MOTIR-3539's temp-ref resolution, both of which are no-ops for such
          // a batch. The self-consistency gate below is not: it judges the
          // plan's WHOLE ref graph, and a duplicate edge or a `parentRef` cycle
          // can be CLOSED by the proposal being added, which a batch-only view
          // cannot see. So the read is now owed on every append, and the two
          // conditions it used to be gated on are gone.
          const existing = await planItemRepository.findByPlan(planId, tx);
          const carriesTempRef = proposals.some((p) => tempRefsOf(refCarrier(p)).length > 0);

          // THE PURE REF-GRAPH GATE, AT THE APPEND (MOTIR-3573). Everything
          // knowable about a proposal set WITHOUT a workspace read runs here,
          // before the first insert, so the author is told while the plan is
          // still theirs to fix. The same function runs again inside
          // `approvePlan`'s gate, which is what stops the two from disagreeing.
          //
          // What deliberately does NOT run here is the arm that needs
          // `liveById`: a real work-item id that resolves to nothing is left to
          // `markPlanned` (the close), because the read is not free and a plan
          // may legitimately reference an item created between the two.
          //
          // A rejection escapes as itself — `containPrismaFailure` re-throws
          // anything that is not a Prisma error — so the caller is told its
          // proposals ARE at fault, which `PlanPersistenceError` would deny.
          assertProposalSetSelfConsistent([
            ...existing.map(toProposalNode),
            ...proposals.map(toIncomingProposalNode),
          ]);

          // The targets this plan ALREADY claims. Grown in-loop as well, because
          // a duplicate inside ONE batch never reaches the database to be caught
          // by anything.
          const claimed = claimedTargets(existing);

          // ⚠️ REFUSE AN UNRESOLVABLE `planItem:` REF HERE, WHERE IT IS WRITTEN
          // (MOTIR-3539) — before the first row of the batch is inserted, so a
          // refusal leaves the plan byte-identical rather than half-appended.
          // `add_plan_items` returns its ids POSITIONALLY, so a partial append
          // would desynchronise the caller's own id map, which is a worse
          // artifact than the one being refused.
          //
          // The resolvable set is the plan's ALREADY-PERSISTED `add`s: a ref to a
          // proposal in the SAME batch is refused, because its id does not exist
          // until this call returns. That is precisely the mistake this card was
          // written from.
          //
          // `resolveRef` at materialize is UNCHANGED and stays the backstop for
          // every plan appended before this shipped.
          if (carriesTempRef) {
            const resolvable = new Set(existing.filter((i) => i.op === 'add').map((i) => i.id));
            assertTempRefsResolvable(
              proposals.map(refCarrier),
              resolvable,
              (ref, proposal) => new UnresolvedPlanRefError(ref, proposal),
            );
          }

          for (const p of proposals) {
            if (p.op !== 'add' && p.workItemId) {
              const existing = claimed.get(p.workItemId);
              if (existing) throw new DuplicatePlanTargetError(p.workItemId, existing, p.op);
              claimed.set(p.workItemId, p.op);
            }
            const data: Prisma.PlanItemUncheckedCreateInput = {
              workspaceId: ctx.workspaceId,
              planId,
              op: p.op,
              workItemId: p.op === 'add' ? null : (p.workItemId ?? null),
              parentRef: p.parentRef ?? null,
              blockedByRefs: p.blockedByRefs ?? [],
              baseRevision: p.baseRevision ?? null,
              ...(p.op === 'add' && p.proposedFields
                ? { proposedFields: p.proposedFields as unknown as Prisma.InputJsonValue }
                : {}),
              ...(p.op === 'modify' && p.patch
                ? { patch: p.patch as unknown as Prisma.InputJsonValue }
                : {}),
            };
            await planItemRepository.create(data, tx);
          }
          // ONE row for the whole batch, in the same transaction (MOTIR-3535).
          // An append is ONE ACT however many proposals it carries — the reader's
          // question is "what arrived, and who sent it", not "how many INSERTs
          // ran" — so the count lives in the diff rather than in the row count.
          //
          // ⚠️ EXCEPT AN EMPTY BATCH, WHICH IS NOT A CONTENT MUTATION AT ALL
          // (MOTIR-3538). The MCP's CLOSE is `add_plan_items { final: true }` with
          // NO proposals: it goes through here, inserts nothing, and hands off to
          // `markPlanned` — which writes its own `planned` row. Recording this one
          // too would put *"0 proposals appended"* on the timeline of every plan
          // authored through that door, immediately above the close it belongs to.
          // The trail records what CHANGED; nothing did.
          if (proposals.length > 0) {
            await planRevisionsService.recordRevision(
              {
                planId,
                changeKind: 'appended',
                ...generationActor(fresh, ctx),
                diff: {
                  proposalCount: proposals.length,
                  ops: {
                    add: proposals.filter((p) => p.op === 'add').length,
                    modify: proposals.filter((p) => p.op === 'modify').length,
                    remove: proposals.filter((p) => p.op === 'remove').length,
                  },
                },
              },
              tx,
            );
          }
          const allItems = await planItemRepository.findByPlan(planId, tx);
          return { row: fresh, items: allItems };
        },
      );
    } catch (err) {
      // THE BOUNDARY, not the one path (MOTIR-3194). The check above is what
      // actually refuses a duplicate target, in words; this is what stops ANY
      // other ORM failure inside the transaction — a foreign key, a lost
      // connection, a malformed write — from reaching an agent as Prisma's own
      // prose. Everything that is not a Prisma error passes through unchanged,
      // including the typed refusals thrown a few lines up.
      throw containPrismaFailure(err, 'plan proposal append');
    }
    return toPlanWithItemsDto(result.row, result.items);
  },

  /**
   * WOULD THE APPROVE BUTTON ACCEPT THIS PLAN? A pure READ of the same gate
   * `approvePlan` runs, for a caller that wants the verdict without taking it
   * (MOTIR-3575).
   *
   * Returns the rejections rather than throwing, because its caller is a
   * VALIDATOR: `validate_plan` exists to be asked, and an exception is the wrong
   * shape for an answer somebody requested. Empty ⇒ the plan is approvable as it
   * stands.
   *
   * ⚠️ AT MOST ONE ENTRY. `validatePlanProposals` is fail-fast — it runs ahead of
   * a write and stops at the first violation — so this reports the first reason,
   * not every reason. Deliberately NOT changed: making the gate collect would
   * change what `approvePlan` does to satisfy a read.
   *
   * ⚠️ IT TAKES NO LOCKS AND OPENS NO TRANSACTION, which is what makes it a read
   * at all. `assertProposalsPersistable` is the locking twin and belongs only to
   * approve; the verdict here is the one `approvePlan`'s PRE-transaction pass
   * takes, and it can go stale the moment it is returned — a plan approvable now
   * can drift before anybody presses the button, which is the whole reason approve
   * re-takes it under the row locks.
   */
  async checkApprovability(
    planId: string,
    ctx: ServiceContext,
  ): Promise<PlanApprovabilityRejectionDto[]> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanBrowse(plan.projectId, ctx);

    const [items, terminalStatusKeys] = await Promise.all([
      withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        planItemRepository.findByPlan(planId, tx),
      ),
      workflowsService.getTerminalStatusKeys(plan.projectId, ctx.workspaceId),
    ]);

    try {
      await runPersistGate(items, ctx, terminalStatusKeys);
      return [];
    } catch (err) {
      if (
        err instanceof PlanRefGraphError ||
        err instanceof PlanGrammarError ||
        err instanceof PlanTargetImmutableError
      ) {
        return [
          {
            code: err.code,
            reason: err instanceof PlanTargetImmutableError ? null : err.reason,
            item: `${TEMP_REF_PREFIX}${err.planItemId}`,
            message: err.message,
          },
        ];
      }
      // Anything else is a real failure — a lost connection, a bug — and a
      // validator that swallowed it would answer "approvable" for a plan it never
      // managed to check.
      throw err;
    }
  },

  /** Mark the generation frontier complete: `generating` → `planned`. */
  async markPlanned(
    planId: string,
    ctx: ServiceContext,
    opts: { productName?: string | null } = {},
  ): Promise<PlanDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

    // The AI-suggested project name (MOTIR-1554/1551) rides the final append and
    // ONLY the onboarding generation. Persist it when present; a non-onboarding
    // (reconciliation) run sends none, so the column stays null and no rename
    // ever fires at approve. Trim + collapse to a clean value, else leave unset.
    const productName =
      typeof opts.productName === 'string' && opts.productName.trim().length > 0
        ? opts.productName.trim()
        : null;

    // The project's TERMINAL statuses, for the close-time gate below. Resolved
    // OUT HERE because `getTerminalStatusKeys` opens its OWN workspace context
    // and Prisma cannot nest interactive transactions — the same reason
    // `approvePlan` resolves it before its transaction opens. Workflow statuses
    // are project CONFIG, not a row a concurrent write moves.
    const terminalStatusKeys = await workflowsService.getTerminalStatusKeys(
      plan.projectId,
      ctx.workspaceId,
    );

    // ⚠️ THE CONFIRMATION GATE, AT THE CLOSE (MOTIR-3573) — run BEFORE the
    // transaction opens, with NO `tx`, which is exactly `approvePlan`'s
    // pre-transaction pass (`:2124`).
    //
    // `planned` is the status that puts a plan in front of a person and hands
    // them a button, so it must not be reachable by a plan that cannot survive
    // being approved. Everything approve would reject for is KNOWABLE now — a
    // dangling ref and the kind-parent grammar cost one batched
    // workspace-scoped read — and this is the last moment the plan is still
    // editable, so a rejection is repairable rather than terminal.
    //
    // ⚠️ IT MUST NOT BE BOUND TO THE CLOSE'S OWN TRANSACTION, and that is a
    // correctness constraint rather than a convenience. `withWorkspaceContext`
    // binds `app.project_id`, and `work_item`'s project-narrowing policy reads
    // it — so a gate bound to that transaction cannot see a work item in
    // ANOTHER PROJECT of the same workspace, and a cross-project `blocked_by`
    // is legal (`link_work_items`: "targets may be in another project in the
    // same workspace") and is a first-class case for
    // `planValidityService.validateProjectedPlan`. Bound to the transaction,
    // the close would refuse plans that approve's own pre-transaction pass
    // accepts — a close STRICTER than the approve it is predicting, which is
    // the opposite of the promise this card is making. Unbound, the gate opens
    // its own workspace-scoped context and the two verdicts agree exactly.
    const preItems = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planItemRepository.findByPlan(planId, tx),
    );
    await runPersistGate(preItems, ctx, terminalStatusKeys);

    const { row, count } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        if (fresh.status !== 'generating') {
          throw new PlanNotInExpectedStatusError(planId, fresh.status, 'generating');
        }

        // The PURE half again, under the plan lock, over the set as it stands
        // NOW. It needs no read, so unlike the gate above it can run bound to
        // this transaction — which closes the window between the
        // pre-transaction verdict and the lock for everything a proposal set
        // can say about itself. The arms that need a workspace read stay
        // outside, and `approvePlan` re-runs all of them under the row locks
        // anyway, which is the check no close-time pass can replace: whether
        // the world moved WHILE the plan waited.
        const proposals = await planItemRepository.findByPlan(planId, tx);
        assertProposalSetSelfConsistent(proposals.map(toProposalNode));

        const updated = await planRepository.update(
          planId,
          {
            status: 'planned',
            plannedAt: new Date(),
            ...(productName != null ? { productName } : {}),
          },
          tx,
        );
        const n = await planItemRepository.countByPlan(planId, tx);
        // The close, on the trail (MOTIR-3535) — the moment the plan stopped
        // moving and became something a person is asked to read. The count is
        // what that person is being asked to approve.
        await planRevisionsService.recordRevision(
          {
            planId,
            changeKind: 'planned',
            ...generationActor(fresh, ctx),
            diff: { itemCount: n, ...(productName != null ? { productName } : {}) },
          },
          tx,
        );
        return { row: updated, count: n };
      },
    );
    return toPlanDto(row, count);
  },

  /**
   * A project's plans, newest first, cursor-paginated (the list view).
   *
   * `opts.status` narrows the page to ONE lifecycle status — the tabbed list's
   * read (MOTIR-3235). Omitted, the page is the whole project exactly as it was
   * before the option existed; the predicate is applied in the repository's
   * `where`, so a narrowed page is a full page rather than a filtered remnant
   * of one.
   */
  async listPlans(
    projectId: string,
    ctx: ServiceContext,
    opts: ListPlansOptions = {},
  ): Promise<PlanListPageDto> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const limit = clampLimit(opts.limit);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.listByProject(
        projectId,
        ctx.workspaceId,
        limit + 1,
        opts.cursor ?? null,
        tx,
        opts.status ?? null,
      ),
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const counts = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planItemRepository.countByPlanIds(
        page.map((p) => p.id),
        tx,
      ),
    );
    return {
      plans: page.map((p) => toPlanDto(p, counts.get(p.id) ?? 0)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  },

  /**
   * How many plans this project holds in EACH lifecycle status (MOTIR-3235) —
   * the numbers the tab strip renders beside its four labels.
   *
   * ONE `groupBy` for the whole strip, zero-filled here so the result is TOTAL
   * over `PlanStatusDto`: a status the project has no rows in reads `0`, never
   * an absent key. A caller rendering `{counts[tab]}` can therefore never print
   * `undefined`, and a status added to the vocabulary later appears as a zero
   * rather than as a hole, because the fill iterates `PLAN_STATUS_DTO_VALUES`
   * (which the type is derived from).
   *
   * Read-only, gated on `canBrowse` and run in the workspace context like every
   * other plan read.
   */
  async countPlansByStatus(projectId: string, ctx: ServiceContext): Promise<PlanStatusCountsDto> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.countByStatus(projectId, ctx.workspaceId, tx),
    );
    const counts = Object.fromEntries(
      PLAN_STATUS_DTO_VALUES.map((status) => [status, 0]),
    ) as PlanStatusCountsDto;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  },

  /**
   * The still-UNDECIDED plan a job produced, by id — or `null` (MOTIR-1745).
   *
   * The RESUME half of the `{ jobId, planId }` pair a submit returns: a caller
   * that comes back to a thread holds only the job it last submitted, and needs
   * the Plan awaiting confirmation to address it. Resolves through the plan's
   * `sourceJobId` binding (the same one the proposal callbacks resolve on).
   *
   * `null` — never an error — in all three "nothing to confirm" cases: no plan
   * for that job, a plan belonging to another project in the workspace (a job id
   * never addresses across projects), or one already `approved` / `declined`. A
   * decided plan is history, so surfacing it as pending would invite a confirm
   * of something already settled. `generating` and `planned` both count as
   * pending: the rail legitimately re-attaches to a run still in flight.
   *
   * Read-only, gated on `canBrowse` like every other plan read.
   */
  async findPendingPlanIdForJob(
    projectId: string,
    jobId: string,
    ctx: ServiceContext,
  ): Promise<string | null> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(jobId, ctx.workspaceId, tx),
    );
    if (!plan || plan.projectId !== projectId) return null;
    if (plan.status === 'approved' || plan.status === 'declined') return null;
    return plan.id;
  },

  /**
   * The plan a job produced, by job id — REGARDLESS of decision state
   * (MOTIR-1825). The OUTCOME-read sibling of
   * {@link plansService.findPendingPlanIdForJob}, which deliberately hides an
   * already-decided plan because its caller is offering a CONFIRM. This caller
   * is asking a different question — "what became of the job I fired?" — and an
   * approved or declined plan is a perfectly good, in fact final, answer. Hiding
   * it would report a settled job as missing.
   *
   * Takes no `projectId`: a job id addresses one plan, and the read is already
   * workspace-scoped by the repository plus `canBrowse`-gated on the plan's own
   * project — so a job from another tenant is an indistinguishable `null`, the
   * same no-existence-leak contract the pending sibling keeps.
   */
  async findPlanIdForJob(jobId: string, ctx: ServiceContext): Promise<string | null> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(jobId, ctx.workspaceId, tx),
    );
    if (!plan) return null;
    await projectAccessService.assertCanBrowse(plan.projectId, ctx);
    return plan.id;
  },

  /** A plan + its bundled proposal items (the detail view). The lifecycle
   *  timestamps + decider on the returned plan ARE the history surface. */
  async getPlan(planId: string, ctx: ServiceContext): Promise<PlanWithItemsDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanBrowse(plan.projectId, ctx);
    const items = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planItemRepository.findByPlan(planId, tx),
    );
    return toPlanWithItemsDto(plan, items);
  },

  /**
   * Edit a proposed `add` of a `planned` plan IN PLACE (7.21.6 · MOTIR-1370) —
   * the review surface's inline edit. Patches the `add`'s `proposedFields`
   * (title/kind/priority/type/description); NO WorkItem is created (an `add`
   * stays a proposal until approve materializes it). The plan row is locked + its
   * status re-read, so an edit racing an `approve`/`decline` is rejected once the
   * plan leaves `planned` (`PlanNotInExpectedStatusError`, the same one-shot guard
   * approve uses). Only an `add` is editable — `modify`/`remove` target existing
   * items, so editing one is an `InvalidProposalError`. Returns the full
   * `PlanWithItemsDto` so the caller reflects the change without a second read.
   */
  async updateProposal(
    planId: string,
    planItemId: string,
    input: UpdateProposalInput,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    return editAddProposal(planId, planItemId, input, ctx, 'planned');
  },

  /**
   * Deepen a proposed `add` while the plan is still `generating` (7.4.4a ·
   * MOTIR-1441) — the generation-time twin of `updateProposal`. The 7.4 issue-
   * tree generation handler (MOTIR-844) runs the titles-first strategy
   * (MOTIR-845): Phase 1 appends title-only `add`s via `addProposals`, then
   * Phase 2 PATCHES each one's `descriptionMd` (and finalises
   * type/priority/storyPoints/estimateMinutes) ONE AT A TIME — all BEFORE
   * `markPlanned` closes the frontier, so the plan is `generating`, not
   * `planned`. Identical to `updateProposal` (sparse merge, non-empty title +
   * sizing re-validation, add-only, row-locked one-shot) EXCEPT the legal status
   * is `generating`. NO WorkItem is created. The user-facing `updateProposal`
   * (`planned`) is unchanged.
   *
   * TWO callers now, and neither is the other's fallback:
   *   • `aiGenerationService.patchProposal` — the §4 job-token seam, which
   *     resolves the plan by `sourceJobId`.
   *   • `update_plan_item` (`lib/mcp/tools/authorPlan.ts`, MOTIR-3090) — the
   *     PAT-authed door, which resolves by `planId` because an MCP-authored plan
   *     has NO generation job and `findBySourceJobId` would throw
   *     `NoPlanForJobError` for every one of them.
   */
  async deepenProposal(
    planId: string,
    planItemId: string,
    input: UpdateProposalInput,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    return editAddProposal(planId, planItemId, input, ctx, 'generating');
  },

  /**
   * CORRECT a proposal on a `generating` or `planned` plan (Story MOTIR-3533 ·
   * Subtask MOTIR-3540) — the repair an agent that mistyped one field has never
   * had.
   *
   * ⚠️ HOW THIS DIFFERS FROM `deepenProposal` / `updateProposal`, and why it is a
   * THIRD method rather than a widening of either. Those two are one act — a
   * deepen — split by the status it is legal in, and
   * `agent-authored-plans.md` AMENDMENT 3 D3 fixed their editable set with a rule
   * that is still right: *a deepen may change what a card SAYS and who ACTS on
   * it, never where it SITS or SHIPS.* A CORRECTION is a different act. Its
   * trigger is the author discovering its own structural mistake, and its only
   * alternative today is authoring a whole second plan and asking a person to
   * decline the first. AMENDMENT 7 records the amendment; widening
   * `UpdateProposalInput` instead would have re-opened structure on the deepen
   * path too, which is the thing D3 was protecting.
   *
   * ⚠️ AND IT RE-RUNS THE APPEND'S REF CHECK (MOTIR-3539). A correction is the
   * one path that could re-introduce the defect the sibling card just closed —
   * the cure re-opening the hole the prevention shut, on a path nobody would
   * think to re-test. The resolvable set EXCLUDES the proposal being corrected,
   * so a self-reference is refused rather than accepted as a one-node cycle.
   *
   * Legal on `generating` AND `planned`; `approved` / `declined` are FROZEN and
   * the refusal names the status (`PlanNotEditableError`).
   */
  async correctProposal(
    planId: string,
    planItemId: string,
    input: CorrectProposalInput,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    // The same key the rest of the author writes assert (`addProposals` /
    // `markPlanned` / `editAddProposal`). NOT `ai:decide_plan`: correcting a
    // proposal is authoring, not deciding.
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

    // Resolved BEFORE the transaction, because it reads the project's repository
    // domain and that is a read the write lock has no business holding.
    let resolvedTargetRepo: string | null | undefined;
    if (input.targetRepo !== undefined) {
      try {
        resolvedTargetRepo = await resolveAuthoredTargetRepoInProject(
          input.targetRepo,
          plan.projectId,
          ctx,
        );
      } catch (err) {
        if (err instanceof UnknownTargetRepoError) {
          throw new PlanItemUnknownTargetRepoError(planItemId, input.targetRepo ?? '', err.message);
        }
        throw err;
      }
    }

    const { row, items } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        assertPlanProposalsEditable(fresh);

        const all = await planItemRepository.findByPlan(planId, tx);
        const item = all.find((i) => i.id === planItemId);
        if (!item || item.planId !== planId) throw new PlanItemNotFoundError(planItemId);

        const data: Prisma.PlanItemUncheckedUpdateInput = {};
        const touched: string[] = [];

        if (item.op === 'add') {
          if (input.patch !== undefined) {
            throw new InvalidProposalError(
              'A `patch` belongs to a `modify` proposal; this proposal is an `add`.',
            );
          }
          const current = (item.proposedFields ?? {}) as unknown as PlanItemProposedFields;
          const next = mergeProposedFields(current, input);
          if (resolvedTargetRepo !== undefined) next.targetRepo = resolvedTargetRepo;
          if (!next.title?.trim()) {
            throw new InvalidProposalError('An `add` proposal requires a non-empty title.');
          }
          validateProposedSizing(next);
          data.proposedFields = next as unknown as Prisma.InputJsonValue;
          touched.push(
            ...Object.keys(input).filter((k) => k !== 'parentRef' && k !== 'blockedByRefs'),
          );
        } else {
          // A `modify` / `remove` targets an EXISTING work item, so it carries no
          // proposed body and no pin of its own — the content keys and
          // `targetRepo` are meaningless on it rather than merely unsupported.
          const contentKeys = Object.keys(input).filter(
            (k) => k !== 'patch' && k !== 'blockedByRefs' && k !== 'parentRef',
          );
          if (contentKeys.length > 0) {
            throw new InvalidProposalError(
              `A \`${item.op}\` proposal has no proposed body to correct; ${contentKeys.join(', ')} apply to an \`add\`. Correct its \`patch\` instead.`,
            );
          }
          if (input.patch !== undefined) {
            if (item.op !== 'modify') {
              throw new InvalidProposalError('Only a `modify` proposal carries a `patch`.');
            }
            validateStoryPoints(input.patch?.storyPoints ?? null);
            validateEstimateMinutes(input.patch?.estimateMinutes ?? null);
            assertKnownRepoRole(
              input.patch?.targetRepoRole,
              item.id,
              proposalLabel({ op: item.op, workItemId: item.workItemId }),
            );
            data.patch = (input.patch ?? Prisma.JsonNull) as Prisma.InputJsonValue;
            touched.push('patch');
          }
        }

        if (input.parentRef !== undefined) {
          if (item.op !== 'add') {
            throw new InvalidProposalError('Only an `add` proposal carries a `parentRef`.');
          }
          data.parentRef = input.parentRef;
          touched.push('parentRef');
        }
        if (input.blockedByRefs !== undefined) {
          data.blockedByRefs = input.blockedByRefs;
          touched.push('blockedByRefs');
        }

        if (touched.length === 0)
          throw new InvalidProposalError('A correction must change something.');

        // ⚠️ THE APPEND'S OWN CHECK, RE-RUN ON THE CORRECTED SHAPE (MOTIR-3539).
        // The resolvable set is every OTHER `add` on this plan — excluding this
        // one, so `planItem:<itself>` is refused rather than stored as a
        // one-node cycle for materialize to trip over.
        const corrected: ProposalRefCarrier = {
          label: proposalLabel({
            op: item.op,
            workItemId: item.workItemId,
            title: (data.proposedFields as { title?: string } | undefined)?.title,
          }),
          parentRef: (data.parentRef as string | null | undefined) ?? item.parentRef,
          blockedByRefs: (data.blockedByRefs as string[] | undefined) ?? item.blockedByRefs,
          patch: (input.patch !== undefined
            ? input.patch
            : (item.patch as ProposalRefCarrier['patch'])) as ProposalRefCarrier['patch'],
        };
        assertTempRefsResolvable(
          [corrected],
          new Set(all.filter((i) => i.op === 'add' && i.id !== item.id).map((i) => i.id)),
          (ref, proposal) => new UnresolvedPlanRefError(ref, proposal),
        );

        await planItemRepository.update(planItemId, data, tx);

        // The correction, on the plan's content trail (MOTIR-3535), in the same
        // transaction as the write it records.
        //
        // ⚠️ THE AGENT ACTOR, not the person — the discriminator `editAddProposal`
        // uses (`expectedStatus`) is the wrong one here. It reads `planned` as
        // "only a person reaches this", which was true while the review route was
        // the sole caller. This method exists precisely so an AGENT can reach a
        // `planned` plan, and a reviewer must be able to see WHICH harness and
        // model changed the tree under them — that is the story's own criterion.
        await planRevisionsService.recordRevision(
          {
            planId,
            planItemId,
            changeKind: 'edited',
            ...generationActor(fresh, ctx),
            diff: { fields: touched, proposalCount: 1, correction: true },
          },
          tx,
        );
        return { row: fresh, items: await planItemRepository.findByPlan(planId, tx) };
      },
    );
    return toPlanWithItemsDto(row, items);
  },

  /**
   * WITHDRAW a proposal from a `generating` or `planned` plan (Story MOTIR-3533 ·
   * Subtask MOTIR-3540) — the substrate `agent-authored-plans.md` AMENDMENT 3 D4
   * recorded as absent and deferred to this card.
   *
   * Two things it is NOT. It is not `op: 'remove'`, which is a PROPOSAL to delete
   * an existing work item from the tree at approve and requires a `workItemId`;
   * this takes a proposal off the PLAN and nothing reaches the tree either way.
   * And it is not the neutering D4 rejected — retitling a card *withdrawn* and
   * emptying it leaves a proposal a reviewer must still read and makes the plan's
   * item count a lie.
   *
   * ⚠️ IT REFUSES rather than cascades when a sibling still references it. This
   * is MOTIR-3539's check in the mirror: that card made a dangling ref impossible
   * to CREATE, and this stops one arriving by DELETION instead. Cascading would
   * take cards off the plan nobody asked to withdraw; blanking the refs would
   * change what those proposals mean.
   *
   * Withdrawing a `modify` RELEASES its target, so a corrected `modify` on that
   * work item can be appended — the escape `DUPLICATE_PLAN_TARGET` has never had.
   * That falls out of the delete rather than being coded: `claimedTargets` reads
   * the rows that exist.
   */
  async withdrawProposal(
    planId: string,
    planItemId: string,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

    const { row, items } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        assertPlanProposalsEditable(fresh);

        const all = await planItemRepository.findByPlan(planId, tx);
        const item = all.find((i) => i.id === planItemId);
        if (!item || item.planId !== planId) throw new PlanItemNotFoundError(planItemId);

        const ref = `${TEMP_REF_PREFIX}${planItemId}`;
        const referrers = all
          .filter((i) => i.id !== planItemId)
          .filter((i) => tempRefsOf(refCarrierOfRow(i)).some((t) => t.ref === ref))
          .map((i) => i.id);
        if (referrers.length > 0) throw new PlanProposalReferencedError(planItemId, referrers);

        await planItemRepository.deleteById(planItemId, tx);

        // ⚠️ `planItemId` is NOT recorded on the revision: the row it names has
        // just been deleted, and `PlanRevision.planItemId` is a real relation, so
        // recording it would either fail the insert or be nulled by the cascade —
        // a trail row that quietly loses its subject. The id rides in the `diff`
        // instead, where it is a value rather than a reference.
        await planRevisionsService.recordRevision(
          {
            planId,
            changeKind: 'withdrawn',
            ...generationActor(fresh, ctx),
            diff: { proposalCount: 1, withdrewPlanItemId: planItemId, op: item.op },
          },
          tx,
        );
        return { row: fresh, items: await planItemRepository.findByPlan(planId, tx) };
      },
    );
    return toPlanWithItemsDto(row, items);
  },

  /**
   * Approve THE PLAN A CARD PRODUCED — the bounded entrance an unattended run
   * drives (MOTIR-3021 / MOTIR-3023,
   * `docs/decisions/run-findings-protocol.md` Q2).
   *
   * ⚠️ IT IS ADDRESSED BY THE CARD, NOT BY A PLAN ID, and that is not
   * convenience — it is what makes the bound structural. The caller is a loop
   * whose AGENT ran `motir plan --detach <KEY>` in a sandbox; the plan id came
   * back on that agent's stdout, which the loop streams straight to the terminal
   * and never captures. So a plan-addressed entrance would have forced either a
   * second read to discover the id or a scrape of the agent's output, and the
   * anchoring check would have been a check on caller-supplied data. Addressed
   * by the card, there is no way to NAME a plan that is not the card's.
   *
   * ⚠️ ANCHORING IS DERIVED, and every hop is a shipped one:
   *
   *   the card's key → `buildScope([key])` → the plan-change session for that
   *   anchor set → its `lastJobId` → the plan that job produced.
   *
   * A `motir plan --detach <KEY>` thread is anchored at exactly that scope, so
   * this resolves the plan that card's refusal caused and nothing else.
   *
   * ⚠️ NO CONVERSATION MEANS NO. A cadence plan, an onboarding generation and a
   * plan submitted from the project-wide panel all have no session at this
   * scope — and every one of them is a plan a person is expected to decide on.
   * Treating "no anchor" as "no restriction" would invert the bound at exactly
   * the plans it most protects.
   *
   * ⚠️ IT ADDS A BOUND, NEVER A SECOND APPROVAL. Everything that decides whether
   * a proposal may become a row — the confirmation gate, the `ai:view_plan`
   * assertion, the one-shot status guard, the re-validation — happens in
   * {@link plansService.approvePlan}, which this delegates to unchanged.
   */
  async approvePlanForWorkItem(
    projectId: string,
    workItemKey: string,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    await projectAccessService.assertPermission(projectId, ctx, 'ai:view_plan');

    const scope = buildScope([workItemKey]);
    const session = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planChangeSessionRepository.findByProjectAndScope(
        projectId,
        scope.scopeKey,
        ctx.workspaceId,
        tx,
      ),
    );
    const planId = session?.lastJobId
      ? await plansService.findPlanIdForJob(session.lastJobId, ctx)
      : null;
    if (!planId) throw new NoPlanForWorkItemError(workItemKey);

    return plansService.approvePlan(planId, ctx);
  },

  /**
   * Approve a `planned` plan: in ONE transaction set `approved` +
   * decidedAt/decidedById, then MATERIALIZE every PlanItem (add → create,
   * modify → update same id, remove → archive). The plan row is locked + its
   * status re-read first, so two concurrent approves resolve to exactly one
   * materialize — the loser observes `approved` and throws
   * `PlanNotInExpectedStatusError` (the atomic one-shot guard).
   *
   * THE CONFIRMATION GATE (7.12.5 · MOTIR-911) runs here, and there is NO path
   * around it: an explicit human approve of a proposal is the ONLY way a
   * proposed tree change becomes rows, and that approve RE-VALIDATES the
   * proposal independently — the kind-parent grammar (via
   * `lib/issues/parentRules.ts`, the same matrix every human create is gated
   * on), the intra-plan ref graph, and done-work immutability — BEFORE any
   * write. The proposal is NOT trusted: the planner's self-check is irrelevant
   * here (a human may have edited the set through `updateProposal` since), and
   * the gate is trigger-agnostic by construction — a contextual chat turn, the
   * `/ready` nudge and the auto-plan cadence all land on this one function.
   * A rejection leaves the tree and the plan's status byte-identical.
   */
  async approvePlan(
    planId: string,
    ctx: ServiceContext,
    opts: { provisionalProjectName?: string | null } = {},
  ): Promise<PlanWithItemsDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    // `ai:decide_plan` (MOTIR-3188) — the DECIDE half, split out of
    // `ai:view_plan`. This is the only path from a proposal to a row and it can
    // create a whole subtree at once, so it is gated by the key whose name says
    // so rather than by the one whose name says "can look at a plan". Behaviour
    // is unchanged for every built-in role: both keys sit at `admin` and
    // `member` and at neither `viewer` nor the implicit workspace-member grant.
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:decide_plan');

    // ⚠️ THE LAZY BACKSTOP (MOTIR-3579, AMENDMENT 9 D5). The eager mover is
    // `planDriftService` on `work-item/transitioned`; this is what catches the
    // race it can lose. `PlanTargetImmutableError` means a `modify`/`remove`
    // target reached a terminal status while the plan waited — the one Class B
    // rejection no close-time gate can foresee — and BEFORE this the plan was
    // left sitting at `planned`, unapprovable, with the reviewer told only that
    // their click failed. One button press now never leaves the plan in a worse
    // state than it found it.
    //
    // ⚠️ THE CALLER STILL GETS THE REFUSAL. The error is re-thrown unchanged, so
    // the route still answers 409: what changed is what the plan row READS
    // afterwards, never what the API returns.
    //
    // It wraps BOTH gate passes deliberately. The pre-transaction one is a
    // snapshot and the in-transaction one runs under the target row locks — the
    // reason `runPersistGate` is called twice at all — and drift is exactly the
    // thing that can arrive between them, so a backstop on one pass would leave
    // the other stranding the plan.
    try {
      // The project's TERMINAL statuses — every `category = 'done'` key, never a
      // hardcoded `'done'`, so `cancelled` is terminal too. Workflow statuses are
      // project CONFIG (not a row a concurrent approve moves), so this one read
      // serves both the pre-transaction and the in-transaction gate pass.
      const terminalStatusKeys = await workflowsService.getTerminalStatusKeys(
        plan.projectId,
        ctx.workspaceId,
      );

      // Pass 1 — reject BEFORE the transaction opens (the card's atomicity point:
      // a malformed proposal never even starts a write). Pass 2 runs inside, under
      // the target row locks, and is the verdict that actually gates materialize.
      const preItems = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        planItemRepository.findByPlan(planId, tx),
      );
      await runPersistGate(preItems, ctx, terminalStatusKeys);

      // The proposed repo PINS (MOTIR-1884), normalized + validated against this
      // PROJECT's repository set. Out here because the domain read opens its own
      // workspace context and cannot nest inside the approve transaction (the same
      // hazard `lib/workItems/targetRepo.ts` documents and the direct-write path
      // obeys) — and because an unknown repo should be rejected while the tree is
      // still byte-identical.
      //
      // Resolved from THIS pre-transaction snapshot, which is authoritative for
      // pins: on a `planned` plan the proposal set is frozen. `addProposals` /
      // `deepenProposal` require `generating`, `updateProposal`'s editable set
      // (`mergeProposedFields`) does not include `targetRepo`, `declinePlan` moves
      // the plan to `declined` (which the in-transaction status re-read below
      // rejects), and the lifecycle has no path back to `generating`. So no pin the
      // transaction materializes can differ from one resolved here.
      //
      // ⚠️ THAT SECOND CLAUSE IS LOAD-BEARING — do not widen `mergeProposedFields`
      // to carry `targetRepo` without revisiting this snapshot. The deepen turn's
      // widening (AMENDMENT 4 D3a, MOTIR-3089) was `executor` alone, and one of the
      // reasons the repo pin was left out is right here: a pin editable on a
      // `planned` plan would make this pre-transaction resolution non-authoritative.
      const repoPins = await resolveProposedTargetRepos(preItems, plan.projectId, ctx);

      // The proposed repo ROLES (MOTIR-1912) — validated against the vocabulary and
      // collected from the SAME pre-transaction snapshot, and for the same two
      // reasons: an unknown role is rejected while the tree is still byte-identical,
      // and a `planned` plan's proposal set is frozen, so what is read here is what
      // the transaction materializes. Pure — unlike the name pin, this needs no
      // domain read, because a role's domain is a closed enum.
      //
      // The list is ALSO §0.1.1's derivation signal, handed to `proposeRepositorySet`
      // after the commit below.
      const repoRoles = resolveProposedRepoRoles(preItems);

      // PROPOSE the project's repository set BEFORE the tree is materialized (Story
      // MOTIR-2732 · MOTIR-3033, ADR `work-item-repository-set.md` "Amendment
      // 2026-08-18" §A3, answer (b)).
      //
      // It used to run AFTER the commit, and §5.3 of `project-repository-set.md`
      // recorded that ordering as forced. The reading that settled it: this call's
      // ONLY derivation input is `repoRoles`, computed from the pre-transaction
      // proposal snapshot three lines above — nothing in it reads a created work
      // item. So the rows CAN exist first, and once they do a materialized card can
      // point at one from birth instead of carrying a role for a later pass to
      // resolve.
      //
      // ⚠️ It does NOT move INSIDE the transaction, and that is the other half of
      // §A3: `proposeRepositorySet` makes a `server-only` cross-boundary read and
      // writes each row in its OWN transaction (ADR `project-repository-set.md`
      // §4.2's "rows are INDEPENDENT and nothing is rolled back"). Before, not
      // within.
      //
      // Still BEST-EFFORT, for the reason §4.3 gives: establishing repositories is
      // not worth failing a plan approval over. A failure leaves the items with no
      // reference — honestly unrouted, the same signal §5.3's second outcome emits —
      // and the role→item mapping survives on the plan (`plan_item.workItemId` plus
      // its `proposedFields.targetRepoRole`), so a repair is reconstructable.
      //
      // The cost §A3 accepts, stated here because this is where it happens: a
      // rolled-back approve (the in-transaction status re-read rejecting) now leaves
      // `proposed` rows behind. They are editable, the proposer refuses to touch a
      // set that already has rows, and the approve that wins the race writes the
      // same set from the same plan.
      await import('@/lib/services/projectRepoProposalService')
        .then(({ projectRepoProposalService }) =>
          projectRepoProposalService.proposeRepositorySet(plan.projectId, ctx, {
            itemRoles: repoRoles,
          }),
        )
        .catch((err: unknown) => {
          console.warn(
            `[plansService.approvePlan] repository-set proposal failed for project ${plan.projectId}; skipping (the set stays empty and editable)`,
            err,
          );
        });

      // The project's repository ROWS, read AFTER the propose so a first-onboarding
      // plan sees the rows it just caused. This is what turns a proposal's pin — a
      // NAME (§5.4's settled case) or a ROLE (§5.2's portable one) — into the
      // reference a materialized card stores.
      const repoRefs = await resolveProposalRepoRefs(plan.projectId, ctx);

      const { row, items, firstOnboarding, projectKey, touchedWorkItemIds } =
        await withWorkspaceContext(
          { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
          async (tx) => {
            const locked = await planRepository.lockById(planId, tx);
            if (!locked) throw new PlanNotFoundError(planId);
            const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
            if (!fresh) throw new PlanNotFoundError(planId);
            if (fresh.status !== 'planned') {
              throw new PlanNotInExpectedStatusError(planId, fresh.status, 'planned');
            }
            const proposals = await planItemRepository.findByPlan(planId, tx);
            // THE GATE, under the plan lock + the targets' row locks, on the FRESH
            // proposal set — nothing has been written yet, so a rejection here rolls
            // back a transaction that touched no work-item row.
            await assertProposalsPersistable(proposals, ctx, terminalStatusKeys, tx);
            const touchedWorkItemIds = await materialize(
              proposals,
              fresh,
              ctx,
              tx,
              repoPins,
              repoRefs,
            );
            // Read the project ONCE, before `markOnboardingRan` writes: its
            // pre-write `onboardingRanAt` gates the rename below, and its
            // `identifier` (the tenant projectKey) + the first-onboarding signal both
            // feed the fresh-establish convention trigger fired after the tx commits.
            const project = await projectRepository.findById(fresh.projectId, tx);
            // Name the onboarded project from the AI plan (MOTIR-1551). The onboarding
            // generation (MOTIR-1554) stamped a suggested `productName` on the Plan;
            // apply it here — but ONLY on the FIRST onboarding approve of a draft the
            // user hasn't already named. Read BEFORE `markOnboardingRan` below (which
            // sets `onboardingRanAt`), so `onboardingRanAt == null` is the "first
            // onboarding" gate; the `name === provisionalProjectName` check (the
            // caller passes the current-locale "Untitled project" placeholder) means a
            // user rename during review is never clobbered. A reconciliation re-plan
            // carries no `productName`, so it never reaches here. Best-effort: rename
            // failure would abort the tx, so keep it a plain guarded write. Done via
            // the repo in-tx — `renameProject` opens its own workspace context.
            if (
              fresh.productName &&
              fresh.productName.trim().length > 0 &&
              opts.provisionalProjectName
            ) {
              if (
                project &&
                project.onboardingRanAt == null &&
                project.name === opts.provisionalProjectName
              ) {
                await projectRepository.update(project.id, { name: fresh.productName.trim() }, tx);
              }
            }
            // Stamp the immutable onboarding-ran marker the FIRST time this project's
            // plan is approved + materialized (Subtask 7.4 / MOTIR-1264). The repo's
            // null-guarded write makes it set-once, so calling it on every approve is
            // safe — only the first materialized tree writes it. This is the single
            // source of truth the /onboarding redirect AND the roadmap planning-origin
            // cluster (MOTIR-1013) read. Its return count (1 on the first approve, 0
            // after) IS the onboarding-completion signal the convention trigger fires on.
            const firstOnboarding =
              (await projectRepository.markOnboardingRan(fresh.projectId, new Date(), tx)) === 1;
            const updated = await planRepository.update(
              planId,
              { status: 'approved', decidedAt: new Date(), decidedById: ctx.userId },
              tx,
            );
            // The approval, on the plan's content trail (MOTIR-3535), inside the
            // very transaction that materialized the tree — so a rolled-back
            // approve (the in-transaction status re-read rejecting, or the budget
            // expiring) leaves no row claiming it happened.
            //
            // A decision is always a PERSON's: `ai:decide_plan` has no machine
            // path, so the row records the decider and NO agent triple, however the
            // plan itself was written. `touchedWorkItemCount` is what the approve
            // actually did to the tree, which is the fact `itemCount` alone cannot
            // give (a plan of `remove`s materializes none).
            await planRevisionsService.recordRevision(
              {
                planId,
                changeKind: 'approved',
                changedById: ctx.userId,
                diff: {
                  itemCount: proposals.length,
                  touchedWorkItemCount: touchedWorkItemIds.length,
                },
              },
              tx,
            );
            // Re-read so the returned items carry the written-back work-item ids.
            const finalItems = await planItemRepository.findByPlan(planId, tx);
            return {
              row: updated,
              items: finalItems,
              firstOnboarding,
              projectKey: project?.identifier ?? null,
              touchedWorkItemIds,
            };
          },
          // The raised budget, argued at {@link APPROVE_TX_BUDGET}. Second of the
          // two fixes, not the first: the edge pass above was batched before this
          // number was touched (MOTIR-3396).
          APPROVE_TX_BUDGET,
        ).catch((err: unknown) => translateApproveTimeout(err, planId, preItems.length));

      // Plan-tree embedding, MATERIALIZE trigger (Story MOTIR-2694 · MOTIR-2696,
      // ADR §6.3.1). AFTER the commit, for the same two reasons the create path
      // emits post-commit: the embedding is an external call that must never sit
      // inside a write transaction (§6.3.2), and a rolled-back approve must not
      // leave jobs embedding rows that do not exist. `sendEvent` is best-effort by
      // construction — a dropped enqueue leaves an item "not yet a candidate",
      // which the backfill later fills and which is never an error (§6.3.5) — so
      // it cannot turn a materialized tree into a failed approve.
      for (const workItemId of touchedWorkItemIds) {
        await sendEvent('work-item/embedding.requested', {
          workspaceId: ctx.workspaceId,
          workItemId,
        });
      }

      // Fresh-establish the coding convention at onboarding completion (7.3.10 ·
      // MOTIR-839). The FIRST time a project's onboarding plan is approved +
      // materialized, trigger the fresh `propose_convention` job so a `proposed`
      // convention exists for the user to adopt (the 7.14.5/MOTIR-926 surface). The
      // service applies the FRESH gate itself (a repo-backed project's convention is
      // the migrate/audit path's job, MOTIR-931) and reads the pinned stack over the
      // 7.1 boundary. Fired BEST-EFFORT and AFTER the tx commits: the `server-only`
      // client call cannot run inside the DB transaction, and a motir-ai hiccup must
      // never fail an approve that already materialized the tree (the convention can
      // be re-established later; the approve is the durable, user-visible effect).
      // Imported LAZILY (dynamic import) so the `server-only` motir-ai client stays
      // OUT of plansService's static import graph — the E2E plan seeds import
      // plansService in the Playwright Node process, where `server-only` does not
      // resolve; the client loads only when the trigger actually fires on the server.
      if (firstOnboarding && projectKey) {
        await import('@/lib/services/conventionEstablishService')
          .then(({ conventionEstablishService }) =>
            conventionEstablishService.establishForFreshProject({
              userId: ctx.userId,
              workspaceId: ctx.workspaceId,
              projectId: plan.projectId,
              projectKey,
            }),
          )
          .catch((err: unknown) => {
            console.warn(
              `[plansService.approvePlan] fresh-establish convention trigger failed for project ${plan.projectId}; skipping (a proposal can be re-established later)`,
              err,
            );
          });
      }

      // Give the conversation its targets back — the epic's stories now exist, so
      // the level the lock was held at is finished (MOTIR-2787).
      await releasePlanTargetLocks(plan, ctx);

      // PROPOSE the project's repository set (Story MOTIR-1775 · MOTIR-1881) — the
      // approved plan is what the set's cardinality is derived from, so this is the
      // moment it can be proposed at all. Writes `proposed` rows the establish step
      // then shows as editable (ADR §0.2: Motir proposes, the user decides); it
      // creates nothing on GitHub.
      //
      // Fired on EVERY approve, not only the first onboarding: the proposer's own
      // guard is "a project whose set has any row is left completely alone", so a
      // re-plan approve of an established project is one cheap read, while a project
      // whose first attempt lost to a motir-ai hiccup gets another chance instead of
      // being permanently setless.
      //
      // BEST-EFFORT and AFTER the tx commits, for both of the reasons the convention
      // trigger above is: the pre-plan read is a `server-only` client call that
      // cannot run inside the DB transaction, and establishing repos — important as
      // it is — is not worth failing a plan approval over (ADR §4.3 is the same
      // judgement one level down). A failure leaves the user an empty-but-editable
      // set, which MOTIR-1782 can complete later (ADR §4.4: approval is not the last
      // chance to establish a repo). Imported LAZILY for the same reason: the E2E
      // plan seeds import plansService in the Playwright Node process, where
      // `server-only` does not resolve.
      return toPlanWithItemsDto(row, items);
    } catch (err) {
      if (err instanceof PlanTargetImmutableError) {
        // BEST-EFFORT, and it must not mask the refusal. If this write fails the
        // caller still gets its 409 and the eager listener remains the primary
        // mover — so a swallowed error here costs a status flip, never the
        // verdict. Lock-then-re-read, the same guard `markPlanned` /
        // `declinePlan` use: a plan somebody decided under us is a no-op.
        try {
          await withWorkspaceContext(
            { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
            async (tx) => {
              const locked = await planRepository.lockById(planId, tx);
              if (!locked) return;
              const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
              if (!fresh || fresh.status !== 'planned') return;
              await planRepository.update(planId, { status: 'stale' }, tx);
            },
          );
        } catch {
          // Swallowed on purpose — see above.
        }
      }
      throw err;
    }
  },

  /**
   * End a plan without materializing it: set `declined` + decidedAt/decidedById,
   * record WHY it ended, and KEEP every PlanItem. The tree was NEVER touched
   * (adds never materialized; modify/remove targets untouched) → a clean no-op
   * on the work-item tree.
   *
   * ⚠️ THREE FROM-STATUSES, ONE IMPLEMENTATION (MOTIR-3189, widened by
   * MOTIR-3579). `planned` is the
   * REVIEW decision this method was written for; `generating` is a DISCARD of a
   * plan that never finished being written. They are the same act — stop this
   * plan, keep what it proposed — and the only thing that differs is the
   * `decisionReason` the from-status names, so a second method would be a second
   * copy of the permission check, the row lock, the retention rule and the lock
   * release, kept in step by hand.
   *
   * `stale` (AMENDMENT 9 D4) is the third, and it joins `planned` rather than
   * forming a fourth case: it is a REVIEW decision — the plan reached a reviewer,
   * who read it and gave up because its premise had moved. Declining is one of a
   * stale plan's only two exits (the other is waiting for the drift to reverse),
   * so without this widening the status would be a dead end wearing a live face.
   *
   * ⚠️ AND `generating` HAD NO EXIT AT ALL BEFORE THIS, which is the defect.
   * Both deciders re-read under the row lock and threw unless the status was
   * `planned`, so a plan whose producer died mid-generation could not be
   * approved, declined or discarded by anyone — while
   * `findUndecidedByProject` went on reading it as UNDECIDED and pausing that
   * project's auto-plan cadence for good, with the settings page reporting a
   * proposal waiting on a decision nobody could make. AMENDMENT 2 excluded
   * partial plans from the reconciling sweep precisely to leave that decision to
   * a person; nobody checked that the person had a door.
   *
   * ⚠️ `plannedAt` IS NOT BACK-FILLED on a discard. The generation frontier
   * genuinely never closed, and stamping it would make a plan that died halfway
   * indistinguishable from one that finished and was turned down — the exact
   * conflation `decisionReason` exists to remove.
   *
   * ⚠️ This used to drop every item inside the same transaction, and that is
   * the defect MOTIR-3154 reports (fixed here, MOTIR-3160). Not writing
   * to the tree is what declining MEANS; erasing the proposal is a separate act
   * nobody asked for, and it destroyed the only record of what the planner
   * offered and a person turned down. A declined plan read `0 items` for ever —
   * indistinguishable from a plan that proposed nothing — so the review model
   * had nothing to draw and MOTIR-1377 had to short-circuit the empty state to
   * stop it shadowing the declined outcome. That holds for a DISCARD unchanged,
   * and matters more there: a half-generated plan's proposals are the only
   * record of how far the producer got.
   */
  async declinePlan(planId: string, ctx: ServiceContext): Promise<PlanDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    // `ai:decide_plan` (MOTIR-3188) — declining ENDS a plan, which is a decision
    // about somebody's tree even though it writes no work item. It travels with
    // approve rather than with the author writes for that reason: the pair is
    // "who decides", not "who writes to a plan row".
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:decide_plan');

    const { row, count } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        if (
          fresh.status !== 'planned' &&
          fresh.status !== 'generating' &&
          fresh.status !== 'stale'
        ) {
          // `approved` / `declined` — already decided. The message names both
          // legal origins so the 409 says what would have worked, and `actual`
          // still rides the field for a caller that has to branch on it
          // (MOTIR-3025).
          throw new PlanNotInExpectedStatusError(
            planId,
            fresh.status,
            'planned, stale or generating',
          );
        }
        const updated = await planRepository.update(
          planId,
          {
            status: 'declined',
            decidedAt: new Date(),
            decidedById: ctx.userId,
            // The FROM-status is the reason, and it is read under the lock
            // rather than from the pre-lock `plan` — a plan that reached
            // `planned` while this call was in flight was reviewed, not
            // discarded, and the record should say so.
            // ⚠️ `stale` RECORDS `reviewed`, WITH `planned` (MOTIR-3579,
            // AMENDMENT 9 D4). The reason names the HISTORY, and a stale plan's
            // history is that it reached a reviewer and was read — the drift is
            // why they gave up, not a different kind of ending. `discarded` is
            // for a plan that never finished being written, which this one did.
            decisionReason:
              fresh.status === 'planned' || fresh.status === 'stale' ? 'reviewed' : 'discarded',
          },
          tx,
        );
        // The real count, read inside the same transaction — `markPlanned` above
        // does exactly this. The return used to be `toPlanDto(row, 0)`, a
        // hardcoded zero that was true only while the delete above existed; with
        // the rows retained it would tell the caller that just declined a plan it
        // has no items while `listPlans` (which counts through
        // `countByPlanIds`) says otherwise (MOTIR-3160).
        const n = await planItemRepository.countByPlan(planId, tx);
        // The ending, on the trail (MOTIR-3535). A decision is always a PERSON's
        // — `ai:decide_plan` has no machine path — so it records the decider and
        // no agent triple, however the plan itself was written. The reason is the
        // same one the row stores, so the timeline can tell the three histories
        // `declined` covers apart without re-deriving them (MOTIR-3189).
        await planRevisionsService.recordRevision(
          {
            planId,
            changeKind: 'declined',
            changedById: ctx.userId,
            diff: { itemCount: n, decisionReason: updated.decisionReason },
          },
          tx,
        );
        return { row: updated, count: n };
      },
    );
    // Declining is as terminal for the lock as approving: the output will never
    // exist, so continuing to hold the targets blocks a colleague for nothing
    // (MOTIR-2787). The tree was never touched, so there is nothing else to undo.
    await releasePlanTargetLocks(plan, ctx);
    return toPlanDto(row, count);
  },
};

// Re-export the DTO `toPlanItemDto` use so the unused-import linter doesn't trip
// when a caller only needs the item mapper through the service module surface.
export { toPlanItemDto };
