import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { toIssueRows } from '@/app/(authed)/items/_components/issueRows';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
} from '../../fixtures';

// The /items route's data shaping (Subtask 2.5.3), against a REAL Postgres
// (Yue's no-mocks rule). The page itself is a thin Server Component; the
// load-bearing logic is the pure `toIssueRows` mapping over the SAME three
// service reads the page performs — getProjectTree (2.5.1) + the workflow +
// the workspace members. These tests drive that path end-to-end: project-scoped
// nesting, status (key → label + category) and assignee (id → name) resolution,
// the unclassifiable-status fallback, and the empty project.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Re-run the page's three service reads + the pure shaping, as the route does. */
async function loadRows(fx: Awaited<ReturnType<typeof makeFixture>>) {
  const [tree, workflow, members] = await Promise.all([
    workItemsService.getProjectTree(fx.projectId, {}, fx.ctx),
    workflowsService.getWorkflow(fx.projectId, fx.workspaceId),
    workspacesService.listMembers(fx.workspaceId, fx.ownerId),
  ]);
  return toIssueRows(tree, workflow, members);
}

describe('issues page data shaping (toIssueRows over the live reads)', () => {
  it('nests the project forest into rows and resolves status + assignee', async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Epic E' });
    const story = await createWorkItem(fx, { kind: 'story', title: 'Story S', parentId: epic.id });
    await createWorkItem(fx, { kind: 'task', title: 'Task T', parentId: story.id });

    // Set real workflow statuses (the fixture's createTestWorkItem inserts the
    // column-default 'open', bypassing the service's initial-status seeding) and
    // assign the story, so both resolution paths are exercised deterministically.
    await db.workItem.update({ where: { id: epic.id }, data: { status: 'todo' } });
    await db.workItem.update({
      where: { id: story.id },
      data: {
        status: 'in_progress',
        assigneeId: fx.ownerId,
        priority: 'high',
        dueDate: new Date('2026-06-04T00:00:00.000Z'),
        estimateMinutes: 90,
      },
    });

    const rows = await loadRows(fx);

    // One root (the epic), nesting preserved: epic → story → task.
    expect(rows).toHaveLength(1);
    const e = rows[0]!;
    expect(e.data.identifier).toBe('PROD-1');
    expect(e.data.kind).toBe('epic');
    expect(e.children).toHaveLength(1);
    const s = e.children![0]!;
    expect(s.data.identifier).toBe('PROD-2');
    expect(s.children![0]!.data.identifier).toBe('PROD-3');

    // Status resolved to the workflow label + category (drives the Pill tone).
    expect(s.data.statusLabel).toBe('In Progress');
    expect(s.data.statusCategory).toBe('in_progress');
    // Assignee id resolved to the member's display name.
    expect(s.data.assigneeName).toBe(fx.owner.name || fx.owner.email);

    // The detail-page core fields surfaced on the row: priority passes through;
    // reporter id → name; due date + estimate are pre-formatted server-side.
    expect(s.data.priority).toBe('high');
    expect(s.data.reporterName).toBe(fx.owner.name || fx.owner.email);
    expect(s.data.dueLabel).toBe('Jun 4, 2026');
    expect(s.data.estimateLabel).toBe('1h 30m');

    // The epic has no due/estimate → null labels; default priority 'medium'.
    expect(e.data.priority).toBe('medium');
    expect(e.data.dueLabel).toBeNull();
    expect(e.data.estimateLabel).toBeNull();

    // The epic (status 'todo') resolves to the To Do label/category, unassigned.
    expect(e.data.statusLabel).toBe('To Do');
    expect(e.data.statusCategory).toBe('todo');
    expect(e.data.assigneeName).toBeNull();
  });

  it('falls back to a neutral status (raw key, null category) for an unclassifiable status', async () => {
    const fx = await makeFixture();
    const item = await createWorkItem(fx, { kind: 'task', title: 'Orphan status' });
    // A status key the project workflow doesn't define (defensive fallback path).
    await db.workItem.update({ where: { id: item.id }, data: { status: 'archived_elsewhere' } });

    const rows = await loadRows(fx);
    expect(rows[0]!.data.statusLabel).toBe('archived_elsewhere');
    expect(rows[0]!.data.statusCategory).toBeNull();
  });

  it('shapes an empty project to []', async () => {
    const fx = await makeFixture();
    const rows = await loadRows(fx);
    expect(rows).toEqual([]);
  });
});
