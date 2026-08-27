import { gatingItemSatisfied } from '@/lib/workItems/validity';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { TEMP_REF_PREFIX, plansService } from '@/lib/services/plansService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { NoActiveSprintError } from '@/lib/sprints/errors';
// The PROJECTION itself moved to its own service in MOTIR-3096, because the
// projected READS are a second consumer of it. The rules are unchanged; what
// changed is that they are no longer private to this file.
import {
  buildProjection,
  isDone,
  resolveProjectedRoot,
  type Projection,
  type ProjectedNode,
} from '@/lib/services/planProjectionService';
import {
  buildProseVsGraphAdvisories,
  type ProseAdvisoryLocalRef,
} from '@/lib/services/proseGraphAdvisoryService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemProseAdvisoryDto, WorkItemValidityDto } from '@/lib/dto/workItems';
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
//
// ⚠️ The PROJECTION moved to `lib/services/planProjectionService.ts` (MOTIR-3096)
// when the projected READS became its second consumer. Its semantics — the three
// op kinds, temp-ref resolution, the never-persisted contract — are documented
// there, verbatim from here, and are unchanged by the move.

/** Stable wire order: by gated item, then by blocker. */
function sortBlockers(blockers: SprintBlockerDto[]): SprintBlockerDto[] {
  return blockers.sort(
    (a, b) => a.item.localeCompare(b.item) || a.blockedBy.localeCompare(b.blockedBy),
  );
}

/**
 * The PROSE-vs-GRAPH advisories (MOTIR-1969) over the PROJECTED tree — the
 * projected twin of `computeSubtreeProseAdvisories` in `workItemsService`, and
 * the reason the check is worth having here at all: the planner can see the gap
 * BEFORE it materializes, which is the moment the miss is cheapest to fix.
 *
 * Same rule, projected inputs. A member's body is the PROJECTED one — an `add`'s
 * proposed text or a `modify`'s patched text (both in `proj.projectedDescription`),
 * falling back to the stored body for an untouched real node. Exempt per member:
 * itself, its projected ANCESTOR chain, and its projected `blocked_by` set. Both
 * the SCANNED card and the REFERENCE may be a `planItem:<id>` temp-ref — a
 * projected body names a projected sibling with the intra-plan token form, which
 * `bodyReferenceSeverities` keys by that same temp-ref, so an `add` that names a
 * sibling `add` without wiring `blockedByRefs` is caught exactly like a live one.
 *
 * ⚠️ ADVISORY, NEVER A BLOCKER — the verdict above is computed without it.
 *
 * `validateProjectedPlan` (the FOREST verdict) deliberately carries no
 * advisories: an advisory is a per-CARD property (this body vs this card's
 * edges) and the forest has no single subject. Per-card coverage is the
 * `validateProjectedWorkItem` call above.
 */
/**
 * One projected SIZING column (MOTIR-3110) — the plan's value where the plan
 * sets one, else the stored one.
 *
 * Sparse-patch semantics, identical to the projected body and `type` above: an
 * `add`'s `proposedFields` is the ONLY shape there is (absent ⇒ `null`), while a
 * `modify`'s patch counts only when the KEY is present — `'storyPoints' in patch`
 * — so an explicit `null` reads as *the plan clears this estimate* and an absent
 * key leaves the stored number standing.
 */
function projectedSizing(
  proj: Projection,
  nodeId: string,
  field: 'storyPoints' | 'estimateMinutes',
  stored: number | null,
): number | null {
  const proposal = proj.proposalByRef.get(nodeId);
  if (proposal) return proposal.proposedFields?.[field] ?? null;
  const patch = proj.patchByWorkItemId.get(nodeId);
  if (patch && field in patch) return patch[field] ?? null;
  return stored;
}

async function projectedProseAdvisories(
  proj: Projection,
  memberIds: ReadonlySet<string>,
  ctx: ServiceContext,
): Promise<WorkItemProseAdvisoryDto[]> {
  // Only NOT-done members are scanned — the same filter the blocker walk uses.
  const scanned = [...memberIds]
    .map((id) => proj.nodes.get(id))
    .filter((n): n is ProjectedNode => n !== undefined && !isDone(proj, n));
  if (scanned.length === 0) return [];

  // Stored rows for every REAL member scanned. A `modify` whose body the plan
  // re-writes still needs its stored `type` / `executor` (the patch may touch
  // neither), so the read is keyed on "is this node real", not on "is its body
  // projected" — one batched read either way.
  const needsStoredRow = scanned.filter((n) => !n.id.startsWith(TEMP_REF_PREFIX)).map((n) => n.id);
  const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findDescriptionsByIds(needsStoredRow, ctx.workspaceId, tx),
  );
  const storedRows = new Map(rows.map((r) => [r.id, r] as [string, (typeof rows)[number]]));

  // The SELF-BLOCKING-DESIGN check's edge half (MOTIR-3625), projected. A
  // blocker's type comes from the PLAN wherever the plan sets one — an `add`
  // proposing the very `type: design` card this lift creates is the commonest
  // shape a plan-time author has, and it has no stored row at all — and from the
  // stored row otherwise. Only the REAL blockers the read above did not already
  // fetch are looked up, and by TYPE alone rather than by body.
  const blockerIds = new Set<string>();
  for (const node of scanned) {
    for (const blockerId of proj.blockedBy.get(node.id) ?? []) blockerIds.add(blockerId);
  }
  const storedBlockerTypes = new Map(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findTypesByIds(
          [...blockerIds].filter((id) => !id.startsWith(TEMP_REF_PREFIX) && !storedRows.has(id)),
          ctx.workspaceId,
          tx,
        ),
      )
    ).map((r) => [r.id, r.type]),
  );
  const blockerType = (id: string): string | null =>
    proj.projectedType.has(id)
      ? (proj.projectedType.get(id) ?? null)
      : (storedRows.get(id)?.type ?? storedBlockerTypes.get(id) ?? null);

  const subjects = scanned.map((node) => {
    const exemptIds = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId !== null && !exemptIds.has(parentId)) {
      exemptIds.add(parentId);
      parentId = proj.nodes.get(parentId)?.parentId ?? null;
    }
    for (const blockerId of proj.blockedBy.get(node.id) ?? []) exemptIds.add(blockerId);
    const stored = storedRows.get(node.id);
    return {
      item: node.identifier,
      descriptionMd: proj.projectedDescription.has(node.id)
        ? (proj.projectedDescription.get(node.id) ?? null)
        : (stored?.descriptionMd ?? null),
      exemptIds,
      // Projected shape wins where the plan sets one; stored otherwise.
      type: proj.projectedType.has(node.id)
        ? (proj.projectedType.get(node.id) ?? null)
        : (stored?.type ?? null),
      executor: proj.projectedExecutor.has(node.id)
        ? (proj.projectedExecutor.get(node.id) ?? null)
        : (stored?.executor ?? null),
      // The REPO-STRADDLE repository set (MOTIR-2177, widened to a SET in
      // MOTIR-2728) is the STORED value or nothing — there is no projected
      // counterpart and that is not a gap. A proposal carries a
      // `targetRepoRole`, resolved to a repo NAME only at materialize, so an
      // `add` has no name to contradict: it takes the unpinnable arm, which is
      // exactly gate 1's question about a card whose deliverables you can
      // enumerate but whose repo you cannot.
      targetRepos: stored?.targetRepos ?? [],
      // The SUBSUMPTION check's inputs (MOTIR-2903) — STORED only, and null for
      // a not-yet-materialized `add`, which is the honest answer: a card that
      // does not exist yet has no pull requests of its own to exclude and no
      // filing instant to measure a merge against, so the check is SKIPPED for
      // it rather than run on a substituted date. A `modify` of a real row keeps
      // both, so an existing card being re-planned is still checked.
      id: stored?.id ?? null,
      createdAt: stored?.createdAt ?? null,
      // The ESTIMATION-GATE check (MOTIR-3110), projected. Sizing has BOTH a
      // proposed and a patched form — an `add` carries `proposedFields`, a
      // `modify` may re-scope the stored numbers — so the plan's value wins
      // wherever the plan sets one, with the same sparse-patch semantics the
      // body and `type` use above. This is the earliest moment an over-sized
      // card can be seen at all: the author sealing the plan, before the card
      // has a key.
      storyPoints: projectedSizing(proj, node.id, 'storyPoints', stored?.storyPoints ?? null),
      estimateMinutes: projectedSizing(
        proj,
        node.id,
        'estimateMinutes',
        stored?.estimateMinutes ?? null,
      ),
      // Children come from the PROJECTED adjacency, never the stored row: a plan
      // that `add`s a child under a leaf makes it a container, and a plan that
      // `remove`s a container's last child makes it a leaf. Both are exactly the
      // questions the gate asks, and only the projection can answer them.
      hasChildren: (proj.childrenByParent.get(node.id)?.length ?? 0) > 0,
      // The SELF-BLOCKING-DESIGN check's edge half (MOTIR-3625), off the SAME
      // projected adjacency the exempt walk above consumes — so a plan that
      // LIFTS a card's design into a proposed sibling and wires the edge in the
      // same batch stops the advisory at authoring time, which is the earliest
      // moment the remedy exists.
      hasDesignBlocker: [...(proj.blockedBy.get(node.id) ?? [])].some(
        (blockerId) => blockerType(blockerId) === 'design',
      ),
    };
  });

  // Resolve every reference that lives in the PROJECTION against the projection
  // (that is what makes a temp-ref resolvable, and what makes a `modify`'s
  // projected status win over the stored one). Carried-in cross-project blocker
  // nodes are deliberately EXCLUDED: they entered the projection off a live edge
  // with no browse check, so they go through the advisory service's batched read
  // and its `filterBrowsable` gate instead — no existence leak.
  const localRefs = new Map<string, ProseAdvisoryLocalRef>();
  for (const node of proj.nodes.values()) {
    if (node.projectId !== proj.projectId) continue;
    localRefs.set(node.id, {
      identifier: node.identifier,
      status: node.status,
      done: isDone(proj, node),
    });
  }

  return buildProseVsGraphAdvisories(subjects, ctx, localRefs);
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
        /* v8 ignore next -- UNREACHABLE: a member's blocker set is a `Set` of ids and every projected node's identifier is distinct, so one walk cannot produce the same `<item> <blocker>` key twice. Kept as the guard the SPRINT walk's `addBlocker` genuinely needs (there one member is reached through several probes). Invariant asserted in tests/integration/plans/planValidityService.test.ts — 'the projection invariant behind the walks' defensive arms' (MOTIR-3123). */
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
    const advisories = await projectedProseAdvisories(proj, memberIds, ctx);
    return { key: root.identifier, valid: blockers.length === 0, blockers, advisories };
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
        /* v8 ignore next -- UNREACHABLE: a member's blocker set is a `Set` of ids and every projected node's identifier is distinct, so one walk cannot produce the same `<item> <blocker>` key twice. Kept as the guard the SPRINT walk's `addBlocker` genuinely needs (there one member is reached through several probes). Invariant asserted in tests/integration/plans/planValidityService.test.ts — 'the projection invariant behind the walks' defensive arms' (MOTIR-3123). */
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

    // ⚠️ THE SECOND QUESTION (MOTIR-3575). Everything above answers
    // FINISHABILITY — can every item in the projected forest be finished once
    // this plan materializes? That is a real question and it is correctly
    // answered, but it is not the question a caller asks by the word `valid`.
    // APPROVABILITY is the other half: would the approve button take this plan
    // at all? Before this, `validate_plan` answered `VALID` for plans approve
    // then refused, and that yes was load-bearing — it is what made a plan
    // carrying a dangling ref safe to close (MOTIR-3560).
    //
    // Delegated rather than re-implemented, so the validator and the button can
    // never disagree about what approvable means: `checkApprovability` runs the
    // SAME `runPersistGate` `approvePlan` runs, as a read.
    const rejections = await plansService.checkApprovability(planId, ctx);

    return {
      planId,
      // Both halves, so a caller reading only `valid` cannot get a false green —
      // which is exactly the reading that failed here.
      valid: blockers.length === 0 && rejections.length === 0,
      blockers,
      rejections,
    };
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
    const sprint = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      sprintRepository.findActiveByProject(proj.projectId, ctx.workspaceId, tx),
    );
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
        /* v8 ignore next -- UNREACHABLE: `childrenByParent` is derived from the FINAL `nodes` map (`buildProjection`), so every child id it holds resolves. Same invariant + same test as the `seen` guards above (MOTIR-3123). */
        if (!child) continue;
        if (gatingItemSatisfied(memberIds.has(childId), isDone(proj, child), condition)) continue;
        addBlocker(m.id, child.identifier, child.status, child.sprintId);
      }
    }
    sortBlockers(blockers);
    return { sprintId: sprint.id, valid: blockers.length === 0, blockers };
  },
};
