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
import { encodeFilterParam, customFieldFilterFieldId } from '@/lib/filters/ast';
import type { FilterCondition } from '@/lib/filters/ast';
import { makeWorkItemFixture, createTestUser, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';
import type { WorkItemCommentCreatedData } from '@/lib/jobs/types';

// Epic-5 registry/engine EXTENSIONS (Story 6.6 · Subtask 6.6.3) — the four new
// actions executing through their owning shipped services as the rule owner with
// full side-effect fidelity, the two Epic-5-sourced trigger consumers resolving
// projectId from the item, the loop-prevention extension (a comment-trigger rule
// + add_comment action runs once via the provenance stamp), stale-referent
// failures, and the dynamic Epic-5 condition rows (gating + write-time
// validation). Real Postgres, no DB mocks; the one seam stubbed is Inngest's
// send() (captureJobEvents) so the provenance emits become assertable.

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

let evtSeq = 0;
function nextEventId(): string {
  return `evt-e5-${(evtSeq += 1)}`;
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

/** Add a fresh workspace member (the addWatcher / mention / user-CF target). */
async function addMember(fx: WorkItemFixture, email: string) {
  const user = await createTestUser({ email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return user;
}

function executions(ruleId: string) {
  return db.automationRuleExecution.findMany({ where: { ruleId }, orderBy: { createdAt: 'asc' } });
}

function commentEvents(): CapturedJobEvent[] {
  return cap.events.filter((e) => e.name === 'work-item/comment.created');
}

// ───────────────────────── Epic-5 actions as owner (invariant #3) ─────────────

describe('Epic-5 actions execute through their owning service as the rule owner', () => {
  it('add_watcher adds a member as a watcher', async () => {
    const fx = await makeWorkItemFixture();
    const bo = await addMember(fx, 'bo@ex.com');
    const rule = await makeRule(fx, { actions: [{ type: 'add_watcher', userId: bo.id }] });
    const item = await newItem(fx);

    await automationEngineService.runForEvent({
      trigger: 'created',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      eventId: nextEventId(),
    });

    const watchers = await db.watcher.findMany({ where: { workItemId: item.id } });
    expect(watchers.map((w) => w.userId)).toContain(bo.id);
    const [row] = await executions(rule.id);
    expect(row?.status).toBe('success');
  });

  it('add_comment posts a comment whose own event carries the rule provenance', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      actions: [{ type: 'add_comment', bodyMd: 'Please verify the fix' }],
    });
    const item = await newItem(fx);

    await automationEngineService.runForEvent({
      trigger: 'created',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      eventId: nextEventId(),
    });

    const comments = await db.comment.findMany({ where: { workItemId: item.id } });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toBe('Please verify the fix');
    expect(comments[0]!.authorId).toBe(fx.ownerId); // attributed to the owner
    // The comment's own event is stamped, so it can never re-fire a rule.
    const emitted = commentEvents();
    expect(emitted).toHaveLength(1);
    expect((emitted[0]!.data as WorkItemCommentCreatedData).viaAutomationRuleId).toBe(rule.id);
  });

  it('add_label attaches a find-or-created label', async () => {
    const fx = await makeWorkItemFixture();
    await makeRule(fx, { actions: [{ type: 'add_label', name: 'needs-qa' }] });
    const item = await newItem(fx);

    await automationEngineService.runForEvent({
      trigger: 'created',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      eventId: nextEventId(),
    });

    const links = await db.workItemLabel.findMany({
      where: { workItemId: item.id },
      include: { label: true },
    });
    expect(links.map((l) => l.label.name)).toContain('needs-qa');
  });

  it('set_custom_field writes the value through the values service (with a revision)', async () => {
    const fx = await makeWorkItemFixture();
    const field = await customFieldsService.createField({
      key: fx.project.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      label: 'Severity',
      fieldType: 'select',
      options: ['High'],
    });
    const opt = field.options!.find((o) => o.label === 'High')!;
    await makeRule(fx, {
      actions: [{ type: 'set_custom_field', fieldId: field.id, value: opt.id }],
    });
    const item = await newItem(fx);

    await automationEngineService.runForEvent({
      trigger: 'created',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      eventId: nextEventId(),
    });

    const value = await db.customFieldValue.findFirst({
      where: { workItemId: item.id, fieldId: field.id },
    });
    expect(value).not.toBeNull();
    const revisions = await db.workItemRevision.findMany({ where: { workItemId: item.id } });
    // A create revision + the CF-set revision (attributed to the owner).
    expect(revisions.some((r) => r.changedById === fx.ownerId)).toBe(true);
  });
});

// ───────────────────────── Stale referents → recorded failure ─────────────────

describe('Epic-5 actions degrade to a recorded failure on a stale / ineligible referent', () => {
  it('add_watcher of a non-member user is a recorded failure, not a crash', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      actions: [{ type: 'add_watcher', userId: 'no-such-user' }],
    });
    const item = await newItem(fx);

    await automationEngineService.runForEvent({
      trigger: 'created',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      eventId: nextEventId(),
    });

    const [row] = await executions(rule.id);
    expect(row?.status).toBe('failure');
    expect(row?.error).toBeTruthy();
  });

  it('set_custom_field on a deleted field id is a recorded failure', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      actions: [{ type: 'set_custom_field', fieldId: 'deleted-field', value: 'x' }],
    });
    const item = await newItem(fx);

    await automationEngineService.runForEvent({
      trigger: 'created',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      eventId: nextEventId(),
    });

    const [row] = await executions(rule.id);
    expect(row?.status).toBe('failure');
  });
});

// ───────────────────────── Loop prevention extension (invariant #1) ───────────

describe('loop prevention extends to the comment trigger + add_comment action', () => {
  it('a commented-rule with an add_comment action runs ONCE — the stamped follow-on event is skipped', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      triggerType: 'commented',
      triggerConfig: {},
      actions: [{ type: 'add_comment', bodyMd: 'auto: triaged' }],
    });
    const item = await newItem(fx);

    // A human comment fires the rule (no provenance on the originating event).
    await automationEngineService.runForEvent({
      trigger: 'commented',
      workspaceId: fx.workspaceId,
      workItemId: item.id, // NB: no projectId — the consumer resolves it
      eventId: nextEventId(),
    });

    const afterFirst = await executions(rule.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.status).toBe('success');

    // The action's own comment.created event carries provenance — feeding it
    // back to the engine is skipped, so no cascade (the rule runs exactly once).
    const stamped = commentEvents().find(
      (e) => (e.data as WorkItemCommentCreatedData).viaAutomationRuleId === rule.id,
    )!;
    expect(stamped).toBeTruthy();
    const summary = await automationEngineService.runForEvent({
      trigger: 'commented',
      workspaceId: fx.workspaceId,
      workItemId: item.id,
      eventId: nextEventId(),
      viaAutomationRuleId: rule.id,
    });
    expect(summary.skipped).toBe(true);
    expect(await executions(rule.id)).toHaveLength(1);
  });
});

// ───────────────────────── Epic-5 trigger consumers resolve projectId ─────────

describe('the Epic-5 trigger consumers resolve projectId from the item', () => {
  it('a transitioned rule fires off an event that carries no projectId', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeRule(fx, {
      triggerType: 'transitioned',
      triggerConfig: { toStatusId: 'done' },
      actions: [{ type: 'add_label', name: 'shipped' }],
    });
    const item = await newItem(fx);

    const summary = await automationEngineService.runForEvent({
      trigger: 'transitioned',
      workspaceId: fx.workspaceId,
      workItemId: item.id, // no projectId
      eventId: nextEventId(),
      fromStatusKey: 'in_progress',
      toStatusKey: 'done',
    });

    expect(summary.matched).toBe(1);
    const [row] = await executions(rule.id);
    expect(row?.status).toBe('success');
  });

  it('a since-deleted item resolves no project — a clean no-op, never a crash', async () => {
    const fx = await makeWorkItemFixture();
    const summary = await automationEngineService.runForEvent({
      trigger: 'commented',
      workspaceId: fx.workspaceId,
      workItemId: 'gone',
      eventId: nextEventId(),
    });
    expect(summary.matched).toBe(0);
    expect(summary.skipped).toBe(false);
  });
});

// ───────────────────────── Epic-5 condition rows (6.1.2 dynamic entries) ──────

function conditionParam(conditions: FilterCondition[]): string {
  return encodeFilterParam({ combinator: 'and', conditions });
}

describe('Epic-5 condition rows gate the rule (the 6.1.2 dynamic entries)', () => {
  it('a label condition gates a rule — a labelled item matches, an unlabelled one does not', async () => {
    const fx = await makeWorkItemFixture();
    const labelled = await newItem(fx, 'bug', 'has label');
    const plain = await newItem(fx, 'bug', 'no label');
    const { labelsService } = await import('@/lib/services/labelsService');
    await labelsService.addLabel(labelled.id, 'release-blocker', fx.ctx);
    const [link] = await db.workItemLabel.findMany({
      where: { workItemId: labelled.id },
      include: { label: true },
    });
    const labelId = link!.labelId;

    const rule = await makeRule(fx, {
      conditionFilterParam: conditionParam([
        { field: 'lbl', operator: 'is_any_of', value: [labelId] },
      ]),
      actions: [{ type: 'add_watcher', userId: fx.ownerId }],
    });

    const miss = await automationEngineService.runForEvent({
      trigger: 'created',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: plain.id,
      eventId: nextEventId(),
    });
    const hit = await automationEngineService.runForEvent({
      trigger: 'created',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: labelled.id,
      eventId: nextEventId(),
    });

    expect(miss.noActions).toBe(1);
    expect(hit.succeeded).toBe(1);
    const rows = await executions(rule.id);
    expect(rows.map((r) => r.status).sort()).toEqual(['no_actions', 'success']);
  });
});

describe('write-time validation of Epic-5 condition rows (the 6.6.3 wiring)', () => {
  it('accepts a valid custom-field condition row but rejects a forged operator on it', async () => {
    const fx = await makeWorkItemFixture();
    const field = await customFieldsService.createField({
      key: fx.project.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      label: 'Team',
      fieldType: 'select',
      options: ['Core'],
    });
    const cf = customFieldFilterFieldId(field.id);
    const core = field.options!.find((o) => o.label === 'Core')!;

    // Valid: the select CF row with an is_any_of over a real option.
    await expect(
      makeRule(fx, {
        conditionFilterParam: conditionParam([
          { field: cf, operator: 'is_any_of', value: [core.id] },
        ]),
      }),
    ).resolves.toBeTruthy();

    // Forged: an operator outside a select field's set — now caught at write
    // time because the referent pass resolves the dynamic def (6.6.3).
    await expect(
      makeRule(fx, {
        conditionFilterParam: conditionParam([
          { field: cf, operator: 'contains', value: 'x' } as unknown as FilterCondition,
        ]),
      }),
    ).rejects.toThrow();
  });
});
