import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { StaleWorkItemError, WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { UpdateWorkItemInput } from '@/lib/dto/workItems';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';

// Service-layer coverage for the edit form (Subtask 2.3.6): the finding-#46
// status-removal guard, optimistic concurrency (StaleWorkItemError), the
// identifier read backing the route, and the two-action revision trail. Real
// Postgres.

// COMPILE-TIME guard: `status` is not a key of UpdateWorkItemInput. If it ever
// reappears, this type evaluates to 'HAS_STATUS' and the assignment fails to
// compile — finding #46 can't silently regress.
type StatusGuard = 'status' extends keyof UpdateWorkItemInput ? 'HAS_STATUS' : 'ok';
const _statusGuard: StatusGuard = 'ok';
void _statusGuard;

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('finding #46 — updateWorkItem no longer carries status', () => {
  it('the service body has no status write path (runtime grep guard)', () => {
    const src = readFileSync('lib/services/workItemsService.ts', 'utf8');
    expect(src).not.toMatch(/patch\.status/);
    expect(src).not.toMatch(/update\.status\s*=/);
  });
});

describe('workItemsService.getWorkItemByIdentifier', () => {
  it('resolves by identifier; cross-workspace 404s', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Find me' },
      fx.ctx,
    );
    const got = await workItemsService.getWorkItemByIdentifier(
      fx.projectId,
      created.identifier,
      fx.ctx,
    );
    expect(got.id).toBe(created.id);

    await expect(
      workItemsService.getWorkItemByIdentifier(fx.projectId, created.identifier, {
        userId: fx.ctx.userId,
        workspaceId: 'another-workspace',
      }),
    ).rejects.toThrow(WorkItemNotFoundError);
  });
});

describe('updateWorkItem — optimistic concurrency (2.3.6)', () => {
  it('rejects a stale updatedAt with StaleWorkItemError, accepts the current one', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Orig' },
      fx.ctx,
    );
    const staleToken = created.updatedAt;

    // Someone else edits the row → updatedAt moves.
    await db.workItem.update({ where: { id: created.id }, data: { title: 'Theirs' } });

    await expect(
      workItemsService.updateWorkItem(created.id, { title: 'Mine' }, fx.ctx, {
        expectedUpdatedAt: staleToken,
      }),
    ).rejects.toThrow(StaleWorkItemError);

    // With the CURRENT token it succeeds.
    const fresh = await workItemsService.getWorkItem(created.id, fx.ctx);
    const ok = await workItemsService.updateWorkItem(created.id, { title: 'Mine' }, fx.ctx, {
      expectedUpdatedAt: fresh.updatedAt,
    });
    expect(ok.title).toBe('Mine');
  });

  it('without a token, updates unconditionally (last-write-wins)', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A' },
      fx.ctx,
    );
    const ok = await workItemsService.updateWorkItem(created.id, { title: 'B' }, fx.ctx);
    expect(ok.title).toBe('B');
  });
});

describe('edit form revision trail (2.3.6)', () => {
  it('a title edit + a status change produce TWO revision rows (one per action path)', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A' },
      fx.ctx,
    );
    const before = (await workItemsService.listRevisions(created.id, fx.ctx)).length;

    // Non-status path.
    await workItemsService.updateWorkItem(created.id, { title: 'B' }, fx.ctx);
    // Gated status path — todo → in_progress is a legal default transition.
    await workItemsService.updateStatus(created.id, 'in_progress', fx.ctx);

    const after = await workItemsService.listRevisions(created.id, fx.ctx);
    expect(after.length).toBe(before + 2);
    const top2 = after.slice(0, 2).map((r) => JSON.stringify(r.diff));
    expect(top2.some((d) => d.includes('status'))).toBe(true);
    expect(top2.some((d) => d.includes('title'))).toBe(true);
  });
});
