import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { automationEngineService } from '@/lib/services/automationEngineService';
import {
  automationRulesService,
  type AutomationRuleWriteInput,
} from '@/lib/services/automationRulesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { encodeFilterParam, type FilterAst, type FilterCondition } from '@/lib/filters/ast';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGER_TYPES,
  type AutomationActionConfig,
  type AutomationActionType,
  type AutomationTriggerType,
} from '@/lib/automation/registry';
import {
  AUTOMATION_AUTO_DISABLE_THRESHOLD,
  AUTOMATION_EXECUTION_RETENTION_DAYS,
} from '@/lib/automation/constants';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';

// Story 6.6 · Subtask 6.6.7 — the STORY-CLOSING engine verification (Principle
// #18). This is the registry-DRIVEN matrix the card pins: the trigger and action
// coverage is enumerated FROM the registries (AUTOMATION_TRIGGER_TYPES /
// AUTOMATION_ACTION_TYPES), with a totality guard that FAILS the suite the moment
// a new registry entry lands without a matrix case — the 6.1.6 totality pattern
// applied to the when/then vocabulary. On top of the matrix it re-proves the five
// engine invariants AS A STORY (loop prevention, conditions gate, idempotency,
// failure ops → auto-disable, retention) and the owner-attribution deviation, so
// the whole engine is green from one closing suite.
//
// Distinct from the per-subtask suites (automation-engine / automation-epic5 hand-
// pick individual cells): those PROVE each mechanism; this one GUARDS that every
// registry entry is exercised and ties the invariants to the story's recipe. The
// EPIC-wide journey (filters + permissions + automation firing together) stays in
// Story 6.7 — not duplicated here.
//
// Real Postgres, no DB mocks (Yue's no-mocks rule); the one seam stubbed is the
// Inngest client's send() (captureJobEvents) so seeding writes don't hit the
// network and the provenance emits stay assertable. Automation configs speak
// status KEYS (what the unit updateStatus + the transitioned event use).

let cap: { events: CapturedJobEvent[]; restore: () => void };
let evtSeq = 0;

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

function nextEventId(): string {
  return `evt-story-${(evtSeq += 1)}`;
}

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

async function newItem(fx: WorkItemFixture, kind: 'task' | 'bug' | 'story' = 'task', title = 'X') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind, title }, fx.ctx);
}

function readItem(fx: WorkItemFixture, id: string) {
  return workItemsService.getWorkItem(id, fx.ctx);
}

function executions(ruleId: string) {
  return db.automationRuleExecution.findMany({ where: { ruleId }, orderBy: { createdAt: 'asc' } });
}

function conditionParam(conditions: FilterCondition[]): string {
  const ast: FilterAst = { combinator: 'and', conditions };
  return encodeFilterParam(ast);
}

/** Add a fresh workspace member (the add_watcher / set_field-assignee target). */
async function addMember(fx: WorkItemFixture, email: string) {
  const user = await createTestUser({ email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return user;
}

type RunOverrides = Partial<Parameters<typeof automationEngineService.runForEvent>[0]>;

function runEvent(fx: WorkItemFixture, workItemId: string, overrides: RunOverrides = {}) {
  return automationEngineService.runForEvent({
    trigger: 'created',
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    workItemId,
    eventId: nextEventId(),
    ...overrides,
  });
}

// ───────────────────────── the registry-driven TRIGGER axis ──────────────────
//
// One case per trigger type. `config` is the rule's stored trigger config;
// `match` is a runForEvent that the trigger SHOULD fire on; `miss`, where the
// trigger config narrows, is one that should NOT. The keys are asserted EQUAL to
// AUTOMATION_TRIGGER_TYPES below — a new trigger with no case fails the suite.

interface TriggerCase {
  config: Record<string, unknown>;
  match: RunOverrides;
  miss?: RunOverrides;
}

const TRIGGER_CASES: Record<AutomationTriggerType, TriggerCase> = {
  created: {
    config: {},
    match: { trigger: 'created' },
  },
  transitioned: {
    config: { fromStatusId: 'todo', toStatusId: 'in_progress' },
    match: { trigger: 'transitioned', fromStatusKey: 'todo', toStatusKey: 'in_progress' },
    miss: { trigger: 'transitioned', fromStatusKey: 'todo', toStatusKey: 'done' },
  },
  field_changed: {
    config: { field: 'priority' },
    match: { trigger: 'field_changed', changedFields: ['priority'] },
    miss: { trigger: 'field_changed', changedFields: ['assignee'] },
  },
  commented: {
    config: {},
    match: { trigger: 'commented' },
  },
};

// ───────────────────────── the registry-driven ACTION axis ───────────────────
//
// One builder per action type. `setup` seeds whatever referent the action needs
// (a member, a custom field, …) and returns the stored action config + an
// assertion of the side-effect a SUCCESSFUL run must produce. Keys asserted EQUAL
// to AUTOMATION_ACTION_TYPES — a new action with no case fails the suite.

interface ActionCase {
  config: AutomationActionConfig;
  assertEffect: (fx: WorkItemFixture, itemId: string) => Promise<void>;
}

const ACTION_BUILDERS: Record<
  AutomationActionType,
  (fx: WorkItemFixture, itemId: string) => Promise<ActionCase>
> = {
  // a legal default transition (a fresh item is born in `todo`; todo→in_progress
  // is legal, todo→done is not).
  transition: async () => ({
    config: { type: 'transition', toStatusId: 'in_progress' },
    assertEffect: async (fx, itemId) => {
      expect((await readItem(fx, itemId)).status).toBe('in_progress');
    },
  }),
  set_field: async () => ({
    config: { type: 'set_field', field: 'priority', value: 'highest' },
    assertEffect: async (fx, itemId) => {
      expect((await readItem(fx, itemId)).priority).toBe('highest');
    },
  }),
  add_watcher: async (fx) => {
    const member = await addMember(fx, `watch-${nextEventId()}@ex.com`);
    return {
      config: { type: 'add_watcher', userId: member.id },
      assertEffect: async (_fx, itemId) => {
        const watchers = await db.watcher.findMany({ where: { workItemId: itemId } });
        expect(watchers.map((w) => w.userId)).toContain(member.id);
      },
    };
  },
  add_comment: async () => ({
    config: { type: 'add_comment', bodyMd: 'Verify the fix' },
    assertEffect: async (_fx, itemId) => {
      const comments = await db.comment.findMany({ where: { workItemId: itemId } });
      expect(comments.map((c) => c.bodyMd)).toContain('Verify the fix');
    },
  }),
  add_label: async () => ({
    config: { type: 'add_label', name: 'needs-qa' },
    assertEffect: async (_fx, itemId) => {
      const links = await db.workItemLabel.findMany({
        where: { workItemId: itemId },
        include: { label: true },
      });
      expect(links.map((l) => l.label.name)).toContain('needs-qa');
    },
  }),
  set_custom_field: async (fx) => {
    const field = await customFieldsService.createField({
      key: fx.project.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      label: `Severity ${nextEventId()}`,
      fieldType: 'select',
      options: ['High'],
    });
    const option = field.options!.find((o) => o.label === 'High')!;
    return {
      config: { type: 'set_custom_field', fieldId: field.id, value: option.id },
      assertEffect: async (_fx, itemId) => {
        const value = await db.customFieldValue.findFirst({
          where: { workItemId: itemId, fieldId: field.id },
        });
        expect(value).not.toBeNull();
      },
    };
  },
};

describe('the matrix is TOTAL over the registries (a new entry fails the suite)', () => {
  it('every registered trigger type has a matrix case', () => {
    expect(Object.keys(TRIGGER_CASES).sort()).toEqual([...AUTOMATION_TRIGGER_TYPES].sort());
  });

  it('every registered action type has a matrix builder', () => {
    expect(Object.keys(ACTION_BUILDERS).sort()).toEqual([...AUTOMATION_ACTION_TYPES].sort());
  });
});

describe('the TRIGGER axis — every trigger fires on its event and its config narrows', () => {
  it.each(AUTOMATION_TRIGGER_TYPES)('%s fires on a matching event', async (triggerType) => {
    const fx = await makeWorkItemFixture();
    const tc = TRIGGER_CASES[triggerType];
    const rule = await makeRule(fx, {
      triggerType,
      triggerConfig: tc.config,
      actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
    });
    const item = await newItem(fx);

    const fired = await runEvent(fx, item.id, tc.match);
    expect(fired.matched).toBe(1);
    expect(fired.succeeded).toBe(1);
    expect((await executions(rule.id))[0]!.status).toBe('success');
  });

  it.each(AUTOMATION_TRIGGER_TYPES.filter((t) => TRIGGER_CASES[t].miss))(
    '%s does NOT fire when its trigger config narrows it out',
    async (triggerType) => {
      const fx = await makeWorkItemFixture();
      const tc = TRIGGER_CASES[triggerType];
      const rule = await makeRule(fx, { triggerType, triggerConfig: tc.config });
      const item = await newItem(fx);

      const missed = await runEvent(fx, item.id, tc.miss!);
      expect(missed.matched).toBe(0);
      expect(await executions(rule.id)).toHaveLength(0);
    },
  );
});

describe('the ACTION axis — every action executes through its shipped service and audits success', () => {
  it.each(AUTOMATION_ACTION_TYPES)(
    '%s runs on a created trigger and records a success row',
    async (actionType) => {
      const fx = await makeWorkItemFixture();
      const item = await newItem(fx);
      const action = await ACTION_BUILDERS[actionType](fx, item.id);
      const rule = await makeRule(fx, { actions: [action.config] });

      const summary = await runEvent(fx, item.id);
      expect(summary).toMatchObject({ matched: 1, succeeded: 1, failed: 0 });
      const [row] = await executions(rule.id);
      expect(row!.status).toBe('success');
      await action.assertEffect(fx, item.id);
    },
  );
});

describe('the CONDITION axis — the 6.1 group gates the action (pass / fail / empty)', () => {
  it('a matching item succeeds; a non-matching item logs no_actions; an empty group passes', async () => {
    const fx = await makeWorkItemFixture();
    // pass / fail: a "Kind is any of (Bug)" gate.
    const gated = await makeRule(fx, {
      conditionFilterParam: conditionParam([
        { field: 'kind', operator: 'is_any_of', value: ['bug'] },
      ]),
      actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
    });
    const story = await newItem(fx, 'story', 'A story');
    const blocked = await runEvent(fx, story.id);
    expect(blocked).toMatchObject({ matched: 1, noActions: 1, succeeded: 0 });
    expect((await executions(gated.id))[0]!.status).toBe('no_actions');
    expect((await readItem(fx, story.id)).priority).not.toBe('high');

    const bug = await newItem(fx, 'bug', 'A bug');
    expect((await runEvent(fx, bug.id)).succeeded).toBe(1);
    expect((await readItem(fx, bug.id)).priority).toBe('high');

    // empty group: always passes.
    const ungated = await makeRule(fx, { conditionFilterParam: null });
    const item = await newItem(fx);
    expect((await runEvent(fx, item.id)).succeeded).toBe(1);
    expect((await executions(ungated.id))[0]!.status).toBe('success');
  });
});

describe('the story invariants hold end to end', () => {
  it('loop prevention — an event carrying provenance fires no rule (rules never trigger rules)', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {});
    const item = await newItem(fx);
    const summary = await runEvent(fx, item.id, { viaAutomationRuleId: rule.id });
    expect(summary.skipped).toBe(true);
    expect(summary.matched).toBe(0);
    expect(await executions(rule.id)).toHaveLength(0);
  });

  it('idempotency — the same (rule, event) runs exactly once; a replay is a no-op', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      actions: [{ type: 'transition', toStatusId: 'in_progress' }],
    });
    const item = await newItem(fx);
    const eventId = nextEventId();
    const first = await runEvent(fx, item.id, { eventId });
    const replay = await runEvent(fx, item.id, { eventId });
    expect(first.succeeded).toBe(1);
    expect(replay.deduped).toBe(1);
    expect(replay.succeeded).toBe(0);
    expect(await executions(rule.id)).toHaveLength(1);
    expect((await readItem(fx, item.id)).status).toBe('in_progress');
  });

  it('failure ops — consecutive failures auto-disable the rule at the verified threshold', async () => {
    const fx = await makeWorkItemFixture();
    // todo→done is an illegal default transition → every run is a recorded failure.
    const rule = await makeRule(fx, { actions: [{ type: 'transition', toStatusId: 'done' }] });
    for (let i = 0; i < AUTOMATION_AUTO_DISABLE_THRESHOLD; i += 1) {
      const item = await newItem(fx);
      const summary = await runEvent(fx, item.id);
      expect(summary.failed).toBe(1);
    }
    const after = await db.automationRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(after.enabled).toBe(false);
    expect(after.consecutiveFailureCount).toBeGreaterThanOrEqual(AUTOMATION_AUTO_DISABLE_THRESHOLD);
    expect((await executions(rule.id)).every((r) => r.status === 'failure')).toBe(true);
  });

  it('attribution — an action runs as the rule OWNER (the recorded deviation), not a system actor', async () => {
    const fx = await makeWorkItemFixture();
    await makeRule(fx, { actions: [{ type: 'add_comment', bodyMd: 'auto: triaged' }] });
    const item = await newItem(fx);
    await runEvent(fx, item.id);
    const comment = await db.comment.findFirstOrThrow({ where: { workItemId: item.id } });
    expect(comment.authorId).toBe(fx.ownerId);
  });

  it('retention — the sweep deletes only execution rows older than the verified window', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {});
    const item = await newItem(fx);
    await runEvent(fx, item.id); // a fresh (in-window) row

    // Back-date a row past the retention boundary, directly (the test-sanctioned
    // DB reach — no service path writes a historical createdAt).
    const now = new Date('2026-06-12T00:00:00.000Z');
    const stale = new Date(now);
    stale.setUTCDate(stale.getUTCDate() - (AUTOMATION_EXECUTION_RETENTION_DAYS + 1));
    await db.automationRuleExecution.create({
      data: {
        ruleId: rule.id,
        status: 'success',
        workItemId: item.id,
        durationMs: 1,
        eventId: nextEventId(),
        createdAt: stale,
      },
    });

    const before = await executions(rule.id);
    expect(before).toHaveLength(2);
    const { deleted } = await automationEngineService.sweepExpiredExecutions(now);
    expect(deleted).toBe(1);
    const remaining = await executions(rule.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.createdAt.getTime()).toBeGreaterThan(stale.getTime());
  });
});
