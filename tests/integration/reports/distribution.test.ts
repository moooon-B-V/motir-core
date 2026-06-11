import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { UnknownStatisticTypeError } from '@/lib/reports/errors';
import { BUILTIN_STATISTIC_TYPES, customFieldStatisticId } from '@/lib/reports/statisticTypes';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { DistributionDto } from '@/lib/dto/reports';

// Story 6.3 · Subtask 6.3.2 — reportsService.getDistribution. Real Postgres.
// Asserts the STATISTIC MATRIX driven FROM the registry (the totality-guard
// pattern: every `BUILTIN_STATISTIC_TYPES` entry runs through the live
// group-by — a registry entry the repository switch can't compile fails
// here — plus the dynamic select/user cf entries), the None segment, the
// multi-label multi-count rule, percentages summing to 100 ± rounding, the
// saved-filter scope, and the typed 422 vs STALE statistic split. The
// permission matrix lives in widget-gating.test.ts.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function expectOk(
  promise: ReturnType<typeof reportsService.getDistribution>,
): Promise<DistributionDto> {
  const result = await promise;
  expect(result.state).toBe('ok');
  if (result.state !== 'ok') throw new Error('unreachable');
  return result.data;
}

function segment(data: DistributionDto, id: string | null) {
  return data.segments.find((s) => s.id === id);
}

/** Three tasks: two assigned to the owner / high priority / in a sprint /
 * labelled+component'd+cf-valued; one bare (the None bucket everywhere). */
async function seedSpread(fx: WorkItemFixture) {
  const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
  const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
  const bare = await createTestWorkItem(fx, { kind: 'bug', title: 'bare' });
  const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx);
  await db.workItem.update({
    where: { id: a.id },
    data: { assigneeId: fx.ownerId, priority: 'high', sprintId: sprint.id, status: 'done' },
  });
  await db.workItem.update({
    where: { id: b.id },
    data: { assigneeId: fx.ownerId, priority: 'high', sprintId: sprint.id },
  });
  return { a, b, bare, sprint };
}

describe('getDistribution — the statistic matrix (registry-driven)', () => {
  it('every builtin registry entry compiles and aggregates (the totality guard)', async () => {
    const fx = await makeWorkItemFixture();
    await seedSpread(fx);
    for (const def of BUILTIN_STATISTIC_TYPES) {
      const data = await expectOk(
        reportsService.getDistribution({ projectId: fx.projectId }, def.id, fx.ctx),
      );
      expect(data.statistic).toBe(def.id);
      expect(data.total).toBeGreaterThanOrEqual(3); // every strategy sees all 3 items
      const sum = data.segments.reduce((s, x) => s + x.percentage, 0);
      expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.5); // 100 ± rounding
    }
  });

  it('kind/priority segment ids self-describe (label null); status/assignee/sprint label through their referents', async () => {
    const fx = await makeWorkItemFixture();
    const { sprint } = await seedSpread(fx);

    const byKind = await expectOk(
      reportsService.getDistribution({ projectId: fx.projectId }, 'kind', fx.ctx),
    );
    expect(segment(byKind, 'task')).toMatchObject({ count: 2, label: null });
    expect(segment(byKind, 'bug')).toMatchObject({ count: 1 });

    const byStatus = await expectOk(
      reportsService.getDistribution({ projectId: fx.projectId }, 'status', fx.ctx),
    );
    const statuses = await workflowsRepository.findStatuses(fx.projectId, fx.workspaceId);
    const done = statuses.find((s) => s.key === 'done')!;
    expect(segment(byStatus, 'done')).toMatchObject({ count: 1, label: done.label });

    const byAssignee = await expectOk(
      reportsService.getDistribution({ projectId: fx.projectId }, 'assignee', fx.ctx),
    );
    expect(segment(byAssignee, fx.ownerId)).toMatchObject({ count: 2, label: fx.owner.name });
    expect(segment(byAssignee, null)).toMatchObject({ count: 1 }); // the None segment

    const bySprint = await expectOk(
      reportsService.getDistribution({ projectId: fx.projectId }, 'sprint', fx.ctx),
    );
    expect(segment(bySprint, sprint.id)).toMatchObject({ count: 2, label: 'S1' });
    expect(segment(bySprint, null)).toMatchObject({ count: 1 });
  });

  it('label multi-counts (an item appears once per label — the verified Jira rule) and percentages stay over the segment total', async () => {
    const fx = await makeWorkItemFixture();
    const { a, b } = await seedSpread(fx);
    const l1 = await db.label.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'urgent',
        nameLower: 'urgent',
      },
    });
    const l2 = await db.label.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'infra',
        nameLower: 'infra',
      },
    });
    await db.workItemLabel.createMany({
      data: [
        { workItemId: a.id, labelId: l1.id },
        { workItemId: a.id, labelId: l2.id }, // A carries BOTH labels
        { workItemId: b.id, labelId: l1.id },
      ],
    });

    const data = await expectOk(
      reportsService.getDistribution({ projectId: fx.projectId }, 'label', fx.ctx),
    );
    expect(segment(data, l1.id)).toMatchObject({ count: 2, label: 'urgent' });
    expect(segment(data, l2.id)).toMatchObject({ count: 1, label: 'infra' });
    expect(segment(data, null)).toMatchObject({ count: 1 }); // bare has no labels
    expect(data.total).toBe(4); // the segment-count total — the % denominator
    expect(segment(data, l1.id)!.percentage).toBe(50);
    // Count-descending order.
    expect(data.segments[0]!.count).toBe(2);
  });

  it('component groups through the 5.4.1 join', async () => {
    const fx = await makeWorkItemFixture();
    const { a } = await seedSpread(fx);
    const cmp = await db.component.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'API',
        nameLower: 'api',
      },
    });
    await db.workItemComponent.create({ data: { workItemId: a.id, componentId: cmp.id } });

    const data = await expectOk(
      reportsService.getDistribution({ projectId: fx.projectId }, 'component', fx.ctx),
    );
    expect(segment(data, cmp.id)).toMatchObject({ count: 1, label: 'API' });
    expect(segment(data, null)).toMatchObject({ count: 2 });
  });

  it('select and user custom fields group via the 5.3.1 probe (the dynamic registry entries)', async () => {
    const fx = await makeWorkItemFixture();
    const { a, b } = await seedSpread(fx);

    const selectField = await db.customFieldDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'env',
        label: 'Environment',
        fieldType: 'select',
        position: 'a',
      },
    });
    const opt = await db.customFieldOption.create({
      data: { fieldId: selectField.id, label: 'Production', position: 'a' },
    });
    await db.customFieldValue.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: a.id,
        fieldId: selectField.id,
        valueOptionId: opt.id,
      },
    });

    const bySelect = await expectOk(
      reportsService.getDistribution(
        { projectId: fx.projectId },
        customFieldStatisticId(selectField.id),
        fx.ctx,
      ),
    );
    expect(segment(bySelect, opt.id)).toMatchObject({ count: 1, label: 'Production' });
    expect(segment(bySelect, null)).toMatchObject({ count: 2 }); // no value row → None

    const userField = await db.customFieldDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'qa',
        label: 'QA owner',
        fieldType: 'user',
        position: 'b',
      },
    });
    await db.customFieldValue.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: b.id,
        fieldId: userField.id,
        valueUserId: fx.ownerId,
      },
    });

    const byUser = await expectOk(
      reportsService.getDistribution(
        { projectId: fx.projectId },
        customFieldStatisticId(userField.id),
        fx.ctx,
      ),
    );
    expect(segment(byUser, fx.ownerId)).toMatchObject({ count: 1, label: fx.owner.name });
    expect(segment(byUser, null)).toMatchObject({ count: 2 });
  });

  it('an empty scope is { total: 0, segments aggregate to nothing } — never NaN', async () => {
    const fx = await makeWorkItemFixture();
    const data = await expectOk(
      reportsService.getDistribution({ projectId: fx.projectId }, 'kind', fx.ctx),
    );
    expect(data.total).toBe(0);
    expect(data.segments).toEqual([]);
  });
});

describe('getDistribution — scope + the 422/stale statistic split', () => {
  it('a saved-filter scope narrows the GROUP-BY through the compiled AST', async () => {
    const fx = await makeWorkItemFixture();
    await seedSpread(fx); // 2 high-priority tasks + 1 bare bug
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high'] }],
    };
    const filter = await savedFiltersService.create(
      fx.projectIdentifier,
      { name: 'High', visibility: 'project', filterParam: encodeFilterParam(ast) },
      fx.ctx,
    );
    const data = await expectOk(
      reportsService.getDistribution({ savedFilterId: filter.id }, 'kind', fx.ctx),
    );
    expect(data.total).toBe(2);
    expect(segment(data, 'task')).toMatchObject({ count: 2 });
    expect(segment(data, 'bug')).toBeUndefined();
  });

  it('an unknown statistic id is the typed 422; a non-enum-ish custom field too', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      reportsService.getDistribution({ projectId: fx.projectId }, 'bogus', fx.ctx),
    ).rejects.toThrow(UnknownStatisticTypeError);

    const textField = await db.customFieldDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'notes',
        label: 'Notes',
        fieldType: 'text',
        position: 'a',
      },
    });
    await expect(
      reportsService.getDistribution(
        { projectId: fx.projectId },
        customFieldStatisticId(textField.id),
        fx.ctx,
      ),
    ).rejects.toThrow(UnknownStatisticTypeError);
  });

  it('a deleted (or out-of-project) cf statistic is the typed STALE state, not an error', async () => {
    const fx = await makeWorkItemFixture();
    expect(
      await reportsService.getDistribution(
        { projectId: fx.projectId },
        customFieldStatisticId('cmexists0000000000000nope'),
        fx.ctx,
      ),
    ).toEqual({ state: 'stale', reason: 'statistic_missing' });

    // A field on ANOTHER project is indistinguishable from deleted for this scope.
    const other = await makeWorkItemFixture({ identifier: 'OTHX', name: 'Other' });
    const foreign = await db.customFieldDefinition.create({
      data: {
        workspaceId: other.workspaceId,
        projectId: other.projectId,
        key: 'sev',
        label: 'Severity',
        fieldType: 'select',
        position: 'a',
      },
    });
    expect(
      await reportsService.getDistribution(
        { projectId: fx.projectId },
        customFieldStatisticId(foreign.id),
        fx.ctx,
      ),
    ).toEqual({ state: 'stale', reason: 'statistic_missing' });
  });
});
