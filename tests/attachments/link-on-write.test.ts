import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { attachmentContentPath } from '@/lib/blob/referencedUrls';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Link-on-write integration tests (Story 5.2 · Subtask 5.2.3) against a REAL
// Postgres: the embeds-are-attachments rule across every body-write path —
// workItemsService create/update (description + explanation) and
// commentsService add/edit/delete — asserting row link state, the `source`
// stamp, the revision trail, and the four never-touch guards (foreign URL,
// foreign workspace, cross-issue row, panel-sourced row). The Inngest client
// is the one stubbed external (the tests/helpers/jobs.ts pattern).

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "attachment" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

let uploadSeq = 0;

/** An editor upload as 2.3.7 writes it: an UNLINKED private row (a pathname; no
 *  public URL). Embeds reference it by its content path `attachmentContentPath(id)`. */
async function createUpload(
  fx: Pick<WorkItemFixture, 'workspaceId' | 'ownerId'>,
  filename: string,
): Promise<Attachment> {
  uploadSeq += 1;
  const blobPathname = `attachments/${fx.workspaceId}/${filename}-${uploadSeq}`;
  return db.$transaction((tx: Prisma.TransactionClient) =>
    attachmentRepository.create(
      {
        workspaceId: fx.workspaceId,
        uploaderUserId: fx.ownerId,
        blobPathname,
        mimeType: 'image/png',
        sizeBytes: 4,
        originalFilename: filename,
      },
      tx,
    ),
  );
}

const reloaded = (id: string) => db.attachment.findUniqueOrThrow({ where: { id } });

const updatedRevisions = (workItemId: string) =>
  db.workItemRevision.findMany({
    where: { workItemId, changeKind: 'updated' },
    orderBy: { changedAt: 'asc' },
  });

const attachmentsDiffOf = (rev: { diff: unknown }) =>
  (rev.diff as { attachments?: { added?: unknown[]; removed?: unknown[] } }).attachments;

async function createIssue(fx: WorkItemFixture, body?: { descriptionMd?: string }) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Link target', ...body },
    fx.ctx,
  );
}

describe('createWorkItem — link-on-write', () => {
  it('links an upload embedded in the birth description (source editor), no extra revision', async () => {
    const fx = await makeWorkItemFixture();
    const upload = await createUpload(fx, 'shot.png');

    const dto = await createIssue(fx, {
      descriptionMd: `Look: ![shot](${attachmentContentPath(upload.id)})`,
    });

    const row = await reloaded(upload.id);
    expect(row.workItemId).toBe(dto.id);
    expect(row.source).toBe('editor');
    // The 'created' anchor is the History record — no separate attachments entry.
    expect(await updatedRevisions(dto.id)).toHaveLength(0);
  });

  it('a cancelled create modal leaves the upload unlinked (GC-eligible)', async () => {
    const fx = await makeWorkItemFixture();
    const upload = await createUpload(fx, 'stray.png');
    // No createWorkItem call — the modal never submitted.
    expect((await reloaded(upload.id)).workItemId).toBeNull();
  });

  it("never links a foreign URL or another workspace's upload", async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
    const foreignRow = await createUpload(other, 'foreign.png');

    const dto = await createIssue(fx, {
      descriptionMd: `![leak](${attachmentContentPath(foreignRow.id)}) and [site](https://example.com/a.png)`,
    });

    expect((await reloaded(foreignRow.id)).workItemId).toBeNull();
    expect(await db.attachment.count({ where: { workItemId: dto.id } })).toBe(0);
  });
});

describe('updateWorkItem — link-on-write', () => {
  it('links a newly-embedded upload and records it on the SAME updated revision', async () => {
    const fx = await makeWorkItemFixture();
    const dto = await createIssue(fx);
    const upload = await createUpload(fx, 'added.png');

    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: `now ![added](${attachmentContentPath(upload.id)})` },
      fx.ctx,
    );

    const row = await reloaded(upload.id);
    expect(row.workItemId).toBe(dto.id);
    expect(row.source).toBe('editor');

    const revs = await updatedRevisions(dto.id);
    expect(revs).toHaveLength(1);
    const cell = attachmentsDiffOf(revs[0]!);
    expect(cell?.added).toEqual([{ attachmentId: upload.id, name: 'added.png', source: 'editor' }]);
    expect((revs[0]!.diff as Record<string, unknown>)['descriptionMd']).toBeDefined();
  });

  it('an embed in the EXPLANATION links too', async () => {
    const fx = await makeWorkItemFixture();
    const dto = await createIssue(fx);
    const upload = await createUpload(fx, 'expl.png');

    await workItemsService.updateWorkItem(
      dto.id,
      { explanationMd: `why: ![expl](${attachmentContentPath(upload.id)})` },
      fx.ctx,
    );

    expect((await reloaded(upload.id)).workItemId).toBe(dto.id);
  });

  it('unlinks a de-referenced editor row (GC-eligible) and records the removal', async () => {
    const fx = await makeWorkItemFixture();
    const upload = await createUpload(fx, 'gone.png');
    const dto = await createIssue(fx, {
      descriptionMd: `![gone](${attachmentContentPath(upload.id)})`,
    });

    await workItemsService.updateWorkItem(dto.id, { descriptionMd: 'embed removed' }, fx.ctx);

    expect((await reloaded(upload.id)).workItemId).toBeNull();
    const revs = await updatedRevisions(dto.id);
    expect(revs).toHaveLength(1);
    expect(attachmentsDiffOf(revs[0]!)?.removed).toEqual([
      { attachmentId: upload.id, name: 'gone.png', source: 'editor' },
    ]);
  });

  it('keeps a row linked while the OTHER body still references it', async () => {
    const fx = await makeWorkItemFixture();
    const upload = await createUpload(fx, 'both.png');
    const dto = await createIssue(fx, {
      descriptionMd: `![x](${attachmentContentPath(upload.id)})`,
    });
    await workItemsService.updateWorkItem(
      dto.id,
      { explanationMd: `also ![x](${attachmentContentPath(upload.id)})` },
      fx.ctx,
    );

    await workItemsService.updateWorkItem(dto.id, { descriptionMd: 'desc cleared' }, fx.ctx);

    expect((await reloaded(upload.id)).workItemId).toBe(dto.id);
  });

  it('re-saving an unchanged body is a full no-op (no write, no revision)', async () => {
    const fx = await makeWorkItemFixture();
    const upload = await createUpload(fx, 'same.png');
    const body = `![same](${attachmentContentPath(upload.id)})`;
    const dto = await createIssue(fx, { descriptionMd: body });

    await workItemsService.updateWorkItem(dto.id, { descriptionMd: body }, fx.ctx);

    expect((await reloaded(upload.id)).workItemId).toBe(dto.id);
    expect(await updatedRevisions(dto.id)).toHaveLength(0);
  });

  it('never steals a row already linked to ANOTHER issue', async () => {
    const fx = await makeWorkItemFixture();
    const upload = await createUpload(fx, 'owned.png');
    const first = await createIssue(fx, {
      descriptionMd: `![x](${attachmentContentPath(upload.id)})`,
    });
    const second = await createIssue(fx);

    await workItemsService.updateWorkItem(
      second.id,
      { descriptionMd: `pasted ![x](${attachmentContentPath(upload.id)})` },
      fx.ctx,
    );

    expect((await reloaded(upload.id)).workItemId).toBe(first.id);
    expect(attachmentsDiffOf((await updatedRevisions(second.id))[0]!)).toBeUndefined();
  });

  it('never unlinks a PANEL-sourced row on a body diff', async () => {
    const fx = await makeWorkItemFixture();
    const upload = await createUpload(fx, 'panel.png');
    const dto = await createIssue(fx);
    await db.$transaction((tx) =>
      attachmentRepository.linkToWorkItem([upload.id], dto.id, 'panel', tx),
    );
    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: `shows ![p](${attachmentContentPath(upload.id)})` },
      fx.ctx,
    );

    await workItemsService.updateWorkItem(dto.id, { descriptionMd: 'embed gone' }, fx.ctx);

    const row = await reloaded(upload.id);
    expect(row.workItemId).toBe(dto.id);
    expect(row.source).toBe('panel');
  });
});

describe('comment write paths — link-on-write', () => {
  it("addComment links the embedded upload to the comment's issue + records the revision", async () => {
    const fx = await makeWorkItemFixture();
    const dto = await createIssue(fx);
    const upload = await createUpload(fx, 'note.png');

    await commentsService.addComment(
      dto.id,
      { bodyMd: `see ![note](${attachmentContentPath(upload.id)})` },
      fx.ctx,
    );

    const row = await reloaded(upload.id);
    expect(row.workItemId).toBe(dto.id);
    expect(row.source).toBe('editor');
    const revs = await updatedRevisions(dto.id);
    expect(revs).toHaveLength(1);
    expect(attachmentsDiffOf(revs[0]!)?.added).toEqual([
      { attachmentId: upload.id, name: 'note.png', source: 'editor' },
    ]);
  });

  it('editComment unlinks a de-referenced upload — unless another comment still references it', async () => {
    const fx = await makeWorkItemFixture();
    const dto = await createIssue(fx);
    const upload = await createUpload(fx, 'shared.png');
    const embed = `![s](${attachmentContentPath(upload.id)})`;

    const first = await commentsService.addComment(dto.id, { bodyMd: `a ${embed}` }, fx.ctx);
    await commentsService.addComment(dto.id, { bodyMd: `b ${embed}` }, fx.ctx);

    // Still referenced by comment b → stays linked.
    await commentsService.editComment(first.id, { bodyMd: 'a cleared' }, fx.ctx);
    expect((await reloaded(upload.id)).workItemId).toBe(dto.id);
  });

  it("deleteComment unlinks the THREAD's embeds (root + replies) but honours the description guard", async () => {
    const fx = await makeWorkItemFixture();
    const rootUpload = await createUpload(fx, 'root.png');
    const replyUpload = await createUpload(fx, 'reply.png');
    const keptUpload = await createUpload(fx, 'kept.png');
    const dto = await createIssue(fx, {
      descriptionMd: `desc keeps ![k](${attachmentContentPath(keptUpload.id)})`,
    });

    const root = await commentsService.addComment(
      dto.id,
      {
        bodyMd: `root ![r](${attachmentContentPath(rootUpload.id)}) and ![k](${attachmentContentPath(keptUpload.id)})`,
      },
      fx.ctx,
    );
    await commentsService.addComment(
      dto.id,
      {
        bodyMd: `reply ![rep](${attachmentContentPath(replyUpload.id)})`,
        parentCommentId: root.id,
      },
      fx.ctx,
    );

    await commentsService.deleteComment(root.id, fx.ctx);

    expect((await reloaded(rootUpload.id)).workItemId).toBeNull();
    expect((await reloaded(replyUpload.id)).workItemId).toBeNull();
    // Referenced by the issue description → survives the thread delete.
    expect((await reloaded(keptUpload.id)).workItemId).toBe(dto.id);
  });

  it('a foreign URL in a comment links nothing', async () => {
    const fx = await makeWorkItemFixture();
    const dto = await createIssue(fx);

    await commentsService.addComment(
      dto.id,
      { bodyMd: 'see https://example.com/x.png please' },
      fx.ctx,
    );

    expect(await db.attachment.count({ where: { workItemId: dto.id } })).toBe(0);
    expect(await updatedRevisions(dto.id)).toHaveLength(0);
  });
});

describe('commentRepository 5.2.3 leaves', () => {
  it("listReplies returns a root's replies oldest-first and [] for a reply-less comment", async () => {
    const fx = await makeWorkItemFixture();
    const dto = await createIssue(fx);
    const root = await commentsService.addComment(dto.id, { bodyMd: 'root' }, fx.ctx);
    await commentsService.addComment(
      dto.id,
      { bodyMd: 'first reply', parentCommentId: root.id },
      fx.ctx,
    );
    await commentsService.addComment(
      dto.id,
      { bodyMd: 'second reply', parentCommentId: root.id },
      fx.ctx,
    );

    const replies = await commentRepository.listReplies(root.id);
    expect(replies.map((r) => r.bodyMd)).toEqual(['first reply', 'second reply']);
    expect(await commentRepository.listReplies(replies[0]!.id)).toEqual([]);
  });

  it('someBodyReferences scopes to the work item', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createIssue(fx);
    const b = await createIssue(fx);
    await commentsService.addComment(a.id, { bodyMd: 'holds NEEDLE-token' }, fx.ctx);

    expect(await commentRepository.someBodyReferences(a.id, 'NEEDLE-token')).toBe(true);
    expect(await commentRepository.someBodyReferences(b.id, 'NEEDLE-token')).toBe(false);
    expect(await commentRepository.someBodyReferences(a.id, 'absent-token')).toBe(false);
  });
});
