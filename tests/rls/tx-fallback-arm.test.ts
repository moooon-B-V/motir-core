import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { automationRuleExecutionRepository } from '@/lib/repositories/automationRuleExecutionRepository';
import { automationRuleRepository } from '@/lib/repositories/automationRuleRepository';
import { customFieldDefinitionRepository } from '@/lib/repositories/customFieldDefinitionRepository';
import { dashboardRepository } from '@/lib/repositories/dashboardRepository';
import { dashboardWidgetRepository } from '@/lib/repositories/dashboardWidgetRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { customFieldOptionRepository } from '@/lib/repositories/customFieldOptionRepository';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { codeGraphOffboardingRepository } from '@/lib/repositories/codeGraphOffboardingRepository';
import { ciPeriodChargeRepository } from '@/lib/repositories/ciPeriodChargeRepository';
import { sprintsService } from '@/lib/services/sprintsService';
import { savedFilterRepository } from '@/lib/repositories/savedFilterRepository';
import { savedFilterSubscriptionRepository } from '@/lib/repositories/savedFilterSubscriptionRepository';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { savedFilterSubscriptionsService } from '@/lib/services/savedFilterSubscriptionsService';
import { encodeFilterParam } from '@/lib/filters/ast';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { UnknownFilterOperatorError } from '@/lib/filters/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '@/tests/fixtures';
import { adminDb } from '../helpers/adminDb';
import { isAppRoleTestMode } from '../helpers/parallelDb';
import { truncateAuthTables } from '../helpers/db';

// The `tx ?? db` FALLBACK ARM (MOTIR-2815 part 1).
//
// Every read this story bound has two arms and the coverage gate counts both.
// Binding the production callers left the `db` one with NO caller at all, so it
// went uncovered and eight repositories dropped under the ≥90% branch floor —
// `workflowsRepository` to 75%, `automationRuleRepository` to 80%,
// `dashboardWidgetRepository` to 81%. The card predicted exactly this, and named
// the honest fix: exercise the arm deliberately rather than lower the floor.
//
// ⚠️ WHAT THE ARM IS FOR, AND WHY THE ASSERTION IS PER-ROLE. The fallback is not
// dead code to be deleted — it is what a repository does when nobody has bound a
// transaction, and the whole point of this story is that the ANSWER in that state
// is wrong. So the assertion is the one MOTIR-2805 established, and it is
// deliberately opposite in the two modes:
//
//   under the dev/CI BYPASSRLS owner  → the rows come back (RLS is inert)
//   under `motir_app`                 → the answer is EMPTY, and that is CORRECT
//
// Asserting rows under the app role here would be asserting that a path with no
// binding somehow works — the exact false claim the story exists to remove. And
// asserting emptiness under BOTH would pass vacuously on a broken fixture. Hence
// `isAppRoleTestMode()`: this is the one file where the two roles genuinely owe
// different answers, unlike `app-role-bound-context-reads.test.ts`, where the
// bound path owes the SAME answer in both and is therefore ungated.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Rows under the owner; nothing under `motir_app`. The whole contract, once. */
function expectFallbackAnswer<T>(rows: T[], seededAtLeast: number): void {
  if (isAppRoleTestMode()) {
    expect(
      rows,
      'an UNBOUND read must come back empty under `motir_app` — if it returns rows, ' +
        'the policy is not gating this table and the verdict list is wrong about it',
    ).toEqual([]);
  } else {
    expect(rows.length).toBeGreaterThanOrEqual(seededAtLeast);
  }
}

/** …and the scalar form, for the counts. */
function expectFallbackCount(value: number, seeded: number): void {
  if (isAppRoleTestMode()) expect(value).toBe(0);
  else expect(value).toBe(seeded);
}

/** A trivially-valid stored filter — the criteria are not what these cases test. */
const KIND_TASK_FILTER_PARAM = encodeFilterParam({
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: ['task'] }],
});

async function seedItem(identifier: string): Promise<{ fx: WorkItemFixture; itemId: string }> {
  const fx = await makeWorkItemFixture({ identifier });
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Subject' },
    fx.ctx,
  );
  return { fx, itemId: item.id };
}

describe('workflowsRepository — the arm every workflow read now falls back to', () => {
  it('statuses, transitions and the by-key / by-id lookups, all unbound', async () => {
    const { fx } = await seedItem('FA1');

    const statuses = await workflowsRepository.findStatuses(fx.projectId, fx.workspaceId);
    expectFallbackAnswer(statuses, 3);

    const transitions = await workflowsRepository.findTransitions(fx.projectId, fx.workspaceId);
    expectFallbackAnswer(transitions, 1);

    const byProjects = await workflowsRepository.findStatusesByProjects(
      [fx.projectId],
      fx.workspaceId,
    );
    expectFallbackAnswer(byProjects, 3);

    const byKey = await workflowsRepository.findStatusByKey(fx.projectId, 'todo', fx.workspaceId);
    if (isAppRoleTestMode()) expect(byKey).toBeNull();
    else expect(byKey?.key).toBe('todo');

    // …and the id-keyed pair, which needs a real id to be worth anything: read it
    // through the OWNER so the lookup below is a genuine miss-or-hit rather than
    // a lookup of nothing.
    const seeded = await adminDb.workflowStatus.findFirst({ where: { projectId: fx.projectId } });
    const byId = await workflowsRepository.findStatusById(seeded!.id, fx.workspaceId);
    if (isAppRoleTestMode()) expect(byId).toBeNull();
    else expect(byId?.id).toBe(seeded!.id);

    const seededTransition = await adminDb.workflowTransition.findFirst({
      where: { projectId: fx.projectId },
    });
    const transition = await workflowsRepository.findTransitionById(
      seededTransition!.id,
      fx.workspaceId,
    );
    if (isAppRoleTestMode()) expect(transition).toBeNull();
    else expect(transition?.id).toBe(seededTransition!.id);

    const found = await workflowsRepository.findTransition(
      fx.projectId,
      seededTransition!.fromStatusId,
      seededTransition!.toStatusId,
      fx.workspaceId,
    );
    if (isAppRoleTestMode()) expect(found).toBeNull();
    else expect(found?.id).toBe(seededTransition!.id);
  });
});

describe('the remaining fallback arms this story left without a caller', () => {
  it('attachmentRepository — the item’s files, its count, and the id lookups', async () => {
    const { fx, itemId } = await seedItem('FA2');
    const attachment = await adminDb.attachment.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: itemId,
        uploaderUserId: fx.ownerId,
        blobPathname: `k/${itemId}`,
        originalFilename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 10,
      },
    });

    // Only the methods that still HAVE a fallback arm. `findById` and
    // `findManyByIds` now REQUIRE a `tx` (tightened on `main` while this branch
    // was open), which is the better end state — a required parameter cannot be
    // forgotten — and it removes them from this file's subject rather than
    // needing a case here.
    expectFallbackAnswer(await attachmentRepository.listByWorkItem(itemId, {}), 1);
    expectFallbackCount(await attachmentRepository.countByWorkItem(itemId), 1);
    expect(attachment.id).toBeTruthy();
  });

  it('customFieldDefinitionRepository — the project’s fields and one by id', async () => {
    const { fx, itemId } = await seedItem('FA3');
    const field = await adminDb.customFieldDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'team',
        label: 'Team',
        fieldType: 'text',
        position: 'a0',
      },
    });

    expectFallbackAnswer(
      await customFieldDefinitionRepository.listByProject(fx.projectId, fx.workspaceId),
      1,
    );
    expectFallbackCount(
      await customFieldDefinitionRepository.countByProject(fx.projectId, fx.workspaceId),
      1,
    );
    expectFallbackAnswer(
      await customFieldDefinitionRepository.listWithValuesForWorkItem(
        fx.projectId,
        fx.workspaceId,
        itemId,
      ),
      1,
    );

    const byId = await customFieldDefinitionRepository.findById(field.id, fx.workspaceId);
    if (isAppRoleTestMode()) expect(byId).toBeNull();
    else expect(byId?.id).toBe(field.id);
  });

  it('dashboardRepository + dashboardWidgetRepository — the grid and its widgets', async () => {
    const { fx } = await seedItem('FA4');
    const dashboard = await adminDb.dashboard.create({
      data: {
        workspaceId: fx.workspaceId,
        ownerId: fx.ownerId,
        name: 'Board',
        access: 'private',
        layout: 'two',
      },
    });
    const widget = await adminDb.dashboardWidget.create({
      data: {
        dashboardId: dashboard.id,
        type: 'distribution',
        column: 0,
        position: 'a0',
        config: {},
        projectId: fx.projectId,
      },
    });

    const row = await dashboardRepository.findByIdWithFacts(fx.workspaceId, dashboard.id);
    if (isAppRoleTestMode()) expect(row).toBeNull();
    else expect(row?.id).toBe(dashboard.id);

    expectFallbackAnswer(await dashboardRepository.listVisible(fx.workspaceId, fx.ownerId, 20), 1);
    expectFallbackAnswer(await dashboardWidgetRepository.listByDashboard(dashboard.id), 1);

    const named = await dashboardWidgetRepository.findByIdWithNames(dashboard.id, widget.id);
    if (isAppRoleTestMode()) expect(named).toBeNull();
    else expect(named?.id).toBe(widget.id);
  });

  it('automationRule + its executions — the rule list, and the audit trail', async () => {
    const { fx, itemId } = await seedItem('FA5');
    const rule = await adminDb.automationRule.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        ownerId: fx.ownerId,
        name: 'On create',
        triggerType: 'created',
        enabled: true,
        triggerConfig: {},
        conditionAst: {},
        actions: [],
      },
    });
    await adminDb.automationRuleExecution.create({
      data: {
        ruleId: rule.id,
        workItemId: itemId,
        eventId: 'evt-1',
        status: 'success',
      },
    });

    expectFallbackAnswer(await automationRuleRepository.listByProject(fx.projectId), 1);
    void itemId;
    expectFallbackAnswer(
      await automationRuleRepository.listEnabledByProjectAndTrigger(fx.projectId, 'created'),
      1,
    );

    const byId = await automationRuleRepository.findByIdInProject(rule.id, fx.projectId);
    if (isAppRoleTestMode()) expect(byId).toBeNull();
    else expect(byId?.id).toBe(rule.id);

    expectFallbackAnswer(
      await automationRuleExecutionRepository.listByRule(rule.id, { skip: 0, take: 10 }),
      1,
    );
    expectFallbackCount(await automationRuleExecutionRepository.countByRule(rule.id), 1);

    // The idempotency probe, and the one whose unbound answer is actively
    // dangerous rather than merely empty: `false` means "never ran", so a
    // replayed event re-applies every action.
    const already = await automationRuleExecutionRepository.existsByRuleAndEvent(rule.id, 'evt-1');
    expect(already).toBe(!isAppRoleTestMode());
  });
});

// ── The write-error translation the fallback sweep left uncovered ────────────

describe('workItemRepository.setStoryPoints — the P2025 translation', () => {
  it('turns a missing row into WorkItemNotFoundError rather than leaking Prisma', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FA6' });

    // Not a fallback arm — a defensive CATCH the coverage sweep surfaced beside
    // them, and the only branch of `setStoryPoints` no test reached. It is worth
    // covering rather than ignoring: a raw `PrismaClientKnownRequestError`
    // escaping the repository would reach a route as a 500 instead of the 404
    // the service contract promises.
    await expect(
      withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, (tx) =>
        workItemRepository.setStoryPoints('cl00000000000000000000000', 5, tx),
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('workItemRepository — an invalid operator never reaches the SQL compiler', () => {
  it('REFUSES a text operator on a non-text field with a typed error', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FA7' });

    // ⚠️ WHAT THIS DOES AND DOES NOT PROVE — corrected on the record, because the
    // first version of this comment was wrong in a way worth keeping visible.
    //
    // It asserts the CONTRACT: a repository handed a nonsense operator refuses it
    // with a typed error instead of compiling it into SQL a column cannot
    // support. That is real and worth holding.
    //
    // It does NOT reach `compileConditionSql`'s `case 'contains'` guard, which is
    // what it originally claimed. `resolveFilterAst` -> `validateResolvedCondition`
    // throws the SAME error class one layer earlier, so the assertion is satisfied
    // before the compiler runs. The repository branch is genuinely unreachable and
    // now carries a `v8 ignore` directive saying so.
    //
    // The general lesson, and the reason this is written out: an assertion on an
    // ERROR CLASS does not pin WHERE the error came from. CI's coverage report is
    // what caught it; the green test could not.
    await expect(
      workItemRepository.countProjectIssues(fx.projectId, fx.workspaceId, {
        ast: {
          combinator: 'and',
          conditions: [{ field: 'status', operator: 'contains', value: 'do' }],
        },
      }),
    ).rejects.toBeInstanceOf(UnknownFilterOperatorError);
  });
});

// ── Moved here from `app-role-bound-context-reads.test.ts` (MOTIR-2815) ──────
//
// It is the same subject as everything above — a deliberately UNBOUND read with
// a per-role assertion — and it was the only such case in a file whose whole job
// is BOUND reads. MOTIR-2797's test-call-site guard adjudicates at FILE level, so
// leaving it there would have meant exempting 46 bound assertions to excuse four
// unbound ones. Moving it lets that file stay fully guarded and puts this one
// where its adjudication is honest.

describe('the `tx ?? db` fallback arm of the saved-filter reads', () => {
  // ⚠️ DELIBERATELY UNBOUND, and both arms are asserted. The optional `tx` is what
  // `tests/rls/singletonReadScan.ts` recognises as BINDABLE, so it has to stay —
  // but once every production call site threads a `tx`, the `db` arm has no
  // caller left and would go uncovered against the file's ≥90% branch floor.
  //
  // The assertion is split by role rather than weakened, because the two answers
  // are BOTH the contract: on the bypass role the fallback reads normally; on
  // `motir_app` it binds nothing, the policy sees NULL, and the honest answer is
  // the EMPTY one. Asserting rows here would be asserting that a path with no
  // binding at all somehow works — the vacuous-pass shape this story exists to
  // remove.
  it('resolves to the singleton, and returns the empty answer under the app role', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SFE' });
    const filter = await savedFiltersService.create(
      fx.projectIdentifier,
      { name: 'Fallback', visibility: 'private', filterParam: KIND_TASK_FILTER_PARAM },
      fx.ctx,
    );
    await savedFilterSubscriptionsService.subscribe(
      fx.projectIdentifier,
      filter.id,
      { schedule: 'daily', hour: 9 },
      fx.ctx,
    );

    const listArgs = {
      projectId: fx.projectId,
      actorUserId: fx.ownerId,
      actorIsAdmin: true,
      view: 'all' as const,
    };
    const rows = await savedFilterRepository.listPage({ ...listArgs, take: 10 });
    const total = await savedFilterRepository.countVisible(listArgs);
    const subs = await savedFilterSubscriptionRepository.countByFilter(filter.id);

    if (isAppRoleTestMode()) {
      expect(rows).toEqual([]);
      expect(total).toBe(0);
      expect(subs).toBe(0);
    } else {
      expect(rows.map((r) => r.name)).toEqual(['Fallback']);
      expect(total).toBe(1);
      expect(subs).toBe(1);
    }
  });
});

// ── The arms MOTIR-2830 stranded ─────────────────────────────────────────────
//
// Binding the TEST call sites removed the last unbound caller from nine more
// repositories, and CI's merged coverage report caught what a single local run
// had not: `codeGraphOffboardingRepository` 50%, `planChangeTurnRepository` 50%,
// `workItemRevisionRepository` 75.6%, and six others under the ≥90% branch floor.
//
// The same argument as everything above, one sweep later: the fallback is not
// dead code, it is what a repository does when nobody bound a transaction, and
// the answer in that state is the thing this story is about. So it is exercised
// on purpose rather than deleted or excused.

describe('the fallback arms MOTIR-2830 left without a caller', () => {
  it('workItemLinkRepository — every edge read, unbound', async () => {
    const { fx, itemId } = await seedItem('FB1');
    const other = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Blocker' },
      fx.ctx,
    );
    const link = await workItemsService.linkWorkItems(
      { fromId: itemId, toId: other.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    expectFallbackAnswer(await workItemLinkRepository.findByFromItem(itemId), 1);
    expectFallbackAnswer(await workItemLinkRepository.findByToItem(other.id), 1);
    expectFallbackAnswer(await workItemLinkRepository.findBlockedByEdges([itemId]), 1);
    expectFallbackAnswer(await workItemLinkRepository.findBlockerStates(itemId), 1);
    expectFallbackAnswer(await workItemLinkRepository.findBlockerStatesForItems([itemId]), 1);
    expectFallbackAnswer(await workItemLinkRepository.findBlockerEdgesForItems([itemId]), 1);
    expectFallbackAnswer(await workItemLinkRepository.findBlockedEdgesForItems([other.id]), 1);
    expectFallbackAnswer(
      await workItemLinkRepository.findBlockerSessionBranchesForItems([itemId]),
      0,
    );

    const one = await workItemLinkRepository.findById(link.id);
    if (isAppRoleTestMode()) expect(one).toBeNull();
    else expect(one?.id).toBe(link.id);

    const between = await workItemLinkRepository.findAnyBetween(itemId, other.id);
    if (isAppRoleTestMode()) expect(between).toBeNull();
    else expect(between?.id).toBeTruthy();

    const reciprocal = await workItemLinkRepository.findReciprocal(
      itemId,
      other.id,
      'is_blocked_by',
    );
    if (isAppRoleTestMode()) expect(reciprocal).toBeNull();
    else expect(reciprocal?.id).toBe(link.id);
  });

  it('sprintRepository — the sprint lookups, unbound', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FB2' });
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Arm' }, fx.ctx);

    expectFallbackAnswer(await sprintRepository.listByProject(fx.projectId, fx.workspaceId), 1);
    expectFallbackAnswer(await sprintRepository.findByIds([sprint.id], fx.workspaceId), 1);
    expectFallbackAnswer(
      await sprintRepository.listCompletedByProject(fx.projectId, fx.workspaceId, 10),
      0,
    );
    expectFallbackCount(
      await sprintRepository.countByProjectAndState(fx.projectId, fx.workspaceId, 'planned'),
      1,
    );
    // `maxSequenceForProject` returns 0 for "nothing found", which is also the
    // unbound answer — so it is asserted only on the OWNER side, where a real
    // sequence proves the read ran. Under the app role the arm is still executed
    // (that is what the coverage floor needs) but there is nothing it can claim.
    const maxSeq = await sprintRepository.maxSequenceForProject(fx.projectId, fx.workspaceId);
    if (!isAppRoleTestMode()) expect(maxSeq).toBeGreaterThan(0);

    const byId = await sprintRepository.findById(sprint.id, fx.workspaceId);
    if (isAppRoleTestMode()) expect(byId).toBeNull();
    else expect(byId?.id).toBe(sprint.id);

    const active = await sprintRepository.findActiveByProject(fx.projectId, fx.workspaceId);
    expect(active).toBeNull(); // never started — null under BOTH roles
  });

  it('workItemRevisionRepository — the history and the aggregates, unbound', async () => {
    const { fx, itemId } = await seedItem('FB3');
    await workItemsService.updateWorkItem(itemId, { title: 'Renamed' }, fx.ctx);
    const window = {
      start: new Date(Date.now() - 24 * 60 * 60 * 1000),
      end: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };

    expectFallbackAnswer(await workItemRevisionRepository.listByWorkItem(itemId), 2);
    // TWO: the `created` revision and the rename. The NUMBER is what separates a
    // bound read from the unbound zero, so it is asserted rather than rounded to
    // "some".
    expectFallbackCount(await workItemRevisionRepository.countDisplayableByWorkItem(itemId, []), 2);
    expectFallbackAnswer(
      await workItemRevisionRepository.aggregateNetResolvedByBucket(
        fx.projectId,
        fx.workspaceId,
        'day',
        window,
      ),
      0,
    );
    expectFallbackAnswer(
      await workItemRevisionRepository.aggregateAverageAgeByBucket(fx.projectId, fx.workspaceId, [
        { key: 'now', end: window.end },
      ]),
      0,
    );
    expectFallbackAnswer(
      await workItemRevisionRepository.aggregateResolutionTimeByBucket(
        fx.projectId,
        fx.workspaceId,
        'day',
        window,
      ),
      0,
    );

    const latest = await workItemRevisionRepository.findLatestIdsByWorkItemIds([itemId]);
    if (isAppRoleTestMode()) expect(latest.size).toBe(0);
    else expect(latest.get(itemId)).toBeTruthy();

    const actor = await workItemRevisionRepository.findLatestArchivedActor(itemId);
    expect(actor).toBeNull(); // never archived — null under BOTH roles
  });

  it('customFieldOptionRepository — the option lookups, unbound', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FB4' });
    const field = await adminDb.customFieldDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'stage',
        label: 'Stage',
        fieldType: 'select',
        position: 'a0',
      },
    });
    const option = await adminDb.customFieldOption.create({
      data: { fieldId: field.id, label: 'Alpha', position: 'a0' },
    });

    expectFallbackAnswer(
      await customFieldOptionRepository.listByField(field.id, fx.workspaceId),
      1,
    );
    expectFallbackAnswer(
      await customFieldOptionRepository.listByProject(fx.projectId, fx.workspaceId),
      1,
    );
    expectFallbackAnswer(
      await customFieldOptionRepository.findByIds([option.id], fx.projectId, fx.workspaceId),
      1,
    );
    expectFallbackCount(
      await customFieldOptionRepository.countByField(field.id, fx.workspaceId),
      1,
    );

    const byId = await customFieldOptionRepository.findById(option.id, fx.workspaceId);
    if (isAppRoleTestMode()) expect(byId).toBeNull();
    else expect(byId?.id).toBe(option.id);
  });

  it('the plan-change conversation, the offboarding queue and the CI charge', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FB5' });
    const session = await adminDb.planChangeSession.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, scopeKey: 'project' },
    });
    await adminDb.planChangeTurn.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: session.id,
        seq: 1,
        role: 'user',
        body: 'hello',
      },
    });

    const found = await planChangeSessionRepository.findByProjectAndScope(
      fx.projectId,
      'project',
      fx.workspaceId,
    );
    if (isAppRoleTestMode()) expect(found).toBeNull();
    else expect(found?.id).toBe(session.id);

    expectFallbackAnswer(
      await planChangeTurnRepository.listBySessionId(session.id, fx.workspaceId),
      1,
    );

    // Two tables gated but NOT by `app.workspace_id`: the offboarding queue is a
    // system-context table, the CI charge is org-scoped. Their arms still need a
    // caller, and BOTH answer the same under either role here — nothing seeded,
    // so nothing to hide. The value is the branch, not the verdict.
    expectFallbackAnswer(
      await codeGraphOffboardingRepository.findByProject(fx.workspaceId, fx.projectId),
      0,
    );

    // ⚠️ Named in a comment on the first pass and never actually CALLED, which is
    // why CI kept reporting `ciPeriodChargeRepository` at 83.33%. A comment does
    // not execute a branch.
    const organizationId = await adminDb.workspace
      .findUniqueOrThrow({ where: { id: fx.workspaceId } })
      .then((w) => w.organizationId);
    const charge = await ciPeriodChargeRepository.findForPeriod(
      organizationId,
      new Date('2026-08-01T00:00:00.000Z'),
    );
    expect(charge).toBeNull(); // no row for that period, under either role
  });
});
