import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { automationEngineService } from '@/lib/services/automationEngineService';
import {
  automationRulesService,
  type AutomationRuleWriteInput,
} from '@/lib/services/automationRulesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { encodeFilterParam, type FilterAst, type FilterCondition } from '@/lib/filters/ast';
import { AUTOMATION_AUTO_DISABLE_THRESHOLD } from '@/lib/automation/constants';
import type { WorkItemFieldChangedData } from '@/lib/jobs/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';

// The automation EXECUTION ENGINE (Story 6.6 · Subtask 6.6.2). Real Postgres,
// no DB mocks; the one seam stubbed is the Inngest client's `send()`
// (captureJobEvents) — so seeding writes don't hit the network AND the
// provenance/email emits become assertable. Drives the engine service directly
// (the job handlers are a thin step.run wrapper over runForEvent), exercising
// the five invariants end to end against seeded data: loop prevention,
// conditions, actions-as-owner (transition + set_field, legal/illegal/stale),
// idempotency per (event × rule), and the failure ops (counter, auto-disable,
// first-failure email, reset). Plus the 90-day retention sweep. Automation
// configs speak status KEYS (the unit updateStatus + the transitioned event
// use).

let cap: { events: CapturedJobEvent[]; restore: () => void };

beforeEach(async () => {
  await truncateAuthTables();
  cap = captureJobEvents();
});

afterEach(() => {
  cap.restore();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeRule(
  fx: WorkItemFixture,
  overrides: Partial<AutomationRuleWriteInput>,
): Promise<{ id: string }> {
  const input: AutomationRuleWriteInput = {
    name: 'rule',
    triggerType: 'created',
    triggerConfig: {},
    conditionFilterParam: null,
    actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
    ...overrides,
  };
  return automationRulesService.create(fx.project.identifier, input, fx.ctx);
}

function conditionParam(conditions: FilterCondition[]): string {
  const ast: FilterAst = { combinator: 'and', conditions };
  return encodeFilterParam(ast);
}

async function newItem(fx: WorkItemFixture, kind: 'task' | 'bug' | 'story' = 'task', title = 'X') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind, title }, fx.ctx);
}

function executions(ruleId: string) {
  return db.automationRuleExecution.findMany({ where: { ruleId }, orderBy: { createdAt: 'asc' } });
}

function readItem(fx: WorkItemFixture, id: string) {
  return workItemsService.getWorkItem(id, fx.ctx);
}

let evtSeq = 0;
const created = (
  fx: WorkItemFixture,
  workItemId: string,
  overrides: Partial<Parameters<typeof automationEngineService.runForEvent>[0]> = {},
) =>
  automationEngineService.runForEvent({
    trigger: 'created',
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    workItemId,
    eventId: `evt-${(evtSeq += 1)}`,
    ...overrides,
  });

describe('loop prevention (invariant #1)', () => {
  it('an event carrying provenance is skipped — no rule loads, no audit row', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {});
    const item = await newItem(fx);

    const summary = await created(fx, item.id, { viaAutomationRuleId: rule.id });
    expect(summary.skipped).toBe(true);
    expect(summary.matched).toBe(0);
    expect(await executions(rule.id)).toHaveLength(0);
  });
});

describe('trigger matching + narrowing', () => {
  it('a created rule with no conditions runs its action and audits success', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
    });
    const item = await newItem(fx);

    const summary = await created(fx, item.id);
    expect(summary).toMatchObject({ matched: 1, succeeded: 1, failed: 0, noActions: 0 });

    const rows = await executions(rule.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('success');
    expect(rows[0]!.workItemId).toBe(item.id);
    expect((await readItem(fx, item.id)).priority).toBe('high');
  });

  it('a field_changed rule fires only when its field is among the changed fields', async () => {
    const fx = await makeWorkItemFixture();
    await makeRule(fx, {
      triggerType: 'field_changed',
      triggerConfig: { field: 'priority' },
      actions: [{ type: 'set_field', field: 'estimate', value: 60 }],
    });
    const item = await newItem(fx);
    const base = {
      trigger: 'field_changed' as const,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
    };

    const miss = await automationEngineService.runForEvent({
      ...base,
      eventId: 'fc-miss',
      changedFields: ['assignee'],
    });
    expect(miss.matched).toBe(0);

    const hit = await automationEngineService.runForEvent({
      ...base,
      eventId: 'fc-hit',
      changedFields: ['priority'],
    });
    expect(hit).toMatchObject({ matched: 1, succeeded: 1 });
    expect((await readItem(fx, item.id)).estimateMinutes).toBe(60);
  });

  it('a transitioned rule narrows by from/to status key', async () => {
    const fx = await makeWorkItemFixture();
    await makeRule(fx, {
      triggerType: 'transitioned',
      triggerConfig: { fromStatusId: 'todo', toStatusId: 'in_progress' },
      actions: [{ type: 'set_field', field: 'priority', value: 'highest' }],
    });
    const item = await newItem(fx);
    const base = {
      trigger: 'transitioned' as const,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
    };

    const wrong = await automationEngineService.runForEvent({
      ...base,
      eventId: 't-wrong',
      fromStatusKey: 'todo',
      toStatusKey: 'done',
    });
    expect(wrong.matched).toBe(0);

    const right = await automationEngineService.runForEvent({
      ...base,
      eventId: 't-right',
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
    });
    expect(right.matched).toBe(1);
    expect(right.succeeded).toBe(1);
  });
});

describe('conditions (invariant #2)', () => {
  it('gates the action — a non-matching item logs no_actions, a matching item succeeds', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      conditionFilterParam: conditionParam([
        { field: 'kind', operator: 'is_any_of', value: ['bug'] },
      ]),
      actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
    });

    const story = await newItem(fx, 'story', 'A story');
    const gated = await created(fx, story.id);
    expect(gated).toMatchObject({ matched: 1, noActions: 1, succeeded: 0 });
    expect((await executions(rule.id))[0]!.status).toBe('no_actions');
    expect((await readItem(fx, story.id)).priority).not.toBe('high');

    const bug = await newItem(fx, 'bug', 'A bug');
    const fired = await created(fx, bug.id);
    expect(fired.succeeded).toBe(1);
    expect((await readItem(fx, bug.id)).priority).toBe('high');
  });

  it('an empty condition group always passes', async () => {
    const fx = await makeWorkItemFixture();
    await makeRule(fx, { conditionFilterParam: null });
    const item = await newItem(fx);
    expect((await created(fx, item.id)).succeeded).toBe(1);
  });
});

describe('actions as owner (invariant #3)', () => {
  it('runs multiple actions in order, all attributed to the owner', async () => {
    const fx = await makeWorkItemFixture();
    await makeRule(fx, {
      actions: [
        { type: 'set_field', field: 'priority', value: 'high' },
        { type: 'transition', toStatusId: 'in_progress' },
      ],
    });
    const item = await newItem(fx);
    const summary = await created(fx, item.id);
    expect(summary.succeeded).toBe(1);

    const after = await readItem(fx, item.id);
    expect(after.priority).toBe('high');
    expect(after.status).toBe('in_progress');
  });

  it('a legal transition action moves the item; an illegal one is a recorded failure', async () => {
    const fx = await makeWorkItemFixture();
    // todo→done is NOT a legal default transition.
    const rule = await makeRule(fx, { actions: [{ type: 'transition', toStatusId: 'done' }] });
    const item = await newItem(fx); // born in 'todo'

    const summary = await created(fx, item.id);
    expect(summary.failed).toBe(1);
    const rows = await executions(rule.id);
    expect(rows[0]!.status).toBe('failure');
    expect(rows[0]!.error).toBeTruthy();
    expect((await readItem(fx, item.id)).status).toBe('todo'); // uncorrupted
  });

  it('a transition to an unknown status key is a recorded stale-referent failure', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      actions: [{ type: 'transition', toStatusId: 'status-that-does-not-exist' }],
    });
    const item = await newItem(fx);
    const summary = await created(fx, item.id);
    expect(summary.failed).toBe(1);
    expect((await executions(rule.id))[0]!.status).toBe('failure');
  });

  it('a set_field to a non-member assignee is a recorded failure, not a crash', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      actions: [{ type: 'set_field', field: 'assignee', value: 'user-not-in-workspace' }],
    });
    const item = await newItem(fx);
    const summary = await created(fx, item.id);
    expect(summary.failed).toBe(1);
    expect((await executions(rule.id))[0]!.status).toBe('failure');
  });

  it('stamps provenance on the event a set_field action emits (loop cannot form)', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      triggerType: 'field_changed',
      triggerConfig: { field: 'priority' },
      actions: [{ type: 'set_field', field: 'priority', value: 'highest' }],
    });
    const item = await newItem(fx);
    const from = cap.events.length;
    await automationEngineService.runForEvent({
      trigger: 'field_changed',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      eventId: 'loop-1',
      changedFields: ['priority'],
    });
    const emitted = cap.events
      .slice(from)
      .filter((e) => e.name === 'work-item/field.changed')
      .map((e) => e.data as WorkItemFieldChangedData);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.every((d) => d.viaAutomationRuleId === rule.id)).toBe(true);

    // Feeding that provenance event back is skipped (the loop is closed).
    const replay = await automationEngineService.runForEvent({
      trigger: 'field_changed',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      eventId: 'loop-2',
      changedFields: ['priority'],
      viaAutomationRuleId: rule.id,
    });
    expect(replay.skipped).toBe(true);
  });
});

describe('idempotency (invariant #4)', () => {
  it('the same (rule, event) runs exactly once — a replay is deduped, no double effect', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      actions: [{ type: 'transition', toStatusId: 'in_progress' }],
    });
    const item = await newItem(fx);
    const eventId = 'dedupe-evt';

    const first = await created(fx, item.id, { eventId });
    expect(first.succeeded).toBe(1);
    const second = await created(fx, item.id, { eventId });
    expect(second.deduped).toBe(1);
    expect(second.succeeded).toBe(0);

    expect(await executions(rule.id)).toHaveLength(1); // one audit row, action ran once
  });
});

describe('failure ops (invariant #5)', () => {
  it('increments the counter and auto-disables at the threshold', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, { actions: [{ type: 'transition', toStatusId: 'done' }] });
    const item = await newItem(fx);

    for (let i = 0; i < AUTOMATION_AUTO_DISABLE_THRESHOLD; i += 1) {
      await created(fx, item.id, { eventId: `fail-${i}` });
    }

    const ruleRow = await db.automationRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(ruleRow.consecutiveFailureCount).toBe(AUTOMATION_AUTO_DISABLE_THRESHOLD);
    expect(ruleRow.enabled).toBe(false);
    expect(await executions(rule.id)).toHaveLength(AUTOMATION_AUTO_DISABLE_THRESHOLD);
  });

  it('emails the owner only on the FIRST failure after a success (deduped)', async () => {
    const fx = await makeWorkItemFixture();
    await makeRule(fx, { actions: [{ type: 'transition', toStatusId: 'done' }] });
    const item = await newItem(fx);

    const from = cap.events.length;
    await created(fx, item.id, { eventId: 'mail-1' });
    await created(fx, item.id, { eventId: 'mail-2' });

    const mails = cap.events
      .slice(from)
      .filter(
        (e) =>
          e.name === 'email.send' &&
          (e.data as { template?: string }).template === 'automation-rule-failed',
      );
    expect(mails).toHaveLength(1);
    expect((mails[0]!.data as { to: string }).to).toBe(fx.owner.email);
  });

  it('a success resets the consecutive-failure counter', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
    });
    const item = await newItem(fx);
    await db.automationRule.update({
      where: { id: rule.id },
      data: { consecutiveFailureCount: 4 },
    });

    await created(fx, item.id, { eventId: 'reset-1' });
    const ruleRow = await db.automationRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(ruleRow.consecutiveFailureCount).toBe(0);
  });
});

describe('more action + trigger coverage', () => {
  it('a set_field dueDate action writes the date through the shipped service', async () => {
    const fx = await makeWorkItemFixture();
    await makeRule(fx, { actions: [{ type: 'set_field', field: 'dueDate', value: '2027-01-15' }] });
    const item = await newItem(fx);
    expect((await created(fx, item.id)).succeeded).toBe(1);
    const after = await readItem(fx, item.id);
    expect(after.dueDate).toContain('2027-01-15');
  });

  it('a commented-trigger rule with no narrowing matches the comment event', async () => {
    const fx = await makeWorkItemFixture();
    await makeRule(fx, {
      triggerType: 'commented',
      triggerConfig: {},
      actions: [{ type: 'set_field', field: 'priority', value: 'low' }],
    });
    const item = await newItem(fx);
    const summary = await automationEngineService.runForEvent({
      trigger: 'commented',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      eventId: 'comment-1',
    });
    expect(summary).toMatchObject({ matched: 1, succeeded: 1 });
  });

  it('a transitioned rule with only to-narrowing ignores the from status', async () => {
    const fx = await makeWorkItemFixture();
    await makeRule(fx, {
      triggerType: 'transitioned',
      triggerConfig: { toStatusId: 'in_progress' }, // fromStatusId null → no from-narrowing
      actions: [{ type: 'set_field', field: 'priority', value: 'low' }],
    });
    const item = await newItem(fx);
    const summary = await automationEngineService.runForEvent({
      trigger: 'transitioned',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      eventId: 'to-only',
      fromStatusKey: 'blocked', // any from is fine
      toStatusKey: 'in_progress',
    });
    expect(summary.matched).toBe(1);
  });

  it('a field_changed event with no changed fields matches nothing', async () => {
    const fx = await makeWorkItemFixture();
    await makeRule(fx, {
      triggerType: 'field_changed',
      triggerConfig: { field: 'priority' },
      actions: [{ type: 'set_field', field: 'priority', value: 'low' }],
    });
    const item = await newItem(fx);
    const summary = await automationEngineService.runForEvent({
      trigger: 'field_changed',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      eventId: 'no-fields',
    });
    expect(summary.matched).toBe(0);
  });

  it('a rule whose stored trigger config has an unknown type matches nothing', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {});
    // A trigger config the engine doesn't recognise (a forward-compat guard) —
    // written behind the service's back; it must never accidentally fire.
    await db.automationRule.update({
      where: { id: rule.id },
      data: { triggerConfig: { type: 'from_the_future' } },
    });
    const item = await newItem(fx);
    const summary = await created(fx, item.id);
    expect(summary.matched).toBe(0);
  });

  it('a structurally-undecodable stored condition degrades to no_actions (never crashes)', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {});
    // Corrupt the stored envelope behind the service's back (a server invariant
    // the 6.6.1 write path prevents — the engine must still not crash).
    await db.automationRule.update({
      where: { id: rule.id },
      data: { conditionAst: { garbage: true } },
    });
    const item = await newItem(fx);
    const summary = await created(fx, item.id);
    expect(summary.noActions).toBe(1);
    expect((await executions(rule.id))[0]!.status).toBe('no_actions');
  });

  it('an action type with no executor is a recorded failure (the totality guard)', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {});
    // Write a bogus action directly (bypassing the 6.6.1 registry validation).
    await db.automationRule.update({
      where: { id: rule.id },
      data: { actions: [{ type: 'not_a_real_action' }] },
    });
    const item = await newItem(fx);
    const summary = await created(fx, item.id);
    expect(summary.failed).toBe(1);
    expect((await executions(rule.id))[0]!.error).toContain('no executor');
  });
});

describe('internal guards', () => {
  it('a duplicate (rule, event) claim is rejected by the unique index → null (no double row)', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {});
    const item = await newItem(fx);
    const first = await automationEngineService.writeExecution(rule.id, {
      status: 'no_actions',
      workItemId: item.id,
      eventId: 'claim-dup',
      durationMs: 1,
    });
    expect(first).not.toBeNull();
    const second = await automationEngineService.writeExecution(rule.id, {
      status: 'no_actions',
      workItemId: item.id,
      eventId: 'claim-dup',
      durationMs: 1,
    });
    expect(second).toBeNull(); // the partial unique index makes the claim atomic
    expect(await executions(rule.id)).toHaveLength(1);
  });

  it('the failure email is a silent no-op when the owner no longer exists', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {});
    const ruleRow = await db.automationRule.findUniqueOrThrow({
      where: { id: rule.id },
      include: { owner: { select: { id: true, name: true } } },
    });
    const from = cap.events.length;
    await automationEngineService.emailOwnerOnFailure(
      { ...ruleRow, ownerId: 'ghost-user' },
      {
        trigger: 'created',
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: 'wi',
        eventId: 'e',
      },
      'exec-1',
      'boom',
      false,
    );
    const mails = cap.events.slice(from).filter((e) => e.name === 'email.send');
    expect(mails).toHaveLength(0);
  });
});

describe('retention sweep', () => {
  it('deletes only execution rows older than 90 days', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {});
    const item = await newItem(fx);
    await created(fx, item.id, { eventId: 'fresh' });

    // Back-date one audit row well past the 90-day window.
    const oldRow = await db.automationRuleExecution.create({
      data: { ruleId: rule.id, status: 'success', workItemId: item.id, eventId: 'ancient' },
    });
    await db.automationRuleExecution.update({
      where: { id: oldRow.id },
      data: { createdAt: new Date('2020-01-01T00:00:00Z') },
    });

    const { deleted } = await automationEngineService.sweepExpiredExecutions();
    expect(deleted).toBe(1);

    const remaining = await executions(rule.id);
    expect(remaining.map((r) => r.eventId)).toContain('fresh');
    expect(remaining.map((r) => r.eventId)).not.toContain('ancient');
  });

  it('sweeps in multiple bounded batches when more than one batch is due', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {});
    // 501 stale rows → batch 1 deletes 500 (full → loop continues), batch 2
    // deletes 1 (short → drained). Exercises the multi-batch loop.
    const ancient = new Date('2019-06-01T00:00:00Z');
    await db.automationRuleExecution.createMany({
      data: Array.from({ length: 501 }, (_unused, i) => ({
        ruleId: rule.id,
        status: 'success' as const,
        eventId: `old-${i}`,
        createdAt: ancient,
      })),
    });

    const { deleted } = await automationEngineService.sweepExpiredExecutions();
    expect(deleted).toBe(501);
    expect(await executions(rule.id)).toHaveLength(0);
  });
});
