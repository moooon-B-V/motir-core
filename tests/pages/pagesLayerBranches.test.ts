import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { pageErrorResponse } from '@/lib/pages/routeErrors';
import { PageNotFoundError } from '@/lib/pages';
import { toPageListItemDto, toPageVersionListItemDto } from '@/lib/mappers/pageMappers';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { AttachmentNotFoundError } from '@/lib/blob/errors';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The pages layer's DEFENSIVE arms (Story MOTIR-5752 · MOTIR-7281, the story's
// coverage gate): the branches the assembled path never takes because something
// upstream already decided — a rename racing a delete, an editor row the batch
// read did not return, an error the refusal map does not own. Each is reached
// here directly, against real Postgres where it touches the database.

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "attachment", "page" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeTenant() {
  const owner = await usersService.createUser({
    email: 'pages-branches-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Branches owner',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Branches', ownerUserId: owner.id });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    name: 'Branches',
    identifier: 'BRN',
  });
  return { userId: owner.id, workspaceId: ws.workspace.id, projectId: project.id };
}

/** A page in the tenant's project with one image filed under it. */
async function pageWithImage(t: Awaited<ReturnType<typeof makeTenant>>) {
  const page = await pagesService.createPage(t, { projectId: t.projectId });
  const image = await adminDb.attachment.create({
    data: {
      workspaceId: t.workspaceId,
      uploaderUserId: t.userId,
      pageId: page.id,
      blobPathname: `attachments/${t.workspaceId}/diagram.png`,
      mimeType: 'image/png',
      sizeBytes: 8,
      originalFilename: 'diagram.png',
    },
  });
  return { page, image };
}

describe('pageRepository.updateTitle', () => {
  it('answers null for a page that is gone (Prisma P2025), so the package refuses it as unknown', async () => {
    const t = await makeTenant();
    const result = await withWorkspaceContext(t, (tx) =>
      pageRepository.updateTitle('no-such-page', 'Renamed', t.userId, tx),
    );
    expect(result).toBeNull();
  });

  it('rethrows any other database refusal unchanged', async () => {
    const t = await makeTenant();
    const page = await pagesService.createPage(t, { projectId: t.projectId });
    // A NUL byte is not storable in a Postgres `text` column — a refusal that is
    // not "record not found", so it must not be swallowed as one.
    await expect(
      withWorkspaceContext(t, (tx) =>
        pageRepository.updateTitle(page.id, 'bad\u0000title', t.userId, tx),
      ),
    ).rejects.toThrow();
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(row.title).toBe('');
  });
});

describe('toPageListItemDto', () => {
  it('labels an editor the batch read did not return with an empty name, never undefined', () => {
    const updatedAt = new Date('2026-10-01T12:00:00Z');
    expect(
      toPageListItemDto({ id: 'p1', title: 'T', updatedAt, updatedById: 'u-gone' }, undefined),
    ).toEqual({
      id: 'p1',
      title: 'T',
      updatedAt: '2026-10-01T12:00:00.000Z',
      updatedBy: { id: 'u-gone', name: '' },
    });
  });
});

describe('toPageVersionListItemDto', () => {
  it('labels an author the batch read did not return with an empty name (MOTIR-5754)', () => {
    const at = new Date('2026-10-01T12:00:00Z');
    expect(
      toPageVersionListItemDto(
        {
          id: 'v1',
          pageId: 'p1',
          number: 1,
          authorId: 'u-gone',
          startedAt: at,
          savedAt: at,
          restoredFromVersionId: null,
          restoredFromNumber: null,
          sealedAt: null,
          frozenAt: null,
        },
        undefined,
        true,
      ),
    ).toMatchObject({ authorId: 'u-gone', authorName: '', isCurrent: true });
  });
});

describe('pageErrorResponse', () => {
  it('answers a foreign or token-narrowed project with the one not-found body', async () => {
    for (const err of [new ProjectNotFoundError('proj'), new PageNotFoundError('page')]) {
      const res = pageErrorResponse(err);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });
    }
  });

  it('rethrows an error that is not a page refusal', () => {
    const boom = new Error('boom');
    expect(() => pageErrorResponse(boom)).toThrow(boom);
  });
});

describe('attachmentsService.getContentRedirect — a page image', () => {
  it('a token bound to ANOTHER project is refused the image as not found', async () => {
    // A bearer token's project binding (`tokenProjectId`, MOTIR-2607) makes the
    // page gate refuse every other project as `ProjectNotFoundError`; the image
    // must read as the attachment's own 404, not leak that the page exists.
    const t = await makeTenant();
    const other = await projectsService.createProject({
      workspaceId: t.workspaceId,
      actorUserId: t.userId,
      name: 'Elsewhere',
      identifier: 'ELS',
    });
    const { image } = await pageWithImage(t);
    await expect(
      attachmentsService.getContentRedirect(image.id, {
        userId: t.userId,
        workspaceId: t.workspaceId,
        tokenProjectId: other.id,
      }),
    ).rejects.toBeInstanceOf(AttachmentNotFoundError);
  });

  it('an error from the page gate that is not a refusal is rethrown, never read as a 404', async () => {
    const t = await makeTenant();
    const { image } = await pageWithImage(t);
    vi.spyOn(projectAccessService, 'assertCanViewPages').mockRejectedValueOnce(
      new Error('database down'),
    );
    await expect(
      attachmentsService.getContentRedirect(image.id, {
        userId: t.userId,
        workspaceId: t.workspaceId,
      }),
    ).rejects.toThrow('database down');
  });
});
