import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Attachment, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';

// attachmentRepository — the Subtask 5.2.1 link/management leaves, against a
// REAL Postgres (no-mocks rule). Surfaces under test: the `workItemId` link
// lifecycle (SetNull on issue delete — NOT cascade: the row must survive,
// unlinked, for the 5.2.7 GC to retire its blob), the `source` backfill
// default, the paged panel read, the workspace-scoped URL lookup, link/unlink,
// delete, and the orphan-GC read — plus the empty-input guards on every new
// method (the coverage-gate discipline).

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE "attachment", "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
}

beforeEach(truncateAll);
afterAll(async () => {
  await db.$disconnect();
});

/** Insert an attachment row directly (test setup — the legitimate cross-layer reach). */
async function makeAttachment(
  fx: WorkItemFixture,
  overrides: Partial<{
    workItemId: string | null;
    blobUrl: string;
    createdAt: Date;
    source: 'editor' | 'panel';
  }> = {},
): Promise<Attachment> {
  return db.attachment.create({
    data: {
      workspaceId: fx.workspaceId,
      uploaderUserId: fx.ownerId,
      blobUrl: overrides.blobUrl ?? `https://blob.example/attachments/${fx.workspaceId}/f.png`,
      mimeType: 'image/png',
      sizeBytes: 4,
      originalFilename: 'f.png',
      ...(overrides.workItemId !== undefined ? { workItemId: overrides.workItemId } : {}),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      ...(overrides.source ? { source: overrides.source } : {}),
    },
  });
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe('attachment.workItemId schema (5.2.1)', () => {
  it('hard-deleting the issue SETS NULL — the row survives unlinked (GC-eligible), never cascades', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Doomed' });
    const att = await makeAttachment(fx, { workItemId: issue.id });

    await db.workItem.delete({ where: { id: issue.id } });

    const survivor = await db.attachment.findUnique({ where: { id: att.id } });
    expect(survivor).not.toBeNull();
    expect(survivor!.workItemId).toBeNull();
  });

  it("`source` defaults to 'editor' — the backfill stamp for every pre-5.2 row (the 2.3.7 write path sets no source)", async () => {
    const fx = await makeWorkItemFixture();
    const att = await makeAttachment(fx); // no source supplied, like 2.3.7's create
    expect(att.source).toBe('editor');
    expect(att.workItemId).toBeNull(); // rows are born unlinked
  });
});

describe('attachmentRepository.listByWorkItem / countByWorkItem', () => {
  it('returns only the issue’s rows, newest first, and pages via cursor without repeats', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    const other = await createTestWorkItem(fx, { kind: 'task', title: 'Other' });

    const old = await makeAttachment(fx, { workItemId: issue.id, createdAt: daysAgo(3) });
    const mid = await makeAttachment(fx, { workItemId: issue.id, createdAt: daysAgo(2) });
    const fresh = await makeAttachment(fx, { workItemId: issue.id, createdAt: daysAgo(1) });
    await makeAttachment(fx, { workItemId: other.id }); // foreign issue — never listed

    const page1 = await attachmentRepository.listByWorkItem(issue.id, { take: 2 });
    expect(page1.map((a) => a.id)).toEqual([fresh.id, mid.id]);

    const page2 = await attachmentRepository.listByWorkItem(issue.id, {
      take: 2,
      cursor: page1[1]!.id,
    });
    expect(page2.map((a) => a.id)).toEqual([old.id]); // cursor row skipped, no repeat

    expect(await attachmentRepository.countByWorkItem(issue.id)).toBe(3);
    expect(await attachmentRepository.countByWorkItem(other.id)).toBe(1);
  });
});

describe('attachmentRepository.findManyByBlobUrls', () => {
  it('resolves only OWN-workspace rows — a foreign workspace’s URL never resolves', async () => {
    const fx = await makeWorkItemFixture();
    const foreign = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });

    const mine = await makeAttachment(fx, { blobUrl: 'https://blob.example/a/mine.png' });
    await makeAttachment(foreign, { blobUrl: 'https://blob.example/a/theirs.png' });

    const found = await attachmentRepository.findManyByBlobUrls(fx.workspaceId, [
      'https://blob.example/a/mine.png',
      'https://blob.example/a/theirs.png', // foreign — must not resolve
      'https://blob.example/a/nonexistent.png',
    ]);
    expect(found.map((a) => a.id)).toEqual([mine.id]);
  });

  it('empty-input guard: [] short-circuits to [] without a query', async () => {
    const fx = await makeWorkItemFixture();
    await makeAttachment(fx);
    expect(await attachmentRepository.findManyByBlobUrls(fx.workspaceId, [])).toEqual([]);
  });
});

describe('attachmentRepository.linkToWorkItem / unlinkFromWorkItem', () => {
  it('links rows with the given source, unlinks them leaving source intact', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Target' });
    const a = await makeAttachment(fx);
    const b = await makeAttachment(fx, { blobUrl: 'https://blob.example/a/b.png' });

    const linked = await db.$transaction((tx) =>
      attachmentRepository.linkToWorkItem([a.id, b.id], issue.id, 'panel', tx),
    );
    expect(linked).toBe(2);

    const rows = await attachmentRepository.listByWorkItem(issue.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === 'panel')).toBe(true);

    const unlinked = await db.$transaction((tx) =>
      attachmentRepository.unlinkFromWorkItem([a.id], tx),
    );
    expect(unlinked).toBe(1);

    const aRow = await db.attachment.findUnique({ where: { id: a.id } });
    expect(aRow!.workItemId).toBeNull();
    expect(aRow!.source).toBe('panel'); // source records how it ENTERED, not link state
    expect(await attachmentRepository.countByWorkItem(issue.id)).toBe(1);
  });

  it('empty-input guards: [] is a no-op returning 0 for both link and unlink', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Idle' });
    await db.$transaction(async (tx) => {
      expect(await attachmentRepository.linkToWorkItem([], issue.id, 'editor', tx)).toBe(0);
      expect(await attachmentRepository.unlinkFromWorkItem([], tx)).toBe(0);
    });
  });
});

describe('attachmentRepository.delete', () => {
  it('hard-deletes the row (no tombstone)', async () => {
    const fx = await makeWorkItemFixture();
    const att = await makeAttachment(fx);
    await db.$transaction((tx) => attachmentRepository.delete(att.id, tx));
    expect(await db.attachment.findUnique({ where: { id: att.id } })).toBeNull();
  });
});

describe('attachmentRepository.listOrphans', () => {
  it('returns only UNLINKED rows older than the window, oldest first, cursor-bounded', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Linked holder' });

    const oldest = await makeAttachment(fx, { createdAt: daysAgo(30) });
    const older = await makeAttachment(fx, { createdAt: daysAgo(10) });
    await makeAttachment(fx, { createdAt: daysAgo(1) }); // unlinked but INSIDE the window
    await makeAttachment(fx, { workItemId: issue.id, createdAt: daysAgo(30) }); // linked — never swept

    const page1 = await attachmentRepository.listOrphans({ olderThan: daysAgo(7), take: 1 });
    expect(page1.map((a) => a.id)).toEqual([oldest.id]);

    const page2 = await attachmentRepository.listOrphans({
      olderThan: daysAgo(7),
      take: 1,
      cursor: page1[0]!.id,
    });
    expect(page2.map((a) => a.id)).toEqual([older.id]);

    const page3 = await attachmentRepository.listOrphans({
      olderThan: daysAgo(7),
      take: 1,
      cursor: page2[0]!.id,
    });
    expect(page3).toEqual([]); // bounded walk terminates — nothing beyond the window
  });
});

// RLS proof for the 5.2.1 policy swap (attachment_active_workspace →
// attachment_workspace_or_system_admin). The dev/CI DB connects as the
// `prodect` superuser (BYPASSRLS — PRODECT_FINDINGS #5), so each assertion
// runs under `SET LOCAL ROLE prodect_app` (NOSUPERUSER NOBYPASSRLS), the
// asAppRole idiom from tests/workspace-rls.test.ts.
async function asAppRole<T>(
  guc: { workspaceId?: string; systemAdmin?: boolean },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (guc.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${guc.workspaceId}, true)`;
    }
    if (guc.systemAdmin) {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('attachment RLS — the 5.2.1 policy swap', () => {
  it('tenant gate is UNCHANGED: no context hides everything; the workspace GUC scopes to own rows only', async () => {
    const fx = await makeWorkItemFixture();
    const foreign = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });
    const mine = await makeAttachment(fx);
    await makeAttachment(foreign, { blobUrl: 'https://blob.example/a/theirs.png' });

    const blind = await asAppRole({}, (tx) => tx.attachment.findMany());
    expect(blind).toEqual([]);

    const scoped = await asAppRole({ workspaceId: fx.workspaceId }, (tx) =>
      tx.attachment.findMany(),
    );
    expect(scoped.map((a) => a.id)).toEqual([mine.id]);
  });

  it('the system_admin hatch admits the context-less GC: listOrphans sees ACROSS workspaces and delete passes', async () => {
    const fx = await makeWorkItemFixture();
    const foreign = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });
    const orphanA = await makeAttachment(fx, { createdAt: daysAgo(30) });
    const orphanB = await makeAttachment(foreign, {
      blobUrl: 'https://blob.example/a/theirs.png',
      createdAt: daysAgo(30),
    });

    // The GC read: no workspace context, system_admin bound — both tenants' orphans visible.
    const swept = await asAppRole({ systemAdmin: true }, (tx) =>
      attachmentRepository.listOrphans({ olderThan: daysAgo(7) }, tx),
    );
    expect(swept.map((a) => a.id).sort()).toEqual([orphanA.id, orphanB.id].sort());

    // The GC write: the hatch's WITH CHECK / USING admits the row delete too.
    await asAppRole({ systemAdmin: true }, (tx) => attachmentRepository.delete(orphanA.id, tx));
    expect(await db.attachment.findUnique({ where: { id: orphanA.id } })).toBeNull();
  });
});

describe('2.3.7 upload path is untouched', () => {
  it('attachmentRepository.create still inserts an unlinked row with the unchanged input shape', async () => {
    const fx = await makeWorkItemFixture();
    const row = await db.$transaction((tx) =>
      attachmentRepository.create(
        {
          workspaceId: fx.workspaceId,
          uploaderUserId: fx.ownerId,
          blobUrl: 'https://blob.example/attachments/x/y.png',
          mimeType: 'image/png',
          sizeBytes: 9,
          originalFilename: 'y.png',
        },
        tx,
      ),
    );
    expect(row.workItemId).toBeNull();
    expect(row.source).toBe('editor');
  });
});
