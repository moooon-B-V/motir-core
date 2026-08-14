import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { activityService } from '@/lib/services/activityService';
import { boardsService } from '@/lib/services/boardsService';
import { labelsService } from '@/lib/services/labelsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { reportsService } from '@/lib/services/reportsService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { planValidityService } from '@/lib/services/planValidityService';
import { plansService } from '@/lib/services/plansService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '@/tests/fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The SEAM tests for MOTIR-2796 (MOTIR-2815 part 2).
//
// Every binding card verified its own service. These verify the joins BETWEEN
// them, which no single card could see:
//
//   1. A read bound by one card and CONSUMED BY ANOTHER card's service. Seven
//      reads in this story are shared, one of them across five services. Each
//      card was told to fix every caller; "was told to" is not evidence, and the
//      ratchet counted READS rather than call sites, so a card that bound the
//      caller in front of it and missed a sibling's registered as complete.
//   2. NESTED-TRANSACTION safety, in both directions — a read handed a `tx` must
//      not open a second one (Prisma rejects nesting), and a read handed none
//      must bind for itself.
//   3. The margin `docs/decisions/bound-read-transaction-shape.md` rests on: the
//      report path staying inside Prisma's DEFAULT 5 s interactive-transaction
//      budget at realistic scale. The ADR ruled out a `TransactionBudget` on a
//      measured 38× margin; if that margin ever went, the decision would need
//      re-taking, so it is asserted rather than assumed.
//
// ⚠️ Every case names a SPECIFIC seeded row and asserts it comes BACK. An unbound
// read returns zero rows and raises nothing, so `toHaveLength(n > 0)` is exactly
// the assertion shape that stays green while the defect is intact.
//
// ⚠️ NOT gated on `isAppRoleTestMode()`, for the reason
// `tests/app-role-bound-context-reads.test.ts` states: CI does not set the flag,
// so a gated test would never run there. Unconditional, each case is a live CI
// path in the default mode and the discriminator under `TEST_DB_APP_ROLE=1`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A parent + child + a blocker, linked — the substrate most seams need. */
async function seedLinkedTrio(identifier: string): Promise<{
  fx: WorkItemFixture;
  epicId: string;
  storyId: string;
  blockerId: string;
}> {
  const fx = await makeWorkItemFixture({ identifier });
  const epic = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title: 'Container' },
    fx.ctx,
  );
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Member', parentId: epic.id },
    fx.ctx,
  );
  const blocker = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Blocker' },
    fx.ctx,
  );
  await workItemsService.linkWorkItems(
    { fromId: story.id, toId: blocker.id, kind: 'is_blocked_by' },
    fx.ctx,
  );
  return { fx, epicId: epic.id, storyId: story.id, blockerId: blocker.id };
}

// ── Shared read 1 · workItemRepository.findByIds — five consuming services ────

describe('workItemRepository.findByIds — every consuming service resolves the row', () => {
  it('workItemsService: the dependency-edge projection names the blocker', async () => {
    const { fx, storyId, blockerId } = await seedLinkedTrio('SR1');

    const edges = await workItemsService.getDependencyEdgesForItems([storyId], fx.ctx);

    expect(edges[storyId]?.blockedBy.map((b) => b.title)).toEqual(['Blocker']);
    expect(blockerId).toBeTruthy();
  });

  it('boardsService: the board column carries the seeded card', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SR2' });
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'On the board' },
      fx.ctx,
    );

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    const ids = board.columns.flatMap((c) => c.cards.map((k) => k.id));
    expect(ids).toContain(card.id);
  });

  it('activityService: the feed hydrates the item a revision references', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SR3' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Has history' },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(item.id, { title: 'Renamed' }, fx.ctx);

    const revisions = await workItemsService.listRevisions(item.id, fx.ctx);

    // The feed's own read run: unbound it produced an EMPTY history for an item
    // that had just been created and renamed.
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    expect(revisions.map((r) => r.changeKind)).toContain('created');

    // …and the activity feed that hydrates those revisions' referents.
    const feed = await activityService.listHistory(item.id, {}, fx.ctx);
    expect(feed.entries.length).toBeGreaterThanOrEqual(2);
  });

  it('dispatchPromptService: the prompt carries the item and its blocker', async () => {
    const { fx, storyId, blockerId } = await seedLinkedTrio('SRC');
    const story = await workItemsService.getWorkItem(storyId, fx.ctx);
    const blocker = await workItemsService.getWorkItem(blockerId, fx.ctx);

    const prompt = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      story.identifier,
      fx.ctx,
    );

    expect(prompt.key).toBe(story.identifier);
    // The blocker section is assembled from the SAME `findByIds` +
    // `findByFromItem` pair, one service over. Unbound, the prompt handed to a
    // coding agent silently omitted the dependency it must not start before.
    expect(prompt.prompt).toContain(blocker.identifier);
  });

  it('publicProjectsService: the PUBLIC board resolves its cards UNBOUND', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SRD' });
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Public card' },
      fx.ctx,
    );
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { accessLevel: 'public' },
    });

    // ⚠️ The one consumer that must NOT bind: `work_item_public_project_read`
    // fires only when `app.workspace_id` is UNSET, so binding this path would
    // DISABLE the arm and empty the public pages. Reading it green with no
    // workspace bound is the assertion — the inverse of every other case here.
    const board = await publicProjectsService.getBoard(fx.projectIdentifier, null);

    expect(board.columns.flatMap((c) => c.cards.map((k) => k.identifier))).toContain(
      card.identifier,
    );
  });
});

// ── Shared read 2 · findAncestorIdsForItems — sprintsService + workItemsService ─

describe('workItemRepository.findAncestorIdsForItems — both consumers see the chain', () => {
  it('workItemsService: readiness inherits the ancestor’s blocker', async () => {
    const { fx, epicId, storyId, blockerId } = await seedLinkedTrio('SR4');
    const child = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Leaf', parentId: storyId },
      fx.ctx,
    );

    const readiness = await workItemsService.getReadiness(child.id, fx.ctx);

    // The cascade: the leaf is blocked because its ANCESTOR is. Unbound, the
    // ancestor walk returned nothing and the leaf reported itself ready — the
    // most dangerous direction, because dispatch would have picked it up.
    expect(readiness.ready).toBe(false);
    expect(readiness.blockedByAncestorId).toBe(storyId);
    expect(blockerId).toBeTruthy();
    expect(epicId).toBeTruthy();
  });

  it('sprintsService: validateSprint reports the inherited blocker as out-of-sprint', async () => {
    const { fx, storyId, blockerId } = await seedLinkedTrio('SR5');
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    await backlogService.assignToSprint(storyId, sprint.id, undefined, fx.ctx);
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    const verdict = await sprintsService.validateSprint(fx.projectId, sprint.id, fx.ctx);

    // The blocker is NOT in the sprint, so the sprint cannot finish. Unbound,
    // every read behind this said "nothing to see" and the sprint validated —
    // a green verdict on a sprint that cannot complete.
    expect(verdict.valid).toBe(false);
    const blocker = await workItemsService.getWorkItem(blockerId, fx.ctx);
    expect(verdict.blockers.map((b) => b.blockedBy)).toContain(blocker.identifier);
  });
});

// ── Shared read 3 · findBlockerEdgesForItems — three consuming services ───────

describe('workItemLinkRepository.findBlockerEdgesForItems — the edge every consumer needs', () => {
  it('workItemsService: getReadinessForItems reports the blocked member as blocked', async () => {
    const { fx, storyId, blockerId } = await seedLinkedTrio('SR6');

    const byItem = await workItemsService.getReadinessForItems([storyId], fx.ctx);

    // A Map, and the value is the verdict itself. `false` is the whole assertion:
    // unbound, the edge read came back empty and this said `true` — an item with
    // an open blocker reported ready to dispatch.
    expect(byItem.get(storyId)).toBe(false);
    expect(blockerId).toBeTruthy();
  });

  it('sprintsService: the same edge drives the sprint verdict', async () => {
    const { fx, storyId } = await seedLinkedTrio('SR7');
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    await backlogService.assignToSprint(storyId, sprint.id, undefined, fx.ctx);
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    const verdict = await sprintsService.validateSprint(fx.projectId, sprint.id, fx.ctx);
    expect(verdict.valid).toBe(false);
  });

  it('planValidityService: the PROJECTED verdict sees the same edge', async () => {
    const { fx, epicId, storyId, blockerId } = await seedLinkedTrio('SRE');
    const blocker = await workItemsService.getWorkItem(blockerId, fx.ctx);
    const epic = await workItemsService.getWorkItem(epicId, fx.ctx);

    // A plan with NO proposals projects to the live tree unchanged, which is
    // exactly what this seam needs: the verdict must match the committed one,
    // and it is computed from the SAME blocker edges plus `findDescriptionsByIds`
    // for the prose cross-check — the only consumer of either outside
    // `workItemsService`.
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);

    const verdict = await planValidityService.validateProjectedWorkItem(
      plan.id,
      epic.identifier,
      fx.ctx,
    );

    expect(verdict.valid).toBe(false);
    expect(verdict.blockers.map((b) => b.blockedBy)).toContain(blocker.identifier);
    expect(storyId).toBeTruthy();
  });
});

// ── Shared read 4 · workItemLinkRepository.findByFromItem ─────────────────────

describe('workItemLinkRepository.findByFromItem — the OUT edge, per consumer', () => {
  it('workItemsService: the OUT edge is readable back through getLink', async () => {
    const { fx, storyId, blockerId } = await seedLinkedTrio('SR8');
    const link = await workItemsService.linkWorkItems(
      { fromId: storyId, toId: blockerId, kind: 'relates_to' },
      fx.ctx,
    );

    const readBack = await workItemsService.getLink(link.id, fx.ctx);
    expect(readBack.toId).toBe(blockerId);
  });

  it('workItemsService.validateWorkItem: the advisory sees the DECLARED dependency', async () => {
    const { fx, epicId, storyId, blockerId } = await seedLinkedTrio('SR9');
    // A prose reference to the blocker, cross-checked against the DECLARED
    // edges by `buildProseVsGraphAdvisories` — the shipped consumer of the OUT
    // edge in that path. The edge EXISTS, so no `undeclared` advisory is owed;
    // unbound, the edge read came back empty and the advisory fired on a
    // dependency the plan had already declared.
    await workItemsService.updateWorkItem(
      storyId,
      { descriptionMd: `Depends on motir:${blockerId} to land first.` },
      fx.ctx,
    );

    const epic = await workItemsService.getWorkItem(epicId, fx.ctx);
    const blocker = await workItemsService.getWorkItem(blockerId, fx.ctx);
    const verdict = await workItemsService.validateWorkItem(fx.projectId, epic.identifier, fx.ctx);

    // `referenced` names the far end. The edge is DECLARED, so the reference
    // must not be reported as one the graph is missing.
    const named = verdict.advisories
      .filter((a): a is Extract<typeof a, { referenced: string }> => 'referenced' in a)
      .map((a) => a.referenced);
    expect(named).not.toContain(blocker.identifier);
  });
});

// ── Shared read 5 · labelRepository.findByIds ─────────────────────────────────

describe('labelRepository.findByIds — labelsService and workItemsService agree', () => {
  it('labelsService.resolveByIds returns the seeded label', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SRA' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Tagged' },
      fx.ctx,
    );
    const [label] = await labelsService.addLabel(item.id, 'urgent', fx.ctx);

    const resolved = await labelsService.resolveByIds(fx.projectIdentifier, [label!.id], fx.ctx);

    expect(resolved.map((l) => l.name)).toEqual(['urgent']);
  });

  it('workItemsService: the item detail carries the same label', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SRB' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Tagged' },
      fx.ctx,
    );
    await labelsService.addLabel(item.id, 'urgent', fx.ctx);

    const detail = await workItemsService.getIssueDetail(fx.projectId, item.identifier, fx.ctx);

    expect(detail.labels.map((l) => l.name)).toEqual(['urgent']);
  });
});

// ── Nested-transaction safety, in BOTH directions ────────────────────────────

describe('nested-transaction safety — and what nesting ACTUALLY does', () => {
  it('a read GIVEN a tx runs on it and sees that transaction’s own writes', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'NT1' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Inside' },
      fx.ctx,
    );

    const seen = await withWorkspaceServiceContext(fx.workspaceId, async (tx) => {
      await tx.workItem.update({ where: { id: item.id }, data: { title: 'Renamed inside' } });
      return workItemRepository.findById(item.id, tx);
    });

    // The load-bearing half: the read is ON the caller's transaction, so it sees
    // the uncommitted write. A read that ignored its `tx` would return the
    // pre-transaction title instead — see the case below for why that is the
    // failure mode rather than an exception.
    expect(seen?.title).toBe('Renamed inside');
  });

  it('⚠️ nesting does NOT throw — it opens a SECOND connection on a STALE snapshot', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'NT2' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Committed' },
      fx.ctx,
    );

    // MEASURED, because the obvious assumption is wrong and the whole
    // `tx ? read(…, tx) : withXContext(…)` convention rests on which way it goes.
    // Prisma does NOT reject an interactive transaction opened inside another —
    // it silently runs it on a DIFFERENT connection. So a helper that "binds for
    // itself" while its caller holds a transaction does not fail loudly; it
    // succeeds and reads the caller's PRE-transaction state.
    //
    // That is worse than an exception, and it is the second half of the argument
    // for threading `tx`: the first half is RLS (an unbound read sees nothing),
    // this half is ISOLATION (a separately-bound read sees the wrong thing). A
    // gate reading stale rows admits a decision the transaction has already
    // invalidated — and a row the caller CREATED in that transaction is invisible
    // entirely, which is exactly what `backlogService.bulkAssignToSprint`'s
    // comment describes for a sprint created and assigned into in one go.
    let innerTitle: string | null = null;
    // The OUTER transaction is a BOUND one — a bare `db.$transaction` here would
    // bind no GUCs and its own UPDATE would match nothing under `motir_app`,
    // which would make this case fail for the wrong reason.
    await withWorkspaceServiceContext(fx.workspaceId, async (tx) => {
      await tx.workItem.update({ where: { id: item.id }, data: { title: 'Renamed inside' } });
      const inner = await withWorkspaceServiceContext(fx.workspaceId, (t) =>
        workItemRepository.findById(item.id, t),
      );
      innerTitle = inner?.title ?? null;
    });

    // Not null — so it did not throw, and it was not blind. It was STALE.
    expect(innerTitle).toBe('Committed');
  });

  it('a read given NONE binds for itself rather than reading the singleton', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'NT3' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Standalone' },
      fx.ctx,
    );

    // Through the SERVICE, which takes no transaction from anyone — the shape
    // every route uses. Under `motir_app` this is the case that 404'd.
    const dto = await workItemsService.getWorkItem(item.id, fx.ctx);
    expect(dto.id).toBe(item.id);
  });

  it('a service method calling ANOTHER service does not enclose it', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'NT4' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Cross-service' },
      fx.ctx,
    );
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);

    // `backlogService.assignToSprint` gates through `projectAccessService` and
    // records a revision through `workItemRevisionsService`. The ADR's
    // call-into-another-service clause says the transaction ENDS at that call.
    // Given the finding above, the cost of getting this wrong is NOT a crash —
    // it is a callee silently reading state the caller has already changed. So
    // the assertion is on the OUTCOME: the move is committed and readable back.
    const moved = await backlogService.assignToSprint(item.id, sprint.id, undefined, fx.ctx);
    expect(moved.sprintId).toBe(sprint.id);

    const readBack = await workItemsService.getWorkItem(item.id, fx.ctx);
    expect(readBack.sprintId).toBe(sprint.id);
  });
});

// ── The margin the ADR rests on ──────────────────────────────────────────────

describe('the report path stays inside Prisma’s DEFAULT transaction budget', () => {
  it('a burndown over a realistic sprint finishes well inside 5 s', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'BUD' });
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Loaded' }, fx.ctx);
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const item = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: `Item ${i}` },
        fx.ctx,
      );
      ids.push(item.id);
    }
    await adminDb.workItem.updateMany({
      where: { id: { in: ids } },
      data: { sprintId: sprint.id, storyPoints: 3 },
    });
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    const started = process.hrtime.bigint();
    const graph = await reportsService.getSprintCycleGraph(sprint.id, fx.ctx);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // The read must actually have read something — a 0 ms empty answer would
    // satisfy any timing bound.
    expect(graph.days.length).toBeGreaterThan(0);
    expect(graph.committedAtStart).toBeGreaterThan(0);

    // ⚠️ A CEILING, not a benchmark. MOTIR-2799 measured 117.9 ms p50 against
    // Prisma's 5 s default and ruled out a `TransactionBudget` on that 38×
    // margin. This asserts the margin still EXISTS — it is deliberately loose
    // (a shared CI runner is not a measurement rig), because its job is to fail
    // when the shape regresses into something that needs the budget after all,
    // not to police milliseconds.
    expect(elapsedMs).toBeLessThan(2_500);
  });
});
