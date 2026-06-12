import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { AutomationExecutionStatus } from '@prisma/client';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { automationRuleExecutionRepository } from '@/lib/repositories/automationRuleExecutionRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { NotProjectAdminError } from '@/lib/projects/errors';
import { AutomationRuleNotFoundError } from '@/lib/automation/errors';
import { AUTOMATION_EXECUTIONS_PAGE_SIZE } from '@/lib/services/automationRulesService';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Read-side tests for the automation audit log (Story 6.6 · Subtask 6.6.6):
// `automationRulesService.listExecutions` (the per-rule paged history) +
// `list`'s `lastRun` attach (the list's last-run glyph). Real Postgres, no DB
// mocks; truncateAuthTables CASCADEs workspace → … → automation_rule →
// automation_rule_execution between tests. Covers: bounded + correct pagination
// (page / total / pageSize, ordering desc by createdAt), each status maps, the
// triggering-item join + the tombstone (since-deleted item → null triggerItem),
// the admin gate (non-admin → denied / cross-project → 404), and the latest-per
// -rule last-run attach. Only the fields 6.6.2 persisted cross the wire — the
// richer per-step action detail the 6.6.4 mock drew is intentionally absent.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Create an automation rule directly (the engine writes executions against it;
 * this read suite doesn't exercise the create path — the service tests own it).
 * Returns the rule id. */
async function seedRule(fx: WorkItemFixture, name = 'Rule'): Promise<string> {
  const row = await db.automationRule.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      ownerId: fx.ownerId,
      name,
      enabled: true,
      triggerType: 'created',
      triggerConfig: { type: 'created' },
      conditionAst: { v: 'v1', c: 'and', f: [] },
      actions: [{ type: 'set_field', field: 'priority', value: 'low' }],
    },
  });
  return row.id;
}

/** Insert an execution row, optionally back-dating createdAt so ordering is
 * deterministic. */
async function seedExecution(
  ruleId: string,
  opts: {
    status: AutomationExecutionStatus;
    workItemId?: string | null;
    error?: string | null;
    durationMs?: number | null;
    createdAt?: Date;
  },
): Promise<string> {
  const row = await db.automationRuleExecution.create({
    data: {
      ruleId,
      status: opts.status,
      workItemId: opts.workItemId ?? null,
      error: opts.error ?? null,
      durationMs: opts.durationMs ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  return row.id;
}

describe('listExecutions — pagination + status mapping', () => {
  it('returns one bounded page newest-first with the true total, and each status maps', async () => {
    const fx = await makeWorkItemFixture();
    const ruleId = await seedRule(fx);

    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Trigger item' });

    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    // Three terminal statuses, ascending createdAt — newest is the failure.
    await seedExecution(ruleId, {
      status: 'success',
      workItemId: item.id,
      durationMs: 312,
      createdAt: new Date(base),
    });
    await seedExecution(ruleId, {
      status: 'no_actions',
      workItemId: item.id,
      durationMs: 9,
      createdAt: new Date(base + 1000),
    });
    const failId = await seedExecution(ruleId, {
      status: 'failure',
      workItemId: item.id,
      error: 'WorkflowTransitionIllegalError: "In Review" is not allowed from "Done"',
      durationMs: 88,
      createdAt: new Date(base + 2000),
    });

    const page = await automationRulesService.listExecutions(
      fx.projectIdentifier,
      ruleId,
      { page: 1 },
      fx.ctx,
    );

    expect(page.total).toBe(3);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(AUTOMATION_EXECUTIONS_PAGE_SIZE);
    // Newest-first: failure, no_actions, success.
    expect(page.executions.map((e) => e.status)).toEqual(['failure', 'no_actions', 'success']);

    const failure = page.executions[0]!;
    expect(failure.id).toBe(failId);
    expect(failure.error).toContain('WorkflowTransitionIllegalError');
    expect(failure.durationMs).toBe(88);
    expect(failure.triggerItem).toEqual({ key: item.identifier, title: 'Trigger item' });

    const noActions = page.executions[1]!;
    expect(noActions.error).toBeNull();
    expect(noActions.durationMs).toBe(9);
  });

  it('paginates with a fixed page size (bounded — no load-all): page 2 holds the overflow', async () => {
    const fx = await makeWorkItemFixture();
    const ruleId = await seedRule(fx);

    const total = AUTOMATION_EXECUTIONS_PAGE_SIZE + 3;
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let i = 0; i < total; i++) {
      // createdAt ascending in i, so i=total-1 is newest (first on page 1).
      await seedExecution(ruleId, { status: 'success', createdAt: new Date(base + i * 1000) });
    }

    const page1 = await automationRulesService.listExecutions(
      fx.projectIdentifier,
      ruleId,
      { page: 1 },
      fx.ctx,
    );
    expect(page1.total).toBe(total);
    expect(page1.executions).toHaveLength(AUTOMATION_EXECUTIONS_PAGE_SIZE);

    const page2 = await automationRulesService.listExecutions(
      fx.projectIdentifier,
      ruleId,
      { page: 2 },
      fx.ctx,
    );
    expect(page2.page).toBe(2);
    expect(page2.total).toBe(total);
    expect(page2.executions).toHaveLength(3);

    // No id appears on both pages (the take/skip window is correct).
    const ids1 = new Set(page1.executions.map((e) => e.id));
    expect(page2.executions.some((e) => ids1.has(e.id))).toBe(false);
  });

  it('an out-of-range page returns empty with the true total', async () => {
    const fx = await makeWorkItemFixture();
    const ruleId = await seedRule(fx);
    await seedExecution(ruleId, { status: 'success' });

    const page = await automationRulesService.listExecutions(
      fx.projectIdentifier,
      ruleId,
      { page: 99 },
      fx.ctx,
    );
    expect(page.total).toBe(1);
    expect(page.executions).toHaveLength(0);
  });

  it('a non-positive / non-finite page coerces to page 1', async () => {
    const fx = await makeWorkItemFixture();
    const ruleId = await seedRule(fx);
    await seedExecution(ruleId, { status: 'success' });

    for (const bad of [0, -3, Number.NaN]) {
      const page = await automationRulesService.listExecutions(
        fx.projectIdentifier,
        ruleId,
        { page: bad },
        fx.ctx,
      );
      expect(page.page).toBe(1);
      expect(page.executions).toHaveLength(1);
    }
  });
});

describe('listExecutions — tombstone (since-deleted triggering item)', () => {
  it('renders triggerItem = null when the work item was deleted after the run', async () => {
    const fx = await makeWorkItemFixture();
    const ruleId = await seedRule(fx);

    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Doomed' });
    await seedExecution(ruleId, { status: 'success', workItemId: item.id, durationMs: 270 });

    // Delete the item — the FK is SetNull, so the execution row survives with a
    // null work_item_id (the key is unrecoverable → the UI renders a tombstone).
    await db.workItem.delete({ where: { id: item.id } });

    const page = await automationRulesService.listExecutions(
      fx.projectIdentifier,
      ruleId,
      { page: 1 },
      fx.ctx,
    );
    expect(page.executions).toHaveLength(1);
    expect(page.executions[0]!.triggerItem).toBeNull();
    // The rest of the row is intact.
    expect(page.executions[0]!.durationMs).toBe(270);
    expect(page.executions[0]!.status).toBe('success');
  });
});

describe('listExecutions — admin gate + cross-tenant hide', () => {
  it('a non-admin project member is denied (the whole surface is admin-only)', async () => {
    const fx = await makeWorkItemFixture();
    const ruleId = await seedRule(fx);

    // A workspace member added to the project as a plain member (not admin).
    const member = await usersService.createUser({
      email: 'member-exec@example.com',
      password: 'hunter2hunter2',
      name: 'Member',
    });
    await workspacesService.addMember({
      userId: member.id,
      workspaceId: fx.workspaceId,
      role: 'member',
    });
    await projectMembersService.addMember({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: member.id,
      role: 'member',
    });

    await expect(
      automationRulesService.listExecutions(
        fx.projectIdentifier,
        ruleId,
        { page: 1 },
        { userId: member.id, workspaceId: fx.workspaceId },
      ),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
  });

  it('a rule not owned by the project key reads 404 (no cross-project leak)', async () => {
    const fx = await makeWorkItemFixture();
    const ruleId = await seedRule(fx);

    // A second project in the same workspace; the rule belongs to the first.
    const other = await makeWorkItemFixture({ name: 'Other WS', identifier: 'OTHR' });
    // Use the first fixture's admin against the other project's key.
    await expect(
      automationRulesService.listExecutions(
        other.projectIdentifier,
        ruleId,
        { page: 1 },
        other.ctx,
      ),
    ).rejects.toBeInstanceOf(AutomationRuleNotFoundError);
  });
});

describe('list — lastRun attach (latest per rule)', () => {
  it('attaches the most-recent execution status + time per rule, null when never run', async () => {
    const fx = await makeWorkItemFixture();
    const ranRuleId = await seedRule(fx, 'Has runs');
    const neverRuleId = await seedRule(fx, 'Never run');

    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    await seedExecution(ranRuleId, { status: 'success', createdAt: new Date(base) });
    await seedExecution(ranRuleId, { status: 'failure', createdAt: new Date(base + 5000) });
    // An older success — must NOT win over the newer failure.
    await seedExecution(ranRuleId, { status: 'no_actions', createdAt: new Date(base + 2000) });

    const rules = await automationRulesService.list(fx.projectIdentifier, fx.ctx);
    const ran = rules.find((r) => r.id === ranRuleId)!;
    const never = rules.find((r) => r.id === neverRuleId)!;

    expect(ran.lastRun).not.toBeNull();
    expect(ran.lastRun!.status).toBe('failure');
    expect(ran.lastRun!.at).toBe(new Date(base + 5000).toISOString());
    expect(never.lastRun).toBeNull();
  });
});

describe('automationRuleExecutionRepository — direct', () => {
  it('findLatestByRuleIds short-circuits empty input to []', async () => {
    expect(await automationRuleExecutionRepository.findLatestByRuleIds([])).toEqual([]);
  });

  it('listByRule joins the work item identifier + title', async () => {
    const fx = await makeWorkItemFixture();
    const ruleId = await seedRule(fx);
    const item = await createTestWorkItem(fx, { kind: 'bug', title: 'Joined' });
    await seedExecution(ruleId, { status: 'success', workItemId: item.id });

    const rows = await automationRuleExecutionRepository.listByRule(ruleId, { skip: 0, take: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workItem).toEqual({ identifier: item.identifier, title: 'Joined' });
    expect(await automationRuleExecutionRepository.countByRule(ruleId)).toBe(1);
  });
});
