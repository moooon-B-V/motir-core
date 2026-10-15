import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import type { WorkbenchWindowDto } from '@/lib/dto/workbench';
import { WORKBENCH_TABS } from '@/lib/workbench/tab';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// GET /api/workbench/window (Story MOTIR-8539 · Subtask MOTIR-8573) — the
// active tab's window and every strip count in one read, against real Postgres.
// Only the cookie-context resolver is stubbed (the test environment has no
// cookies), as `workbench-stream-route.test.ts` does for the stream beside it.

const workspaceCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => workspaceCtx.current };
});

const { GET } = await import('@/app/api/workbench/window/route');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { homeService } = await import('@/lib/services/homeService');

const BASE = 'http://localhost:3000';

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'WWN' });
  workspaceCtx.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function read(query: string): Promise<Response> {
  return GET(new Request(`${BASE}/api/workbench/window${query}`));
}

async function card(title: string, projectId = fx.projectId): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId, kind: 'task', title, assigneeId: fx.ownerId },
    fx.ctx,
  );
  return item.id;
}

const actor = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId });

describe('GET /api/workbench/window', () => {
  it('answers To do with its window and the strip counts, which agree', async () => {
    await card('First thing to do');
    await card('Second thing to do');

    const res = await read('?tab=todo');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as WorkbenchWindowDto;

    expect(body.tab).toBe('todo');
    expect(body.window.kind).toBe('workItems');
    if (body.window.kind !== 'workItems') throw new Error('unreachable');
    expect(body.counts).toEqual(await homeService.tabCounts(actor()));
    // ROWS AND COUNTS AGREE — the rule a client applier inherits from this read.
    expect(body.window.page.total).toBe(body.counts.toDo);
    expect(body.window.page.items.map((i) => i.title).sort()).toEqual([
      'First thing to do',
      'Second thing to do',
    ]);
    expect(body.window.members.length).toBeGreaterThan(0);
    expect(body.window.workflow.statuses.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(body.readAt))).toBe(false);
  });

  it('answers every one of the eight tabs with its own window shape', async () => {
    for (const tab of WORKBENCH_TABS) {
      const res = await read(`?tab=${tab}`);
      expect(res.status, tab).toBe(200);
      const body = (await res.json()) as WorkbenchWindowDto;
      expect(body.tab).toBe(tab);
      const expected =
        tab === 'approvals' ? 'approvals' : tab === 'planning' ? 'planning' : 'workItems';
      expect(body.window.kind, tab).toBe(expected);
    }
  });

  it('refuses an unauthenticated reader with 401', async () => {
    workspaceCtx.current = null;
    const res = await read('?tab=todo');
    expect(res.status).toBe(401);
  });

  it('refuses an unknown or missing tab with a typed 400, not the landing redirect', async () => {
    for (const query of ['?tab=nonsense', '', '?tab=']) {
      const res = await read(query);
      expect(res.status, query).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_TAB' });
    }
  });

  it('never returns a row the same tab on /workbench would not — another project stays out', async () => {
    await card('In the active project');
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTH',
    });
    await card('In a project the reader is not looking at', other.id);

    const body = (await (await read('?tab=todo')).json()) as WorkbenchWindowDto;
    if (body.window.kind !== 'workItems') throw new Error('unreachable');
    const page = await homeService.listToDo(actor(), { page: 1 });
    expect(body.window.page.items.map((i) => i.id)).toEqual(page.items.map((i) => i.id));
    expect(body.window.page.items.map((i) => i.title)).toEqual(['In the active project']);
  });

  it('clamps a page beyond the last page exactly as the page does', async () => {
    await card('Only row');
    const body = (await (await read('?tab=todo&page=99')).json()) as WorkbenchWindowDto;
    if (body.window.kind !== 'workItems') throw new Error('unreachable');
    const clamped = await homeService.listToDo(actor(), { page: 99 });
    expect(body.window.page.page).toBe(clamped.page);
    expect(body.window.page.page).toBe(1);
  });
});
