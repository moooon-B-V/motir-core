import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, User, WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { toAttachmentDto } from '@/lib/mappers/attachmentMappers';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// attachmentsService management surface (Story 5.2 · Subtask 5.2.2) against a
// REAL Postgres: attachToWorkItem / listForWorkItem / deleteAttachment — the
// permission matrix (Jira's three attachment permissions on the 6.4 roles),
// the editor-sourced delete block, the bounded paged read, the revision
// trail, and the blob-failure → GC-sweepable lifecycle. The Blob adapter is
// the ONE mocked external (the attachments-service.test.ts seam); everything
// else goes through the real path.

vi.mock('@/lib/blob/uploader', () => {
  // Unique URL per put — mirrors `addRandomSuffix` (two same-named uploads
  // must not collide on blobPathname).
  let urlSeq = 0;
  return {
    putAttachment: vi.fn(async (pathname: string) => ({
      url: `https://blob.example/${pathname}-${++urlSeq}`,
    })),
    putPrivateAttachment: vi.fn(async (pathname: string) => ({
      pathname: `${pathname}-${++urlSeq}`,
    })),
    signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
    deleteAttachmentBlob: vi.fn(async () => {}),
  };
});

const { putAttachment, deleteAttachmentBlob } = await import('@/lib/blob/uploader');
const { attachmentsService, ATTACHMENT_PAGE_SIZE } =
  await import('@/lib/services/attachmentsService');

const fileOf = (name: string, type: string, bytes = 4) =>
  new File([new Uint8Array(bytes)], name, { type });

interface Scenario {
  fx: WorkItemFixture;
  issue: WorkItem;
  ownerCtx: ServiceContext;
  /** Plain workspace member — NO project role (the standard uploader). */
  member: User;
  memberCtx: ServiceContext;
  /** A second plain member — not the uploader, not an admin. */
  other: User;
  otherCtx: ServiceContext;
  /** Workspace member with the read-only project `viewer` role. */
  viewer: User;
  viewerCtx: ServiceContext;
  /** Workspace member with the project `admin` role. */
  projAdmin: User;
  projAdminCtx: ServiceContext;
}

/**
 * The standard substrate (the commentsService-test shape): an OPEN project
 * with one issue, plus one actor per attachment-relevant role tier.
 */
async function buildScenario(): Promise<Scenario> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Attached task' });

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

  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: viewer.id,
    role: 'viewer',
  });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: projAdmin.id,
    role: 'admin',
  });

  return {
    fx,
    issue,
    ownerCtx: fx.ctx,
    member,
    memberCtx,
    other,
    otherCtx,
    viewer,
    viewerCtx,
    projAdmin,
    projAdminCtx,
  };
}

/** Flip an attachment to editor-sourced + linked (the 5.2.3 link-on-write end state). */
async function linkAsEditor(s: Scenario, row: Attachment): Promise<void> {
  await withWorkspaceContext(
    { userId: s.fx.ownerId, workspaceId: s.fx.workspaceId },
    async (tx) => {
      await attachmentRepository.linkToWorkItem([row.id], s.issue.id, 'editor', tx);
    },
  );
}

// Resolve either a content path (/api/attachments/<id>/content, the DTO value)
// or a raw blob pathname to its row.
const rowByUrl = (ref: string) => {
  const m = ref.match(/\/api\/attachments\/([a-z0-9]+)\/content/i);
  return db.attachment.findFirst({ where: m ? { id: m[1]! } : { blobPathname: ref } });
};

const revisionsOf = (workItemId: string) =>
  db.workItemRevision.findMany({ where: { workItemId }, orderBy: { changedAt: 'asc' } });

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "attachment" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  vi.mocked(deleteAttachmentBlob).mockReset();
  vi.mocked(deleteAttachmentBlob).mockResolvedValue(undefined);
  vi.mocked(putAttachment).mockClear();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('attachmentsService.attachToWorkItem', () => {
  it('member upload → linked panel row + DTO + the revision attachment-added entry', async () => {
    const s = await buildScenario();
    const dto = await attachmentsService.attachToWorkItem(
      s.issue.id,
      fileOf('shot.png', 'image/png', 12),
      s.memberCtx,
    );

    expect(dto.workItemId).toBe(s.issue.id);
    expect(dto.source).toBe('panel');
    expect(dto.filename).toBe('shot.png');
    expect(dto.isImage).toBe(true);
    expect(dto.isPdf).toBe(false);
    expect(dto.uploader).toMatchObject({ id: s.member.id, name: 'Uploader' });

    const row = await rowByUrl(dto.blobUrl);
    expect(row).toMatchObject({
      workItemId: s.issue.id,
      source: 'panel',
      uploaderUserId: s.member.id,
    });

    const revisions = await revisionsOf(s.issue.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ changeKind: 'updated', changedById: s.member.id });
    expect(revisions[0]!.diff).toEqual({
      attachments: { added: [{ attachmentId: row!.id, name: 'shot.png', source: 'panel' }] },
    });
  });

  it('read-only viewer → 403 ATTACHMENT_FORBIDDEN, and NO blob round-trip is spent', async () => {
    const s = await buildScenario();
    await expect(
      attachmentsService.attachToWorkItem(s.issue.id, fileOf('x.png', 'image/png'), s.viewerCtx),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_FORBIDDEN', status: 403 });
    expect(putAttachment).not.toHaveBeenCalled();
    expect(await db.attachment.count()).toBe(0);
    expect(await revisionsOf(s.issue.id)).toHaveLength(0);
  });

  it('a foreign-workspace caller → 404 WORK_ITEM_NOT_FOUND (no existence leak)', async () => {
    const s = await buildScenario();
    const foreign = await makeWorkItemFixture({ name: 'Foreign', identifier: 'FOR' });
    await expect(
      attachmentsService.attachToWorkItem(s.issue.id, fileOf('x.png', 'image/png'), foreign.ctx),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
  });

  it('the 2.3.7 gates are reused: an oversize file → 413, no row, no revision', async () => {
    const s = await buildScenario();
    await expect(
      attachmentsService.attachToWorkItem(
        s.issue.id,
        fileOf('big.png', 'image/png', 11 * 1024 * 1024),
        s.memberCtx,
      ),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 });
    expect(await db.attachment.count()).toBe(0);
    expect(await revisionsOf(s.issue.id)).toHaveLength(0);
  });
});

describe('attachmentsService.listForWorkItem', () => {
  it('cursor-pages newest-first: 50 + "Show more" cursor, never the full set', async () => {
    const s = await buildScenario();
    const total = ATTACHMENT_PAGE_SIZE + 1;
    await withWorkspaceContext(
      { userId: s.fx.ownerId, workspaceId: s.fx.workspaceId },
      async (tx) => {
        for (let i = 0; i < total; i++) {
          await attachmentRepository.create(
            {
              workspaceId: s.fx.workspaceId,
              uploaderUserId: s.member.id,
              workItemId: s.issue.id,
              source: 'panel',
              blobPathname: `https://blob.example/seed-${i}`,
              mimeType: 'text/plain',
              sizeBytes: 1,
              originalFilename: `seed-${i}.txt`,
              createdAt: new Date(Date.now() - (total - i) * 1000),
            },
            tx,
          );
        }
      },
    );

    const page1 = await attachmentsService.listForWorkItem(s.issue.id, {}, s.memberCtx);
    expect(page1.attachments).toHaveLength(ATTACHMENT_PAGE_SIZE);
    expect(page1.totalCount).toBe(total);
    expect(page1.nextCursor).toBe(page1.attachments[ATTACHMENT_PAGE_SIZE - 1]!.id);
    // Newest first — the most recent seed row leads.
    expect(page1.attachments[0]!.filename).toBe(`seed-${total - 1}.txt`);

    const page2 = await attachmentsService.listForWorkItem(
      s.issue.id,
      { cursor: page1.nextCursor! },
      s.memberCtx,
    );
    expect(page2.attachments).toHaveLength(1);
    expect(page2.attachments[0]!.filename).toBe('seed-0.txt');
    expect(page2.nextCursor).toBeNull();
    expect(page2.totalCount).toBe(total);

    // No overlap across the page boundary.
    const ids = new Set([...page1.attachments, ...page2.attachments].map((a) => a.id));
    expect(ids.size).toBe(total);
  });

  it('DTO carries the preview flags + the resolved uploader', async () => {
    const s = await buildScenario();
    await attachmentsService.attachToWorkItem(
      s.issue.id,
      fileOf('spec.pdf', 'application/pdf'),
      s.memberCtx,
    );
    const page = await attachmentsService.listForWorkItem(s.issue.id, {}, s.ownerCtx);
    expect(page.attachments[0]).toMatchObject({
      filename: 'spec.pdf',
      isPdf: true,
      isImage: false,
      source: 'panel',
      uploader: { id: s.member.id, name: 'Uploader' },
    });
  });

  it('a project viewer CAN list (browse implies the panel read)', async () => {
    const s = await buildScenario();
    await attachmentsService.attachToWorkItem(
      s.issue.id,
      fileOf('a.png', 'image/png'),
      s.memberCtx,
    );
    const page = await attachmentsService.listForWorkItem(s.issue.id, {}, s.viewerCtx);
    expect(page.attachments).toHaveLength(1);
    expect(page.totalCount).toBe(1);
  });

  it('an attachment-less issue → empty page, count 0, no cursor', async () => {
    const s = await buildScenario();
    const page = await attachmentsService.listForWorkItem(s.issue.id, {}, s.memberCtx);
    expect(page).toEqual({ attachments: [], totalCount: 0, nextCursor: null });
  });

  it('a foreign-workspace caller → 404 WORK_ITEM_NOT_FOUND', async () => {
    const s = await buildScenario();
    const foreign = await makeWorkItemFixture({ name: 'Foreign', identifier: 'FOR' });
    await expect(
      attachmentsService.listForWorkItem(s.issue.id, {}, foreign.ctx),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
  });
});

describe('attachmentsService.deleteAttachment', () => {
  async function attachAsMember(s: Scenario, name = 'mine.png'): Promise<string> {
    const dto = await attachmentsService.attachToWorkItem(
      s.issue.id,
      fileOf(name, 'image/png'),
      s.memberCtx,
    );
    return dto.id;
  }

  it('the uploader deletes their OWN: row + blob gone, revision attachment-removed recorded', async () => {
    const s = await buildScenario();
    const id = await attachAsMember(s);
    const blobPathname = (await db.attachment.findUnique({ where: { id } }))!.blobPathname;

    await attachmentsService.deleteAttachment(id, s.memberCtx);

    expect(await db.attachment.findUnique({ where: { id } })).toBeNull();
    expect(deleteAttachmentBlob).toHaveBeenCalledWith(blobPathname);

    const revisions = await revisionsOf(s.issue.id);
    expect(revisions).toHaveLength(2); // added + removed
    expect(revisions[1]!.diff).toEqual({
      attachments: { removed: [{ attachmentId: id, name: 'mine.png', source: 'panel' }] },
    });
    expect(revisions[1]).toMatchObject({ changeKind: 'updated', changedById: s.member.id });
  });

  it("another plain member CANNOT delete someone else's → 403, row survives", async () => {
    const s = await buildScenario();
    const id = await attachAsMember(s);
    await expect(attachmentsService.deleteAttachment(id, s.otherCtx)).rejects.toMatchObject({
      code: 'ATTACHMENT_FORBIDDEN',
      status: 403,
    });
    expect(await db.attachment.findUnique({ where: { id } })).not.toBeNull();
    expect(deleteAttachmentBlob).not.toHaveBeenCalled();
  });

  it('a project admin deletes ANY (Jira "Delete all")', async () => {
    const s = await buildScenario();
    const id = await attachAsMember(s);
    await attachmentsService.deleteAttachment(id, s.projAdminCtx);
    expect(await db.attachment.findUnique({ where: { id } })).toBeNull();
  });

  it('the workspace owner deletes ANY (the always-pass rail)', async () => {
    const s = await buildScenario();
    const id = await attachAsMember(s);
    await attachmentsService.deleteAttachment(id, s.ownerCtx);
    expect(await db.attachment.findUnique({ where: { id } })).toBeNull();
  });

  it('a project viewer → 403 (read-only everywhere)', async () => {
    const s = await buildScenario();
    const id = await attachAsMember(s);
    await expect(attachmentsService.deleteAttachment(id, s.viewerCtx)).rejects.toMatchObject({
      code: 'ATTACHMENT_FORBIDDEN',
      status: 403,
    });
  });

  it('an EDITOR-sourced row → 409 ATTACHMENT_EDITOR_SOURCED, row stays linked (the broken-embed guard)', async () => {
    const s = await buildScenario();
    const upload = await attachmentsService.uploadAttachment(
      fileOf('embed.png', 'image/png'),
      s.memberCtx,
    );
    const row = (await rowByUrl(upload.url))!;
    await linkAsEditor(s, row);

    // Even the workspace owner is blocked — the gate is the source, not the role.
    await expect(attachmentsService.deleteAttachment(row.id, s.ownerCtx)).rejects.toMatchObject({
      code: 'ATTACHMENT_EDITOR_SOURCED',
      status: 409,
    });
    expect(await db.attachment.findUnique({ where: { id: row.id } })).toMatchObject({
      workItemId: s.issue.id,
      source: 'editor',
    });
  });

  it('an UNLINKED row → 404 (on no panel; the GC owns it)', async () => {
    const s = await buildScenario();
    const upload = await attachmentsService.uploadAttachment(
      fileOf('stray.png', 'image/png'),
      s.memberCtx,
    );
    const row = (await rowByUrl(upload.url))!;
    await expect(attachmentsService.deleteAttachment(row.id, s.memberCtx)).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
      status: 404,
    });
  });

  it('a cross-workspace caller / a missing id → 404 (no existence leak)', async () => {
    const s = await buildScenario();
    const id = await attachAsMember(s);
    const foreign = await makeWorkItemFixture({ name: 'Foreign', identifier: 'FOR' });
    await expect(attachmentsService.deleteAttachment(id, foreign.ctx)).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
    });
    await expect(
      attachmentsService.deleteAttachment('nope-never-existed', s.memberCtx),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  });

  it('a blob-store failure leaves the panel delete in force and the row UNLINKED — GC-sweepable (the 5.2.7 backstop)', async () => {
    const s = await buildScenario();
    const id = await attachAsMember(s);
    vi.mocked(deleteAttachmentBlob).mockRejectedValueOnce(new Error('blob store down'));

    await expect(attachmentsService.deleteAttachment(id, s.memberCtx)).resolves.toBeUndefined();

    // The row survives as the GC's retry marker: unlinked (off the panel),
    // blob still recorded — exactly the listOrphans shape.
    const row = await db.attachment.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row!.workItemId).toBeNull();

    // The removal already happened from the issue's perspective.
    const page = await attachmentsService.listForWorkItem(s.issue.id, {}, s.memberCtx);
    expect(page.totalCount).toBe(0);
    const revisions = await revisionsOf(s.issue.id);
    expect(revisions[revisions.length - 1]!.diff).toMatchObject({
      attachments: { removed: [{ attachmentId: id }] },
    });
  });
});

describe('attachmentMappers.toAttachmentDto (the loud-failure contracts)', () => {
  const baseRow: Attachment = {
    id: 'att_1',
    workspaceId: 'ws_1',
    uploaderUserId: 'user_1',
    workItemId: 'wi_1',
    source: 'panel',
    blobPathname: 'https://blob.example/x',
    mimeType: 'image/png',
    sizeBytes: 1,
    originalFilename: 'x.png',
    createdAt: new Date('2026-06-10T00:00:00Z'),
  };

  it('an unlinked row has no panel DTO form', () => {
    expect(() => toAttachmentDto({ ...baseRow, workItemId: null }, new Map())).toThrow(
      /unlinked rows/,
    );
  });

  it('a missing uploader in the batched read fails loudly', () => {
    expect(() => toAttachmentDto(baseRow, new Map())).toThrow(/missing from the batched read/);
  });
});
