import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Attachment, AttachmentSource } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  attachmentRepository,
  LIFECYCLE_OWNED_SOURCES,
} from '@/lib/repositories/attachmentRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// `acceptance_trace` belongs to the acceptance panel, not the attachments panel
// (MOTIR-3085).
//
// ⚠️ REPRODUCED BEFORE IT WAS FIXED, and the numbers are worth keeping: against
// `origin/main` this exact fixture returned `listed=1, count=1,
// sources=['acceptance_trace']`. The defect was not inferred from the schema
// comment — the comment is what made it worth looking, and the query is what
// proved it.
//
// The intent was never in doubt once both sides were read. MOTIR-1674 gave the
// trace an Attachment row for ONE reason — so it could be SERVED through the
// authenticated content path — and said nothing about listing it. Its sibling
// `acceptance_video`, same lifecycle and same panel, was excluded from the
// start. So the comment stated the intent and the query had simply never
// carried it.

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(truncateAll);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeAttachment(
  fx: WorkItemFixture,
  workItemId: string | null,
  source: AttachmentSource,
  overrides: { createdAt?: Date } = {},
): Promise<Attachment> {
  return adminDb.attachment.create({
    data: {
      workspaceId: fx.workspaceId,
      uploaderUserId: fx.ownerId,
      source,
      blobPathname: `acceptance/${fx.workspaceId}/${source}`,
      mimeType: source === 'acceptance_trace' ? 'application/zip' : 'video/webm',
      sizeBytes: 4,
      originalFilename: source === 'acceptance_trace' ? 'trace.zip' : 'clip.webm',
      ...(workItemId === null ? {} : { workItemId }),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

describe('a story’s acceptance trace stays out of the attachments panel', () => {
  it('a LINKED trace row is in neither the listing nor the count', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    await makeAttachment(fx, story.id, 'acceptance_trace');

    const [listed, count] = await withWorkspaceServiceContext(fx.workspaceId, async (tx) => [
      await attachmentRepository.listByWorkItem(story.id, {}, tx),
      await attachmentRepository.countByWorkItem(story.id, tx),
    ]);

    expect(listed).toHaveLength(0);
    // The count is the badge over the same panel. Before the fix this returned
    // 1 while a reader saw a `.zip` they had no use for.
    expect(count).toBe(0);
  });

  it('sits beside its VIDEO — the whole recording is one lifecycle, one panel', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    await makeAttachment(fx, story.id, 'acceptance_video');
    await makeAttachment(fx, story.id, 'acceptance_trace');
    // …while an ordinary attachment on the same story is unaffected.
    const ordinary = await makeAttachment(fx, story.id, 'panel');

    const [listed, count] = await withWorkspaceServiceContext(fx.workspaceId, async (tx) => [
      await attachmentRepository.listByWorkItem(story.id, {}, tx),
      await attachmentRepository.countByWorkItem(story.id, tx),
    ]);

    expect(listed.map((a) => a.id)).toEqual([ordinary.id]);
    expect(count).toBe(1);
  });

  it('the exclusion is DATA-only — the row, its blob and its FK are untouched', async () => {
    // Hiding it from a panel must not make it unreachable: the acceptance panel
    // still renders it, and `AcceptanceEvidence.traceAttachmentId` still points
    // at a live row.
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    const trace = await makeAttachment(fx, story.id, 'acceptance_trace');

    const row = await adminDb.attachment.findUnique({ where: { id: trace.id } });
    expect(row).not.toBeNull();
    expect(row!.workItemId).toBe(story.id);
    expect(row!.blobPathname).toBe(trace.blobPathname);
  });

  it('a LINKED trace is still spared by the orphan-GC — confirmed, not assumed', async () => {
    // `listOrphans` reads rows whose `workItemId` is NULL and whose `createdAt`
    // predates the safety window, so a linked trace was never GC-eligible and
    // this change cannot have altered that. The card asked for it to be
    // CONFIRMED rather than reasoned about, so: an unlinked trace past the
    // window is collectable, a linked one is not.
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const linked = await makeAttachment(fx, story.id, 'acceptance_trace', { createdAt: longAgo });
    const orphan = await makeAttachment(fx, null, 'acceptance_trace', { createdAt: longAgo });

    const orphans = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      attachmentRepository.listOrphans({ olderThan: new Date(), take: 50 }, tx),
    );
    const ids = orphans.map((o) => o.id);

    expect(ids).toContain(orphan.id);
    expect(ids).not.toContain(linked.id);
  });
});

describe('the schema comment and the query now agree', () => {
  it('`acceptance_trace` is in the one predicate both panel queries use', () => {
    expect(LIFECYCLE_OWNED_SOURCES).toContain('acceptance_trace');
  });
});
