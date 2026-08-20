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
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import {
  collectReferencedWorkItemIds,
  validatePlanProposals,
  type LiveWorkItemState,
  type ProposalNode,
} from '@/lib/plans/validateProposals';
import { validateStoryPoints, validateEstimateMinutes } from '@/lib/estimation/validate';
import { PLANNING_SOURCES } from '@/lib/api/v1/workItems/schema';
import {
  InvalidProposalError,
  PlanItemNotFoundError,
  PlanItemTargetMissingError,
  PlanItemUnknownTargetRepoError,
  PlanItemUnknownTargetRepoRoleError,
  PlanNotFoundError,
  PlanNotGeneratingError,
  NoPlanForWorkItemError,
  PlanNotInExpectedStatusError,
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
  PlanWithItemsDto,
  ProposalInput,
  UpdateProposalInput,
} from '@/lib/dto/plans';
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

const DEFAULT_PAGE_LIMIT = 20;
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
  for (const item of adds) {
    const fromId = planItemToWorkItem.get(item.id)!;
    for (const ref of item.blockedByRefs) {
      await workItemLinkRepository.create(
        {
          workspaceId: ctx.workspaceId,
          fromId,
          toId: resolveRef(ref),
          kind: 'is_blocked_by',
          createdById: ctx.userId,
        },
        tx,
      );
    }
  }

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
  // `ai:view_plan` (Story MOTIR-2291 · Subtask MOTIR-2363). ⚠️ THE NAME IS THE
  // MISLEADING PART: this key governs reading a generated plan AND acting on it,
  // because they are the same surface and a reviewer who may not act has nothing
  // to review for. Approving MATERIALIZES work items, so it is a write key
  // wearing a read's name — which is why the decision record puts it at `member`
  // rather than at browse, and why every method that writes to a PLAN row asks it,
  // not just the two the routes call. The project comes from the PLAN row, never
  // from the actor's active project.
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
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) =>
        planRepository.create(
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
            origin: input.origin ?? 'user',
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
            authorSource: input.authorSource ?? null,
            authorHarness: normalizeSelfReported(input.authorHarness),
            authorModel: normalizeSelfReported(input.authorModel),
          },
          tx,
        ),
    );
    return toPlanDto(row, 0);
  },

  /**
   * Append proposed `add`/`modify`/`remove` PlanItems to a `generating` plan
   * (the producer calls this per node / per batch). NO WorkItem is created here.
   * The plan row is locked + its status re-read so an append racing a
   * `markPlanned` is rejected once the plan leaves `generating`.
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

    const { row, items } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        if (fresh.status !== 'generating') throw new PlanNotGeneratingError(planId, fresh.status);

        for (const p of proposals) {
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
        const allItems = await planItemRepository.findByPlan(planId, tx);
        return { row: fresh, items: allItems };
      },
    );
    return toPlanWithItemsDto(row, items);
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
        return { row: updated, count: n };
      },
    );
    return toPlanDto(row, count);
  },

  /** A project's plans, newest first, cursor-paginated (the list view). */
  async listPlans(
    projectId: string,
    ctx: ServiceContext,
    opts: ListPlansOptions = {},
  ): Promise<PlanListPageDto> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const limit = clampLimit(opts.limit);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.listByProject(projectId, ctx.workspaceId, limit + 1, opts.cursor ?? null, tx),
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
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

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
      );

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
  },

  /**
   * Decline a `planned` plan: set `declined` + decidedAt/decidedById and DROP
   * all PlanItems. The tree was NEVER touched (adds never materialized;
   * modify/remove targets untouched) → a clean no-op on the work-item tree.
   */
  async declinePlan(planId: string, ctx: ServiceContext): Promise<PlanDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        if (fresh.status !== 'planned') {
          throw new PlanNotInExpectedStatusError(planId, fresh.status, 'planned');
        }
        await planItemRepository.deleteByPlan(planId, tx);
        return planRepository.update(
          planId,
          { status: 'declined', decidedAt: new Date(), decidedById: ctx.userId },
          tx,
        );
      },
    );
    // Declining is as terminal for the lock as approving: the output will never
    // exist, so continuing to hold the targets blocks a colleague for nothing
    // (MOTIR-2787). The tree was never touched, so there is nothing else to undo.
    await releasePlanTargetLocks(plan, ctx);
    return toPlanDto(row, 0);
  },
};

// Re-export the DTO `toPlanItemDto` use so the unused-import linter doesn't trip
// when a caller only needs the item mapper through the service module surface.
export { toPlanItemDto };
