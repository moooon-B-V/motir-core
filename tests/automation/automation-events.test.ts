import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { automationFieldsFromDiffKeys } from '@/lib/automation/fields';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  WorkItemCreatedData,
  WorkItemFieldChangedData,
  WorkItemTransitionedData,
} from '@/lib/jobs/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';

// The automation EMIT seam (Story 6.6 · Subtask 6.6.2). The engine's events
// (`work-item/created` + `work-item/field.changed`) are post-commit emits from
// the SHIPPED workItemsService paths; this file proves them at the source —
// the same stub-inngest.send pattern the 5.4.5 transition-emit tests use. Real
// Postgres, no DB mocks; the one seam stubbed is the Inngest client's `send()`
// (captureJobEvents, installed for the whole test so even seeding writes are
// captured), which doubles as the assertion surface. `eventsSince` slices the
// live buffer to the operation under test. Covers: every create emits
// `created`; a built-in-field edit emits `field.changed` carrying the changed
// field ids; a non-automatable / no-op edit emits nothing; provenance rides
// through every emit when the ServiceContext carries it; and the diff-key →
// automation-field translation the emit gate uses.

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

/** Events of `name` emitted since the buffer index `from` — scopes assertions
 * to the single operation under test (seeding emits are captured too). */
function eventsSince(from: number, name: string): CapturedJobEvent[] {
  return cap.events.slice(from).filter((e) => e.name === name);
}

async function memberCtx(fx: WorkItemFixture, email: string): Promise<ServiceContext> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

describe('automationFieldsFromDiffKeys', () => {
  it('translates diff keys to automation field ids, dropping non-automatable keys', () => {
    expect(
      automationFieldsFromDiffKeys(['assigneeId', 'priority', 'dueDate', 'estimateMinutes']),
    ).toEqual(['assignee', 'priority', 'dueDate', 'estimate']);
  });

  it('ignores keys that are not automatable built-in fields (title, kind, body)', () => {
    expect(automationFieldsFromDiffKeys(['title', 'kind', 'descriptionMd', 'attachments'])).toEqual(
      [],
    );
  });

  it('preserves the canonical field order regardless of input order', () => {
    expect(automationFieldsFromDiffKeys(['dueDate', 'assigneeId'])).toEqual([
      'assignee',
      'dueDate',
    ]);
  });
});

describe('work-item/created emit', () => {
  it('every create emits one created event with the project + actor, no provenance', async () => {
    const fx = await makeWorkItemFixture();
    const from = cap.events.length;
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A task' },
      fx.ctx,
    );

    const created = eventsSince(from, 'work-item/created');
    expect(created).toHaveLength(1);
    const data = created[0]!.data as WorkItemCreatedData;
    expect(data).toMatchObject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      actorId: fx.ownerId,
    });
    expect(data.viaAutomationRuleId).toBeUndefined();
  });

  it('carries provenance when the ServiceContext is automation-driven', async () => {
    const fx = await makeWorkItemFixture();
    const from = cap.events.length;
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Via rule' },
      { ...fx.ctx, viaAutomationRuleId: 'rule-xyz' },
    );

    const data = eventsSince(from, 'work-item/created')[0]!.data as WorkItemCreatedData;
    expect(data.viaAutomationRuleId).toBe('rule-xyz');
  });
});

describe('work-item/field.changed emit', () => {
  it('emits the changed automatable field ids on a priority edit', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Edit me', priority: 'low' },
      fx.ctx,
    );
    const from = cap.events.length;
    await workItemsService.updateWorkItem(item.id, { priority: 'high' }, fx.ctx);

    const changed = eventsSince(from, 'work-item/field.changed');
    expect(changed).toHaveLength(1);
    const data = changed[0]!.data as WorkItemFieldChangedData;
    expect(data).toMatchObject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      actorId: fx.ownerId,
      changedFields: ['priority'],
    });
    expect(typeof data.revisionId).toBe('string');
  });

  it('maps an assignee edit to the "assignee" field id (the assigned preset)', async () => {
    const fx = await makeWorkItemFixture();
    const assignee = await memberCtx(fx, 'assignee@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Assign me' },
      fx.ctx,
    );
    const from = cap.events.length;
    await workItemsService.updateWorkItem(item.id, { assigneeId: assignee.userId }, fx.ctx);

    const data = eventsSince(from, 'work-item/field.changed')[0]!.data as WorkItemFieldChangedData;
    expect(data.changedFields).toEqual(['assignee']);
  });

  it('emits NOTHING when only a non-automatable field changes (title)', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Before' },
      fx.ctx,
    );
    const from = cap.events.length;
    await workItemsService.updateWorkItem(item.id, { title: 'After' }, fx.ctx);

    expect(eventsSince(from, 'work-item/field.changed')).toHaveLength(0);
  });

  it('emits NOTHING on a no-op edit (value unchanged)', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Steady', priority: 'medium' },
      fx.ctx,
    );
    const from = cap.events.length;
    await workItemsService.updateWorkItem(item.id, { priority: 'medium' }, fx.ctx);

    expect(eventsSince(from, 'work-item/field.changed')).toHaveLength(0);
  });

  it('carries provenance when the edit is automation-driven', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Via rule', priority: 'low' },
      fx.ctx,
    );
    const from = cap.events.length;
    await workItemsService.updateWorkItem(
      item.id,
      { priority: 'high' },
      { ...fx.ctx, viaAutomationRuleId: 'rule-abc' },
    );

    const data = eventsSince(from, 'work-item/field.changed')[0]!.data as WorkItemFieldChangedData;
    expect(data.viaAutomationRuleId).toBe('rule-abc');
  });
});

describe('work-item/transitioned provenance', () => {
  it('stamps the rule id when a transition is automation-driven', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Move me' },
      fx.ctx,
    );
    const from = cap.events.length;
    await workItemsService.updateStatus(item.id, 'in_progress', {
      ...fx.ctx,
      viaAutomationRuleId: 'rule-move',
    });

    const data = eventsSince(from, 'work-item/transitioned')[0]!.data as WorkItemTransitionedData;
    expect(data.viaAutomationRuleId).toBe('rule-move');
  });

  it('omits provenance on a user-driven transition', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Move me' },
      fx.ctx,
    );
    const from = cap.events.length;
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);

    const data = eventsSince(from, 'work-item/transitioned')[0]!.data as WorkItemTransitionedData;
    expect(data.viaAutomationRuleId).toBeUndefined();
  });
});
