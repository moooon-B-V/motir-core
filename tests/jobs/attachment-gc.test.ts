import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '@prisma/client';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { defineJob } from '@/lib/jobs/defineJob';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';

// system.attachment-gc (Subtask 5.2.7) — the orphan-attachment sweep, driven
// IN-PROCESS via @inngest/test against a REAL Postgres (no-mocks rule). The
// Blob adapter is the ONE mocked external (the 2.3.7 test's pattern), which is
// also the failure-injection seam: a rejecting `deleteAttachmentBlob` is the
// "blob store is down / the URL is unreachable" case the blob-then-row
// ordering exists for. Under test: the window (old orphans swept, young
// orphans + linked rows untouched), the blob-then-row failure contract (a
// failed blob delete leaves the row for the NEXT RUN — attempted once per
// run, not once per batch), idempotent re-run convergence (the 5.2.2
// post-commit-failure backstop), cursor-bounded paging incl. the per-run cap
// and the failed-row cursor anchor, and the run summary persisted on the
// job_run ledger row's `output` column.

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}` })),
  deleteAttachmentBlob: vi.fn(async () => undefined),
}));

const { deleteAttachmentBlob } = await import('@/lib/blob/uploader');
const blobDelete = vi.mocked(deleteAttachmentBlob);
const { attachmentGc, ATTACHMENT_GC_CRON } = await import('@/lib/jobs/definitions/attachmentGc');
const { attachmentsService } = await import('@/lib/services/attachmentsService');
const { jobFunctions } = await import('@/lib/jobs/registry');

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE "attachment", "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  await truncateJobRuns();
}

beforeEach(async () => {
  await truncateAll();
  blobDelete.mockReset();
  blobDelete.mockResolvedValue(undefined);
});

afterAll(async () => {
  await db.$disconnect();
});

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/** Insert an attachment row directly (test setup — the legitimate cross-layer reach). */
async function makeAttachment(
  fx: WorkItemFixture,
  overrides: Partial<{ workItemId: string | null; blobUrl: string; createdAt: Date }> = {},
): Promise<Attachment> {
  return db.attachment.create({
    data: {
      workspaceId: fx.workspaceId,
      uploaderUserId: fx.ownerId,
      blobUrl:
        overrides.blobUrl ??
        `https://blob.example/attachments/${fx.workspaceId}/${crypto.randomUUID()}.png`,
      mimeType: 'image/png',
      sizeBytes: 4,
      originalFilename: 'f.png',
      ...(overrides.workItemId !== undefined ? { workItemId: overrides.workItemId } : {}),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

const exists = async (id: string) => (await db.attachment.findUnique({ where: { id } })) !== null;

describe('the scheduled sweep (in-process Inngest run)', () => {
  it('sweeps old orphans blob-then-row; never touches young orphans or linked rows; persists the summary on the ledger row', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    const linked = await makeAttachment(fx, { workItemId: issue.id, createdAt: daysAgo(30) });
    const young = await makeAttachment(fx, { createdAt: daysAgo(1) });
    const old = await makeAttachment(fx, { createdAt: daysAgo(8) });

    const engine = new InngestTestEngine({ function: attachmentGc });
    const { result } = await engine.execute();

    expect(result).toEqual({ scanned: 1, deleted: 1, failed: 0 });
    expect(await exists(old.id)).toBe(false);
    expect(await exists(young.id)).toBe(true);
    expect(await exists(linked.id)).toBe(true);
    // Exactly the old orphan's blob was deleted — nothing else's.
    expect(blobDelete.mock.calls).toEqual([[old.blobUrl]]);

    // The ledger: one succeeded, untenanted, scheduled-named run carrying the
    // summary in `output` (the 5.2.7 column).
    const runs = await db.jobRun.findMany();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.functionId).toBe('system.attachment-gc');
    expect(run.eventName).toBe('scheduled.system.attachment-gc');
    expect(run.status).toBe('succeeded');
    expect(run.workspaceId).toBeNull();
    expect(run.output).toEqual({ scanned: 1, deleted: 1, failed: 0 });
  });

  it('a failed blob delete leaves the row (blob-then-row, attempted once per run); the next run sweeps it — the 5.2.2 backstop contract', async () => {
    const fx = await makeWorkItemFixture();
    const failing = await makeAttachment(fx, { createdAt: daysAgo(9) });
    const fine = await makeAttachment(fx, { createdAt: daysAgo(8) });
    blobDelete.mockImplementation(async (url: string) => {
      if (url === failing.blobUrl) throw new Error('blob store down');
    });

    const engine = new InngestTestEngine({ function: attachmentGc });
    const first = await engine.execute();
    expect(first.result).toEqual({ scanned: 2, deleted: 1, failed: 1 });
    expect(await exists(failing.id)).toBe(true); // row survives = the retry marker
    expect(await exists(fine.id)).toBe(false);
    // Attempted ONCE this run — the `attempted` guard, not batch-loop hammering.
    expect(blobDelete.mock.calls.filter(([url]) => url === failing.blobUrl)).toHaveLength(1);

    // The store recovers → the next run converges (idempotent re-run).
    blobDelete.mockReset();
    blobDelete.mockResolvedValue(undefined);
    const second = await new InngestTestEngine({ function: attachmentGc }).execute();
    expect(second.result).toEqual({ scanned: 1, deleted: 1, failed: 0 });
    expect(await exists(failing.id)).toBe(false);
  });
});

describe('attachmentsService.sweepOrphanAttachments — paging bounds', () => {
  it('no orphans → zero summary, zero blob calls', async () => {
    const summary = await attachmentsService.sweepOrphanAttachments();
    expect(summary).toEqual({ scanned: 0, deleted: 0, failed: 0 });
    expect(blobDelete).not.toHaveBeenCalled();
  });

  it('walks the backlog in cursor-bounded batches and stops at the per-run cap; the next run finishes the remainder', async () => {
    const fx = await makeWorkItemFixture();
    for (let i = 0; i < 5; i++) await makeAttachment(fx, { createdAt: daysAgo(10 + i) });

    const capped = await attachmentsService.sweepOrphanAttachments({
      batchSize: 2,
      maxBatchesPerRun: 2,
    });
    expect(capped).toEqual({ scanned: 4, deleted: 4, failed: 0 });
    expect(await db.attachment.count()).toBe(1); // backlog never an unbounded run

    const rest = await attachmentsService.sweepOrphanAttachments({
      batchSize: 2,
      maxBatchesPerRun: 2,
    });
    expect(rest).toEqual({ scanned: 1, deleted: 1, failed: 0 });
    expect(await db.attachment.count()).toBe(0);
  });

  it('a failing front row anchors the cursor so deeper orphans are still reached in the same run', async () => {
    const fx = await makeWorkItemFixture();
    // Oldest first is the sweep order — r1 (the failing row) leads every page.
    const r1 = await makeAttachment(fx, { createdAt: daysAgo(12) });
    const r2 = await makeAttachment(fx, { createdAt: daysAgo(11) });
    const r3 = await makeAttachment(fx, { createdAt: daysAgo(10) });
    blobDelete.mockImplementation(async (url: string) => {
      if (url === r1.blobUrl) throw new Error('still down');
    });

    const summary = await attachmentsService.sweepOrphanAttachments({ batchSize: 1 });
    expect(summary).toEqual({ scanned: 3, deleted: 2, failed: 1 });
    expect(await exists(r1.id)).toBe(true);
    expect(await exists(r2.id)).toBe(false);
    expect(await exists(r3.id)).toBe(false);
  });
});

// LAST on purpose: the cron-config probe registers a second function under
// the same id on the shared Inngest client, which would shadow the real
// attachmentGc for any LATER InngestTestEngine run in this file.
describe('system.attachment-gc wiring', () => {
  it('is mounted in the serve registry', () => {
    expect(jobFunctions).toContain(attachmentGc);
  });

  it('wires the cron expression into the Inngest function config', () => {
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob({ id: 'system.attachment-gc', cron: ATTACHMENT_GC_CRON }, () => undefined);
      const config = spy.mock.calls.at(-1)?.[0] as
        | { triggers?: Array<{ cron?: string }> }
        | undefined;
      expect(config?.triggers).toEqual([{ cron: '30 3 * * *' }]);
    } finally {
      spy.mockRestore();
    }
  });
});
