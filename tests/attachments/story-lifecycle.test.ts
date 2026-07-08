import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { BLOB_PUBLIC_HOST_SUFFIX } from '@/lib/blob/referencedUrls';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Story-5.2 closer (Subtask 5.2.8, Principle #18): the CROSS-CUTTING lifecycle
// walk the per-subtask tests don't own — one file is born, lives through every
// 5.2 state, and dies, with row / blob / revision-trail state asserted at each
// step ACROSS subtask seams (5.2.2 panel ↔ 5.2.3 link-on-write ↔ 5.2.7 GC),
// not per method. The per-cell matrices stay where they were proven
// (attachments-management.test.ts, link-on-write.test.ts, attachment-gc
// .test.ts); this walk asserts the seams compose. Real Postgres; the Blob
// adapter is the one mocked external (the 2.3.7 seam) and the Inngest client
// is event-stubbed (the link-on-write pattern) since the body-write services
// publish post-commit events.

vi.mock('@/lib/blob/uploader', () => {
  // Unique URL per put, on the REAL public-host suffix — mirrors
  // `addRandomSuffix`, and keeps the 5.2.3 URL parser recognising the uploads.
  let urlSeq = 0;
  return {
    putAttachment: vi.fn(async (pathname: string) => ({
      url: `https://store1.public.blob.vercel-storage.com/${pathname}-${++urlSeq}`,
    })),
    putPrivateAttachment: vi.fn(async (pathname: string) => ({
      pathname: `${pathname}-${++urlSeq}`,
    })),
    signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
    deleteAttachmentBlob: vi.fn(async () => {}),
  };
});

const { putAttachment, deleteAttachmentBlob } = await import('@/lib/blob/uploader');
const { attachmentsService, ORPHAN_SAFETY_WINDOW_MS } =
  await import('@/lib/services/attachmentsService');

const fileOf = (name: string, type: string, bytes = 4) =>
  new File([new Uint8Array(bytes)], name, { type });

// Resolve either a content path (/api/attachments/<id>/content, the DTO value)
// or a raw blob pathname to its row.
const rowByUrl = (ref: string) => {
  const m = ref.match(/\/api\/attachments\/([a-z0-9]+)\/content/i);
  return db.attachment.findFirstOrThrow({ where: m ? { id: m[1]! } : { blobPathname: ref } });
};

const revisionsOf = (workItemId: string) =>
  db.workItemRevision.findMany({ where: { workItemId }, orderBy: { changedAt: 'asc' } });

const attachmentsDiffOf = (rev: { diff: unknown }) =>
  (rev.diff as { attachments?: { added?: unknown[]; removed?: unknown[] } }).attachments;

/** Age a row past the GC safety window (orphan age is the row's createdAt). */
async function agePastWindow(id: string): Promise<void> {
  await db.attachment.update({
    where: { id },
    data: { createdAt: new Date(Date.now() - ORPHAN_SAFETY_WINDOW_MS - 60_000) },
  });
}

interface Cast {
  fx: WorkItemFixture;
  /** Plain workspace member — the uploader. */
  member: User;
  memberCtx: ServiceContext;
  /** A second plain member — not the uploader, not an admin. */
  other: User;
  otherCtx: ServiceContext;
  /** Read-only project `viewer`. */
  viewerCtx: ServiceContext;
  /** Project `admin` — Jira's "Delete all attachments". */
  projAdminCtx: ServiceContext;
}

/** The 6.4-role cast the Story 5.2 permission contract names (the 5.1 shape). */
async function buildCast(): Promise<Cast> {
  const fx = await makeWorkItemFixture();

  async function wsMember(
    email: string,
    name: string,
  ): Promise<{ user: User; ctx: ServiceContext }> {
    const user = await usersService.createUser({ email, password: 'hunter2hunter2', name });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
  }

  const { user: member, ctx: memberCtx } = await wsMember('uploader@ex.com', 'Uploader');
  const { user: other, ctx: otherCtx } = await wsMember('other@ex.com', 'Other Member');
  const { user: viewer, ctx: viewerCtx } = await wsMember('viewer@ex.com', 'Read Only');
  const { user: projAdmin, ctx: projAdminCtx } = await wsMember('padmin@ex.com', 'Proj Admin');

  for (const grant of [
    { targetUserId: viewer.id, role: 'viewer' as const },
    { targetUserId: projAdmin.id, role: 'admin' as const },
  ]) {
    await projectMembersService.addMember({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      ...grant,
    });
  }

  return { fx, member, memberCtx, other, otherCtx, viewerCtx, projAdminCtx };
}

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "attachment" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  vi.mocked(deleteAttachmentBlob).mockReset();
  vi.mocked(deleteAttachmentBlob).mockResolvedValue(undefined);
  vi.mocked(putAttachment).mockClear();
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('Story 5.2 — the full attachment lifecycle, end to end', () => {
  it('panel + editor uploads → link states → body-edit relink/unlink → delete matrix → GC sweep', async () => {
    const cast = await buildCast();
    const { fx, member, memberCtx } = cast;
    const issue = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Lifecycle walk' },
      fx.ctx,
    );

    // ── 1. PANEL upload (member) — linked panel row + the added revision ────
    const panelDto = await attachmentsService.attachToWorkItem(
      issue.id,
      fileOf('panel.png', 'image/png', 12),
      memberCtx,
    );
    expect(panelDto).toMatchObject({ workItemId: issue.id, source: 'panel', isImage: true });
    await expect(rowByUrl(panelDto.blobUrl)).resolves.toMatchObject({
      workItemId: issue.id,
      source: 'panel',
      uploaderUserId: member.id,
    });

    // ── 2. EDITOR upload — unlinked at birth (the create-modal truth) ───────
    const editorUpload = await attachmentsService.uploadAttachment(
      fileOf('embed.png', 'image/png'),
      memberCtx,
    );
    await expect(rowByUrl(editorUpload.url)).resolves.toMatchObject({ workItemId: null });

    // ── 3. Body write links it (source: editor), folded into the revision ───
    await workItemsService.updateWorkItem(
      issue.id,
      { descriptionMd: `See ![embed](${editorUpload.url})` },
      memberCtx,
    );
    const editorRow = await rowByUrl(editorUpload.url);
    expect(editorRow).toMatchObject({ workItemId: issue.id, source: 'editor' });

    // Both entry paths landed in ONE uniform trail: panel-add, then editor-add
    // (the 'created' anchor leads the trail and carries no attachments cell).
    let trail = await revisionsOf(issue.id);
    expect(trail.map((rev) => attachmentsDiffOf(rev)).filter(Boolean)).toEqual([
      { added: [{ attachmentId: panelDto.id, name: 'panel.png', source: 'panel' }] },
      { added: [{ attachmentId: editorRow.id, name: 'embed.png', source: 'editor' }] },
    ]);

    // The panel lists BOTH (embeds ARE attachments), newest first.
    const page = await attachmentsService.listForWorkItem(issue.id, {}, memberCtx);
    expect(page.totalCount).toBe(2);
    expect(page.attachments.map((a) => a.source).sort()).toEqual(['editor', 'panel']);

    // ── 4. The editor-sourced block: NOBODY panel-deletes an embed ──────────
    await expect(attachmentsService.deleteAttachment(editorRow.id, fx.ctx)).rejects.toMatchObject({
      code: 'ATTACHMENT_EDITOR_SOURCED',
      status: 409,
    });

    // ── 5. Still-referenced-elsewhere: a comment now also references it ─────
    const comment = await commentsService.addComment(
      issue.id,
      { bodyMd: `also here ![embed](${editorUpload.url})` },
      memberCtx,
    );
    // Clearing the DESCRIPTION must NOT unlink — the comment still holds it.
    await workItemsService.updateWorkItem(issue.id, { descriptionMd: 'embed moved' }, memberCtx);
    await expect(rowByUrl(editorUpload.url)).resolves.toMatchObject({ workItemId: issue.id });

    // ── 6. The LAST reference goes → unlink (GC-eligible), removal recorded ─
    await commentsService.deleteComment(comment.id, memberCtx);
    await expect(rowByUrl(editorUpload.url)).resolves.toMatchObject({ workItemId: null });
    // The delete tx records comment_deleted + the unlink revision with tying
    // timestamps — assert presence, not position.
    trail = await revisionsOf(issue.id);
    expect(trail.map((rev) => attachmentsDiffOf(rev)).filter(Boolean)).toContainEqual({
      removed: [{ attachmentId: editorRow.id, name: 'embed.png', source: 'editor' }],
    });
    expect(trail.some((rev) => rev.changeKind === 'comment_deleted')).toBe(true);

    // ── 7. The delete permission matrix on the surviving panel file ─────────
    for (const [ctx, expected] of [
      [cast.viewerCtx, { code: 'ATTACHMENT_FORBIDDEN', status: 403 }],
      [cast.otherCtx, { code: 'ATTACHMENT_FORBIDDEN', status: 403 }],
    ] as const) {
      await expect(attachmentsService.deleteAttachment(panelDto.id, ctx)).rejects.toMatchObject(
        expected,
      );
    }
    await expect(rowByUrl(panelDto.blobUrl)).resolves.toMatchObject({ workItemId: issue.id });

    // The UPLOADER deletes their own — but the blob store fails: the delete
    // holds (off the panel), the row survives unlinked as the GC retry marker.
    vi.mocked(deleteAttachmentBlob).mockRejectedValueOnce(new Error('blob store down'));
    await attachmentsService.deleteAttachment(panelDto.id, memberCtx);
    await expect(rowByUrl(panelDto.blobUrl)).resolves.toMatchObject({ workItemId: null });
    expect((await attachmentsService.listForWorkItem(issue.id, {}, memberCtx)).totalCount).toBe(0);

    // ── 8. GC sweeps the two strays (the editor orphan + the blob-failure) ──
    const stray = await rowByUrl(editorUpload.url);
    const failed = await rowByUrl(panelDto.blobUrl);
    await agePastWindow(stray.id);
    await agePastWindow(failed.id);
    // A YOUNG orphan rides along to prove the safety window holds mid-walk.
    const young = await attachmentsService.uploadAttachment(
      fileOf('fresh.png', 'image/png'),
      memberCtx,
    );

    const summary = await attachmentsService.sweepOrphanAttachments();
    expect(summary).toEqual({ scanned: 2, deleted: 2, failed: 0 });
    expect(deleteAttachmentBlob).toHaveBeenCalledWith(stray.blobPathname);
    expect(deleteAttachmentBlob).toHaveBeenCalledWith(failed.blobPathname);
    expect(await db.attachment.count()).toBe(1); // only the young orphan
    await expect(rowByUrl(young.url)).resolves.toMatchObject({ workItemId: null });

    // The trail outlives the rows (the ids stay queryable post-hard-delete).
    trail = await revisionsOf(issue.id);
    const cells = trail.map((rev) => attachmentsDiffOf(rev)).filter(Boolean);
    expect(cells).toHaveLength(4); // panel-add · editor-add · editor-remove · panel-remove
  });

  it('a cross-workspace caller reads 404 on every 5.2 surface (no existence leak)', async () => {
    const { fx, memberCtx } = await buildCast();
    const issue = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Isolated' },
      fx.ctx,
    );
    const dto = await attachmentsService.attachToWorkItem(
      issue.id,
      fileOf('secret.png', 'image/png'),
      memberCtx,
    );
    const foreign = await makeWorkItemFixture({ name: 'Foreign', identifier: 'FOR' });

    await expect(
      attachmentsService.attachToWorkItem(issue.id, fileOf('x.png', 'image/png'), foreign.ctx),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
    await expect(
      attachmentsService.listForWorkItem(issue.id, {}, foreign.ctx),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
    await expect(attachmentsService.deleteAttachment(dto.id, foreign.ctx)).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
    });
    await expect(rowByUrl(dto.blobUrl)).resolves.toMatchObject({ workItemId: issue.id });
  });

  it('issue deletion SetNulls the links; the GC (not a cascade) reaps rows + blobs', async () => {
    const { fx, memberCtx } = await buildCast();
    const issue = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Doomed' },
      fx.ctx,
    );
    // A panel row + an editor embed → two links that become two orphans on delete.
    await attachmentsService.attachToWorkItem(
      issue.id,
      fileOf('doomed.png', 'image/png'),
      memberCtx,
    );
    const editorUpload = await attachmentsService.uploadAttachment(
      fileOf('doomed-embed.png', 'image/png'),
      memberCtx,
    );
    await workItemsService.updateWorkItem(
      issue.id,
      { descriptionMd: `![x](${editorUpload.url})` },
      memberCtx,
    );

    // A row delete is the SetNull trigger (the product only archives today —
    // the destructive delete is the 5.2.1 FK contract, driven directly like
    // that subtask's repository test does).
    await db.workItem.delete({ where: { id: issue.id } });

    // SetNull, not cascade: both rows survive unlinked, blobs untouched.
    const orphans = await db.attachment.findMany();
    expect(orphans).toHaveLength(2);
    expect(orphans.every((row) => row.workItemId === null)).toBe(true);
    expect(deleteAttachmentBlob).not.toHaveBeenCalled();

    // …until the window passes and the sweep takes blob-then-row.
    for (const row of orphans) await agePastWindow(row.id);
    const summary = await attachmentsService.sweepOrphanAttachments();
    expect(summary).toEqual({ scanned: 2, deleted: 2, failed: 0 });
    expect(await db.attachment.count()).toBe(0);
    // The GC deletes each orphan's blob by its stored private pathname.
    for (const row of orphans) expect(deleteAttachmentBlob).toHaveBeenCalledWith(row.blobPathname);
  });
});

describe('Story 5.2 — the blob URL contract the walk rides on', () => {
  it('the mocked store emits parser-recognised public-host URLs (guards the seam itself)', () => {
    // The walk's editor steps only work because the mock's host matches the
    // 5.2.3 parser's suffix — assert that explicitly so a drift in either side
    // fails HERE with a readable message, not as a mysterious never-linked row.
    expect('https://store1.public.blob.vercel-storage.com/x').toContain(BLOB_PUBLIC_HOST_SUFFIX);
  });
});
