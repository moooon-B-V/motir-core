import { afterAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { resetDatabase } from '@/tests/e2e/_helpers/db-reset';
import { makeWorkItemFixture } from '@/tests/fixtures';
import { workItemsService } from '@/lib/services/workItemsService';

// DB-reset CASCADE audit (Subtask 1.4.8). The Playwright suite's
// `resetDatabase()` truncates only the auth-root tables (user / workspace /
// session / account / verification). work_item, work_item_link, and
// work_item_revision all FK to workspace (and user), so they must cascade-
// truncate with those roots — otherwise a work-item row from one spec could
// leak into the next. This test PROVES the cascade empirically, so the next
// reader doesn't have to wonder whether resetDatabase() needs a work-item
// sibling. Verdict: it does NOT — the FK CASCADE is sufficient; resetDatabase()
// is unchanged.

afterAll(async () => {
  await db.$disconnect();
});

describe('resetDatabase() clears work-item tables via FK CASCADE', () => {
  it('removes work_item / work_item_link / work_item_revision rows', async () => {
    const fx = await makeWorkItemFixture();
    const x = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'X' },
      fx.ctx,
    );
    const y = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Y' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: x.id, toId: y.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    // Sanity: rows exist before the reset.
    expect(await db.workItem.count()).toBeGreaterThan(0);
    expect(await db.workItemLink.count()).toBeGreaterThan(0);
    expect(await db.workItemRevision.count()).toBeGreaterThan(0);

    await resetDatabase();

    // Cascade verdict: every work-item table is empty after truncating auth roots.
    expect(await db.workItem.count()).toBe(0);
    expect(await db.workItemLink.count()).toBe(0);
    expect(await db.workItemRevision.count()).toBe(0);
  });
});
