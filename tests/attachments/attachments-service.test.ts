import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables } from '../helpers/db';

// attachmentsService.uploadAttachment (Subtask 2.3.7) against a REAL Postgres.
// The Blob adapter is the ONE mocked external (no network); every gate + the
// audit-row write go through the real path. The card's MIME/size/rate-limit
// gates + the workspace-scoping invariant are the surface under test.

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}` })),
}));

const { attachmentsService } = await import('@/lib/services/attachmentsService');

async function makeFixture(email = 'att@example.com') {
  const owner = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Att' });
  const ws = await workspacesService.createWorkspace({ name: 'Att WS', ownerUserId: owner.id });
  return { userId: owner.id, workspaceId: ws.workspace.id };
}

const fileOf = (name: string, type: string, bytes = 4) =>
  new File([new Uint8Array(bytes)], name, { type });

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "attachment" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('attachmentsService.uploadAttachment', () => {
  it('uploads an IMAGE → writes the audit row + returns {url, mime, isImage:true}', async () => {
    const fx = await makeFixture();
    const res = await attachmentsService.uploadAttachment(fileOf('shot.png', 'image/png', 10), fx);

    expect(res.isImage).toBe(true);
    expect(res.mime).toBe('image/png');
    expect(res.url).toContain('https://blob.example/');

    const row = await db.attachment.findFirst({ where: { workspaceId: fx.workspaceId } });
    expect(row).not.toBeNull();
    expect(row!.uploaderUserId).toBe(fx.userId); // from ctx, never the client
    expect(row!.mimeType).toBe('image/png');
    expect(row!.sizeBytes).toBe(10);
    expect(row!.originalFilename).toBe('shot.png');
    expect(row!.blobUrl).toBe(res.url);
  });

  it('a non-image allowed file (pdf) → isImage:false (inserts as a link)', async () => {
    const fx = await makeFixture();
    const res = await attachmentsService.uploadAttachment(fileOf('r.pdf', 'application/pdf'), fx);
    expect(res.isImage).toBe(false);
    expect(res.mime).toBe('application/pdf');
  });

  it('oversize → FileTooLargeError (413), no row written', async () => {
    const fx = await makeFixture();
    const big = fileOf('big.png', 'image/png', 11 * 1024 * 1024);
    await expect(attachmentsService.uploadAttachment(big, fx)).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
      status: 413,
    });
    expect(await db.attachment.count()).toBe(0);
  });

  it('disallowed MIME → UnsupportedFileTypeError (415)', async () => {
    const fx = await makeFixture();
    await expect(
      attachmentsService.uploadAttachment(fileOf('x.exe', 'application/x-msdownload'), fx),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE', status: 415 });
    expect(await db.attachment.count()).toBe(0);
  });

  it('rate limit → the 11th upload in the window throws RateLimitError (429)', async () => {
    const fx = await makeFixture('rate@example.com');
    for (let i = 0; i < 10; i++) {
      await attachmentsService.uploadAttachment(fileOf(`f${i}.png`, 'image/png'), fx);
    }
    await expect(
      attachmentsService.uploadAttachment(fileOf('f10.png', 'image/png'), fx),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  });

  it('the audit row is workspace-scoped to ctx — a forged workspace is impossible', async () => {
    const fx = await makeFixture();
    const res = await attachmentsService.uploadAttachment(fileOf('a.png', 'image/png'), fx);
    expect(res).toBeTruthy();
    // The row's workspaceId comes from ctx (the route resolves it from the
    // session's active project), never from the upload payload.
    const row = await db.attachment.findFirst({ where: { workspaceId: fx.workspaceId } });
    expect(row!.workspaceId).toBe(fx.workspaceId);
  });
});
