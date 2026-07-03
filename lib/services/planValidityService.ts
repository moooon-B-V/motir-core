import { gatingItemSatisfied } from '@/lib/workItems/validity';
import { plansService, TEMP_REF_PREFIX } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { NoActiveSprintError } from '@/lib/sprints/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemValidityDto } from '@/lib/dto/workItems';
import type { PlanValidityDto } from '@/lib/dto/plans';
import type { SprintBlockerDto, SprintValidityDto } from '@/lib/dto/sprints';
import { type ValidityCondition, DEFAULT_VALIDITY_CONDITION } from '@/lib/dto/sprints';

// ── Pre-commit plan validation (Story 7.28 · Subtask 7.28.1 / MOTIR-1386) ──────
//
// The PlanItem-stage analogue of the shipped `validate_work_item` /
// `validate_sprint` MCP tools (MOTIR-1374/1375). Those answer "is this finishable"
// over the LIVE `work_item` tree; this answers the SAME question over the
// PROJECTED tree — the live tree ⊕ a Plan's `PlanItem` delta — so the AI planner
// can self-correct BEFORE it materializes a plan, and the `motir run` loop never
// inherits an un-finishable sprint.
//
// It REUSES, never re-implements, the finishability PREDICATE
// (`gatingItemSatisfied`) and mirrors the WALK structure of `computeWorkItemValidity`
// (the subtree rule) and `computeSprintValidity` (the sprint rule). The only
// difference is the data source: instead of reading members/edges straight from
// the DB, it builds an in-memory VIRTUAL graph (never persisted) by applying the
// plan's `add` / `modify` / `remove` ops — resolving temp-refs through the EXACT
// `TEMP_REF_PREFIX` contract `materialize` uses — and runs the same walks over it.
//
// Projection semantics (kept explicit, and matching `materialize`):
//   • `add`    → a NEW not-done node under `resolve(parentRef)` with `blocked_by`
//                = `resolve(blockedByRefs)`. It lands in the BACKLOG (no sprint),
//                so it is NOT a sprint member unless a future field says so.
//   • `modify` → only `patch.blockedByAdd` / `blockedByRemove` affect finishability
//                (title/priority/type/storyPoints/estimateMinutes don't); applied
//                to the target's edge set.
//   • `remove` → the target node AND every edge touching it are dropped (a removed
//                item neither gates nor is gated — single-node, like archive).
//   • a temp-ref `planItem:<id>` resolves to that same-plan `add`; a real id to
//                itself.
//
// A blocker named in the verdict may be a `planItem:<id>` temp-ref when the gating
// node is a not-yet-materialized `add` — the DTO's `item` / `blockedBy` are plain
// strings, so no schema change is needed (the contract, 7.28.3).

/** One node in the projected virtual graph (a real work item, or a plan `add`). */
interface ProjectedNode {
  /** Real `workItemId`, or the temp-ref `planItem:<planItemId>` for an `add`. */
  id: string;
  /** Real identifier (e.g. "MOTIR-1337"), or the temp-ref for an `add`. */
  identifier: string;
  /** Raw workflow status key (an `add` carries the project's initial status). */
  status: string;
  /** The node's project (a blocker can be cross-project; finding #21). */
  projectId: string;
  /** Projected parent id (a real id or a temp-ref), or null. */
  parentId: string | null;
  /** Sprint membership; an `add` lands in the backlog → null. */
  sprintId: string | null;
}

/** The assembled projection: nodes + projected `blocked_by` adjacency. */
interface Projection {
  projectId: string;
  /** id → node. Removed nodes are absent. */
  nodes: Map<string, ProjectedNode>;
  /** from-id → set of blocker (to) ids — the projected `is_blocked_by` edges. */
  blockedBy: Map<string, Set<string>>;
  /** parent-id → child ids — derived from `nodes`' projected `parentId`. */
  childrenByParent: Map<string, string[]>;
  /** Per-project terminal (`category = 'done'`) status keys, for done-ness. */
  terminalByProject: Map<string, Set<string>>;
}

function addEdge(blockedBy: Map<string, Set<string>>, fromId: string, toId: string): void {
  const set = blockedBy.get(fromId);
  if (set) set.add(toId);
  else blockedBy.set(fromId, new Set([toId]));
}

function removeEdge(blockedBy: Map<string, Set<string>>, fromId: string, toId: string): void {
  blockedBy.get(fromId)?.delete(toId);
}

/**
 * Build the virtual graph = the project's live tree ⊕ the plan's PlanItem delta.
 * Pure in-memory over read-only repository loads — NOTHING is persisted. The plan
 * is read through `plansService.getPlan`, which applies the browse access gate, so
 * the caller never reaches a plan/project it can't see.
 */
async function buildProjection(planId: string, ctx: ServiceContext): Promise<Projection> {
  const plan = await plansService.getPlan(planId, ctx);
  const projectId = plan.projectId;

  // The project's live node set + the initial status an `add` would be created in.
  const liveItems = await workItemRepository.findAllByProjectForValidity(
    projectId,
    ctx.workspaceId,
  );
  const initialStatus =
    (await workflowsService.getInitialStatusKey(projectId, ctx.workspaceId)) ?? '';

  const nodes = new Map<string, ProjectedNode>();
  for (const it of liveItems) {
    nodes.set(it.id, {
      id: it.id,
      identifier: it.identifier,
      status: it.status,
      projectId: it.projectId,
      parentId: it.parentId,
      sprintId: it.sprintId,
    });
  }

  // Live `is_blocked_by` edges among the project's items. The blocker may be
  // cross-project (a block can span projects) — carry it in as a node from the
  // edge's own fields so its done-ness/membership is judged against its OWN project.
  const blockedBy = new Map<string, Set<string>>();
  const liveEdges = await workItemLinkRepository.findBlockerEdgesForItems(
    liveItems.map((it) => it.id),
  );
  for (const e of liveEdges) {
    if (!nodes.has(e.blockerId)) {
      nodes.set(e.blockerId, {
        id: e.blockerId,
        identifier: e.blockerKey,
        status: e.blockerStatus,
        projectId: e.blockerProjectId,
        parentId: null,
        sprintId: e.blockerSprintId,
      });
    }
    addEdge(blockedBy, e.fromId, e.blockerId);
  }

  const resolveRef = (ref: string): string =>
    ref.startsWith(TEMP_REF_PREFIX)
      ? `${TEMP_REF_PREFIX}${ref.slice(TEMP_REF_PREFIX.length)}`
      : ref;

  const adds = plan.items.filter((i) => i.op === 'add');
  const modifies = plan.items.filter((i) => i.op === 'modify');
  const removes = plan.items.filter((i) => i.op === 'remove');

  // Pass 1 — virtual `add` nodes (keyed by their temp-ref, so an intra-plan
  // parent/blocker ref resolves with no topo ordering needed).
  for (const item of adds) {
    const id = `${TEMP_REF_PREFIX}${item.id}`;
    nodes.set(id, {
      id,
      identifier: id,
      status: initialStatus,
      projectId,
      parentId: item.parentRef ? resolveRef(item.parentRef) : null,
      sprintId: null,
    });
  }

  // A real id an `add`/`modify` references but the project load didn't cover (a
  // cross-project blocker not already on a live edge). Resolve it to a node so its
  // status/project/sprint are real; an archived/missing ref simply yields no node,
  // so the edge is dropped (mirrors the archived-blocker read-exclusion).
  const referenced = new Set<string>();
  const note = (ref: string) => {
    const id = resolveRef(ref);
    if (!id.startsWith(TEMP_REF_PREFIX) && !nodes.has(id)) referenced.add(id);
  };
  for (const item of adds) item.blockedByRefs.forEach(note);
  for (const item of modifies) (item.patch?.blockedByAdd ?? []).forEach(note);
  if (referenced.size > 0) {
    const extra = await workItemRepository.findByIdsInWorkspace([...referenced], ctx.workspaceId);
    for (const row of extra) {
      if (row.archivedAt) continue;
      nodes.set(row.id, {
        id: row.id,
        identifier: row.identifier,
        status: row.status,
        projectId: row.projectId,
        parentId: row.parentId,
        sprintId: row.sprintId,
      });
    }
  }

  // Pass 2 — `add` blocked_by edges (all add targets now exist).
  for (const item of adds) {
    const fromId = `${TEMP_REF_PREFIX}${item.id}`;
    for (const ref of item.blockedByRefs) {
      const toId = resolveRef(ref);
      if (nodes.has(toId)) addEdge(blockedBy, fromId, toId);
    }
  }

  // Pass 3 — `modify` edge changes (title/priority/type ignored for finishability).
  for (const item of modifies) {
    if (!item.workItemId || !nodes.has(item.workItemId)) continue;
    for (const ref of item.patch?.blockedByAdd ?? []) {
      const toId = resolveRef(ref);
      if (nodes.has(toId)) addEdge(blockedBy, item.workItemId, toId);
    }
    for (const ref of item.patch?.blockedByRemove ?? []) {
      removeEdge(blockedBy, item.workItemId, resolveRef(ref));
    }
  }

  // Pass 4 (LAST) — `remove` drops the target node AND every edge touching it, so
  // a removed item neither gates nor is gated even if an earlier pass added an edge.
  for (const item of removes) {
    const target = item.workItemId;
    if (!target) continue;
    nodes.delete(target);
    blockedBy.delete(target);
    for (const set of blockedBy.values()) set.delete(target);
  }

  // Derived parent→child adjacency over the final projected `parentId` edges.
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.parentId == null) continue;
    const arr = childrenByParent.get(node.parentId);
    if (arr) arr.push(node.id);
    else childrenByParent.set(node.parentId, [node.id]);
  }

  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    [...new Set([...nodes.values()].map((n) => n.projectId))],
    ctx.workspaceId,
  );

  return { projectId, nodes, blockedBy, childrenByParent, terminalByProject };
}

/** Is a node's raw status terminal (`category = 'done'`) in its OWN project? */
function isDone(proj: Projection, node: ProjectedNode): boolean {
  return proj.terminalByProject.get(node.projectId)?.has(node.status) ?? false;
}

/** Stable wire order: by gated item, then by blocker. */
function sortBlockers(blockers: SprintBlockerDto[]): SprintBlockerDto[] {
  return blockers.sort(
    (a, b) => a.item.localeCompare(b.item) || a.blockedBy.localeCompare(b.blockedBy),
  );
}

/**
 * Resolve the subtree-validation ROOT. A `planItem:<id>` temp-ref points at an
 * `add` THIS plan proposes — it lives in the projection (keyed by its temp-ref),
 * so resolve it there; an unknown temp-ref (no such proposed node) is a
 * `WorkItemNotFoundError`. Any other key is a REAL item resolved against the live
 * tree (the existing-anchor / extend case). Returns just `{ id, identifier }` —
 * the only fields the subtree walk + verdict need (MOTIR-1431).
 */
async function resolveProjectedRoot(
  proj: Projection,
  targetKey: string,
  ctx: ServiceContext,
): Promise<{ id: string; identifier: string }> {
  if (targetKey.startsWith(TEMP_REF_PREFIX)) {
    const node = proj.nodes.get(targetKey);
    if (!node) throw new WorkItemNotFoundError(targetKey);
    return { id: node.id, identifier: node.identifier };
  }
  const wi = await workItemsService.getWorkItemByIdentifier(proj.projectId, targetKey, ctx);
  return { id: wi.id, identifier: wi.identifier };
}

export const planValidityService = {
  /**
   * Is the PROJECTED subtree of `targetKey` finishable, once `planId` materializes?
   * The PlanItem-stage analogue of `workItemsService.validateWorkItem` (the subtree
   * rule, MOTIR-1375): membership is the PROJECTED subtree (projected `parentId`
   * edges), and the `blocked_by` edges are the projected set. VALID ⟺ for every
   * not-done item in the subtree, every `blocked_by` dependency is satisfied — IN
   * the subtree, or (under `loose`) `done`. A blocker may be named by a
   * `planItem:<id>` temp-ref when the gating node is a not-yet-materialized `add`.
   *
   * The `targetKey` root may be a REAL committed item (resolved against the live
   * tree — the re-parent/extend case) OR a `planItem:<id>` temp-ref for a node
   * THIS plan proposes (resolved against the projection — the `add` already lives
   * in `proj.nodes`). The temp-ref path is what lets a BRAND-NEW subtree the plan
   * creates — a new epic, a new story + its new subtasks — be validated by its
   * own temp-ref, not only an existing anchor (MOTIR-1431). A target the plan
   * `remove`s projects to an empty subtree → vacuously valid. Throws
   * `WorkItemNotFoundError` for an unknown real key OR an unknown temp-ref,
   * `PlanNotFoundError` / `ProjectAccessDeniedError` from the plan read.
   */
  async validateProjectedWorkItem(
    planId: string,
    targetKey: string,
    ctx: ServiceContext,
    condition: ValidityCondition = DEFAULT_VALIDITY_CONDITION,
  ): Promise<WorkItemValidityDto> {
    const proj = await buildProjection(planId, ctx);
    const root = await resolveProjectedRoot(proj, targetKey, ctx);

    // The containing set S = the projected subtree of the root (root + descendants).
    const memberIds = new Set<string>();
    const stack: string[] = [];
    if (proj.nodes.has(root.id)) {
      memberIds.add(root.id);
      stack.push(root.id);
    }
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const childId of proj.childrenByParent.get(id) ?? []) {
        if (!memberIds.has(childId)) {
          memberIds.add(childId);
          stack.push(childId);
        }
      }
    }

    const blockers: SprintBlockerDto[] = [];
    const seen = new Set<string>();
    for (const memberId of memberIds) {
      const member = proj.nodes.get(memberId)!;
      if (isDone(proj, member)) continue; // only not-done members need a check
      for (const blockerId of proj.blockedBy.get(memberId) ?? []) {
        const blocker = proj.nodes.get(blockerId);
        if (!blocker) continue;
        if (gatingItemSatisfied(memberIds.has(blockerId), isDone(proj, blocker), condition))
          continue;
        const key = `${member.identifier} ${blocker.identifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        blockers.push({
          item: member.identifier,
          blockedBy: blocker.identifier,
          blockerStatus: blocker.status,
          blockerSprintId: blocker.sprintId,
        });
      }
    }
    sortBlockers(blockers);
    return { key: root.identifier, valid: blockers.length === 0, blockers };
  },

  /**
   * Is the WHOLE plan finishable once it materializes (MOTIR-1550)? The FOREST
   * analogue of `validateProjectedWorkItem` — the containing set S is the ENTIRE
   * projection, not one subtree, so a `blocked_by` edge that crosses two sibling
   * roots (a story under epic B gated by a story under epic A) is SATISFIED: both
   * materialize together, so the gating node IS in S. Iterating the single-subtree
   * rule per root would FALSE-POSITIVE every cross-root edge (the gate sits in a
   * sibling subtree, so it reads as out-of-set) — the exact defect that made a
   * per-root walk "worse than no validation" for the multi-root epic forest
   * `generate_tree` emits (blocks MOTIR-1398; refs MOTIR-844).
   *
   * S = every projected node reachable from a projected forest ROOT — a node in
   * the PLAN's own project whose projected parent is null or itself absent from
   * the projection (real epics + `add`s with a null parentRef, plus any node
   * orphaned by a `remove`). Carried-in cross-project blocker nodes (finding #21)
   * are NOT roots and NOT in S, so a not-done cross-project dependency is
   * correctly surfaced as a residual blocker; under `tight` a `done`-but-out-of-S
   * blocker is too. VALID ⟺ for every not-done member, every projected
   * `blocked_by` is IN S or (under `loose`) `done`. An empty / all-`remove`d plan
   * projects to an empty forest → vacuously valid. Throws the plan-read errors
   * (`PlanNotFoundError` / `ProjectAccessDeniedError`) from the projection build.
   */
  async validateProjectedPlan(
    planId: string,
    ctx: ServiceContext,
    condition: ValidityCondition = DEFAULT_VALIDITY_CONDITION,
  ): Promise<PlanValidityDto> {
    const proj = await buildProjection(planId, ctx);

    // The containing set S = the whole projected forest of the plan's project:
    // every node reachable DOWN from a forest root. A root is a plan-project node
    // whose projected parent is null or absent (a real epic, an `add` with no
    // parentRef, or a node orphaned by a `remove`). Restricting roots to the
    // plan's OWN project keeps carried-in cross-project blocker nodes out of S, so
    // each is judged by its own done-ness, never treated as satisfied-because-
    // in-set.
    const memberIds = new Set<string>();
    const stack: string[] = [];
    for (const node of proj.nodes.values()) {
      if (node.projectId !== proj.projectId) continue; // cross-project blockers are not roots
      if (node.parentId != null && proj.nodes.has(node.parentId)) continue; // has a projected parent
      if (!memberIds.has(node.id)) {
        memberIds.add(node.id);
        stack.push(node.id);
      }
    }
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const childId of proj.childrenByParent.get(id) ?? []) {
        if (!memberIds.has(childId)) {
          memberIds.add(childId);
          stack.push(childId);
        }
      }
    }

    // The SAME per-member rule as the subtree walk, applied over the whole-forest S.
    const blockers: SprintBlockerDto[] = [];
    const seen = new Set<string>();
    for (const memberId of memberIds) {
      const member = proj.nodes.get(memberId)!;
      if (isDone(proj, member)) continue; // only not-done members need a check
      for (const blockerId of proj.blockedBy.get(memberId) ?? []) {
        const blocker = proj.nodes.get(blockerId);
        if (!blocker) continue;
        if (gatingItemSatisfied(memberIds.has(blockerId), isDone(proj, blocker), condition))
          continue;
        const key = `${member.identifier} ${blocker.identifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        blockers.push({
          item: member.identifier,
          blockedBy: blocker.identifier,
          blockerStatus: blocker.status,
          blockerSprintId: blocker.sprintId,
        });
      }
    }
    sortBlockers(blockers);
    return { planId, valid: blockers.length === 0, blockers };
  },

  /**
   * Will the active sprint be valid once `planId` materializes? The PlanItem-stage
   * analogue of `sprintsService.validateSprint` (the sprint rule, MOTIR-1374) over
   * the PROJECTED graph. Members = the current active-sprint members minus any the
   * plan `remove`s (an `add` lands in the backlog, so it is NOT a member). A
   * not-done in-sprint item is gated by an unsatisfied projected `blocked_by` edge
   * (its own, or an ancestor's — the cascade) OR a not-done child that is neither
   * done nor in the sprint. "Satisfied" = the gating item is in the sprint, or
   * (under `loose`) done.
   *
   * Throws `NoActiveSprintError` (the project has no active sprint — nothing to
   * project a sprint over), plus the plan-read errors.
   */
  async validateProjectedSprint(
    planId: string,
    ctx: ServiceContext,
    condition: ValidityCondition = DEFAULT_VALIDITY_CONDITION,
  ): Promise<SprintValidityDto> {
    const proj = await buildProjection(planId, ctx);
    const sprint = await sprintRepository.findActiveByProject(proj.projectId, ctx.workspaceId);
    if (!sprint) throw new NoActiveSprintError(proj.projectId);

    // Projected sprint members (any status) = live members minus removed; adds are
    // backlog (sprintId null) so never members.
    const members = [...proj.nodes.values()].filter((n) => n.sprintId === sprint.id);
    const memberIds = new Set(members.map((m) => m.id));
    const notDone = members.filter((m) => !isDone(proj, m));
    if (notDone.length === 0) return { sprintId: sprint.id, valid: true, blockers: [] };

    // PROBE set = each not-done member ∪ its projected ancestor chain (a child
    // inherits its ancestors' blockers). gatedMembersByProbe maps a probe id back
    // to the in-sprint member(s) it gates, so a violation is attributed to the
    // in-sprint item, not the ancestor.
    const gatedMembersByProbe = new Map<string, Set<string>>();
    const gate = (probeId: string, memberId: string) => {
      const set = gatedMembersByProbe.get(probeId);
      if (set) set.add(memberId);
      else gatedMembersByProbe.set(probeId, new Set([memberId]));
    };
    for (const m of notDone) {
      gate(m.id, m.id);
      let cursor: string | null = m.parentId;
      const guard = new Set<string>([m.id]); // cycle guard (parentId is acyclic, but be safe)
      while (cursor != null && proj.nodes.has(cursor) && !guard.has(cursor)) {
        guard.add(cursor);
        gate(cursor, m.id);
        cursor = proj.nodes.get(cursor)!.parentId;
      }
    }

    const blockers: SprintBlockerDto[] = [];
    const seen = new Set<string>();
    const addBlocker = (
      memberId: string,
      blockedByName: string,
      blockerStatus: string,
      blockerSprintId: string | null,
    ) => {
      const member = proj.nodes.get(memberId);
      if (!member) return;
      const key = `${member.identifier} ${blockedByName}`;
      if (seen.has(key)) return;
      seen.add(key);
      blockers.push({
        item: member.identifier,
        blockedBy: blockedByName,
        blockerStatus,
        blockerSprintId,
      });
    };

    // Gating via blocked_by edges over the probe set.
    for (const probeId of gatedMembersByProbe.keys()) {
      for (const blockerId of proj.blockedBy.get(probeId) ?? []) {
        const blocker = proj.nodes.get(blockerId);
        if (!blocker) continue;
        if (gatingItemSatisfied(memberIds.has(blockerId), isDone(proj, blocker), condition))
          continue;
        for (const memberId of gatedMembersByProbe.get(probeId)!) {
          addBlocker(memberId, blocker.identifier, blocker.status, blocker.sprintId);
        }
      }
    }
    // The parent-ready cascade: a not-done in-sprint parent is gated by any child
    // that is neither done nor also in the sprint.
    for (const m of notDone) {
      for (const childId of proj.childrenByParent.get(m.id) ?? []) {
        const child = proj.nodes.get(childId);
        if (!child) continue;
        if (gatingItemSatisfied(memberIds.has(childId), isDone(proj, child), condition)) continue;
        addBlocker(m.id, child.identifier, child.status, child.sprintId);
      }
    }
    sortBlockers(blockers);
    return { sprintId: sprint.id, valid: blockers.length === 0, blockers };
  },
};
