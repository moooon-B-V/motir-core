import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';
import { workbenchWindowService } from '@/lib/services/workbenchWindowService';
import { homeService } from '@/lib/services/homeService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { workItemsService } from '@/lib/services/workItemsService';

// workbenchWindowService (Story MOTIR-8539 · Subtask MOTIR-8573) — the ONE
// pairing of a Workbench tab's window with the strip's counts, shared by the
// page's first paint and `GET /api/workbench/window`.

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'WWS' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const actor = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId });

describe('workbenchWindowService.read', () => {
  it('pairs a work-item tab with the strip counts the page renders', async () => {
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Waiting to start', assigneeId: fx.ownerId },
      fx.ctx,
    );
    const read = await workbenchWindowService.read(actor(), { tab: 'todo', page: 1 });
    expect(read.counts).toEqual(await homeService.tabCounts(actor()));
    if (read.window.kind !== 'workItems') throw new Error('expected a work-item window');
    expect(read.window.page.total).toBe(read.counts.toDo);
    expect(read.window.page.items.map((i) => i.title)).toEqual(['Waiting to start']);
  });

  it('answers To approve from the same queue read `<ApprovalsTab>` makes', async () => {
    const read = await workbenchWindowService.read(actor(), { tab: 'approvals', page: 1 });
    if (read.window.kind !== 'approvals') throw new Error('expected the approvals window');
    expect(read.window.queue).toEqual(await approvalGatesService.listAwaitingMe(actor()));
    expect(read.counts).toEqual(await homeService.tabCounts(actor()));
  });

  it('answers Planning with page 1 at the tab ceiling', async () => {
    const read = await workbenchWindowService.read(actor(), { tab: 'planning', page: 7 });
    if (read.window.kind !== 'planning') throw new Error('expected the planning window');
    expect(read.window.page.page).toBe(1);
    expect(read.counts.planning).toBe(read.window.page.total);
  });

  it('`readCounts` is the strip counts alone', async () => {
    expect(await workbenchWindowService.readCounts(actor())).toEqual(
      await homeService.tabCounts(actor()),
    );
  });
});

describe('ONE pairing in the codebase', () => {
  /** A file with its comments removed — the prose names the calls it explains. */
  function code(relative: string): string {
    return readFileSync(path.resolve(__dirname, '../..', relative), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
  }

  it('the page renders its work-item tabs from the service the route answers from', () => {
    const page = code('app/(authed)/workbench/page.tsx');
    const route = code('app/api/workbench/window/route.ts');
    expect(page).toContain('workbenchWindowService.read(');
    expect(route).toContain('workbenchWindowService.read(');
    // No second pairing in the page: no list read of its own, and `tabCounts`
    // only on the landing redirect (a tab-less request that renders nothing).
    expect(page).not.toMatch(/homeService\.list[A-Z]/);
    expect(page.match(/tabCounts\(/g) ?? []).toHaveLength(1);
    expect(page).toMatch(
      /if \(tab === null\) \{\s*const landingCounts = await homeService\.tabCounts\(ctx\);/,
    );
  });

  it('the service holds the only `Promise.all` that pairs a window with the counts', () => {
    const service = code('lib/services/workbenchWindowService.ts');
    expect(service.match(/homeService\.tabCounts\(ctx\)/g) ?? []).toHaveLength(3);
    expect(service).toMatch(
      /Promise\.all\(\[\s*readWorkItemTab\(tab, ctx, page\),\s*homeService\.tabCounts\(ctx\)/,
    );
  });
});
