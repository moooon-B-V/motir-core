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

    expectFallbackAnswer(await attachmentRepository.listByWorkItem(itemId, {}), 1);
    expectFallbackCount(await attachmentRepository.countByWorkItem(itemId), 1);
    expectFallbackAnswer(
      await attachmentRepository.findManyByIds(fx.workspaceId, [attachment.id]),
      1,
    );

    const one = await attachmentRepository.findById(attachment.id);
    if (isAppRoleTestMode()) expect(one).toBeNull();
    else expect(one?.id).toBe(attachment.id);
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

describe('workItemRepository — the filter guard the coverage sweep surfaced', () => {
  it('REFUSES a text operator on a non-text field with a typed error', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FA7' });

    // A repository is a LEAF that trusts its caller: `validateFilterAst` rejects
    // this shape before any route reaches the repository, so the guard looks
    // unreachable — and is not, from the repository's own surface. It matters
    // because the alternative to throwing is emitting SQL for an operator the
    // column cannot support.
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
