import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { createTestProject } from '../fixtures/projectFixtures';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateRateLimitCounters } from '../helpers/db';
import { ALIGNED_WINDOW_MS, waitForWindowBoundary } from '../helpers/rateLimitWindow';
import { pinSharedRateLimitStoreDeadline } from '../helpers/rateLimitStore';

// attachmentsService.uploadAttachment (Subtask 2.3.7) against a REAL Postgres.
// The Blob adapter is the ONE mocked external (no network); every gate + the
// audit-row write go through the real path. The card's MIME/size/rate-limit
// gates + the workspace-scoping invariant are the surface under test.
//
// The upload throttle counts through the SHARED store since MOTIR-2598, so its
// state is a TABLE rather than a module-level Map: `truncateRateLimitCounters`
// belongs in `beforeEach` for the same reason `truncateAuthTables` does, and the
// counting case pins its window through the env pair the surface reads (see the
// case itself for why).

vi.mock('@/lib/blob/uploader', () => {
  let seq = 0;
  return {
    putAttachment: vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}` })),
    putPrivateAttachment: vi.fn(async (pathname: string) => ({ pathname: `${pathname}-${++seq}` })),
    signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
    deleteAttachmentBlob: vi.fn(async () => {}),
  };
});

const { attachmentsService } = await import('@/lib/services/attachmentsService');

async function makeFixture(email = 'att@example.com') {
  const owner = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Att' });
  const ws = await workspacesService.createWorkspace({ name: 'Att WS', ownerUserId: owner.id });
  // MOTIR-2366 — the upload now names the project it uploads INTO and asserts
  // `attachment:create` on it, so the fixture needs a real project. The owner is
  // a workspace manager, so they hold the key through the always-pass rail; the
  // refusal cases live in `tests/integration/work-items/unconfirmed-gates.test.ts`.
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: owner.id });
  return { userId: owner.id, workspaceId: ws.workspace.id, projectId: project.id };
}

const fileOf = (name: string, type: string, bytes = 4) =>
  new File([new Uint8Array(bytes)], name, { type });

/** The budget env pair `uploadBudget()` reads — cleared around every case. */
const UPLOAD_BUDGET_ENVS = ['MOTIR_UPLOAD_RATE_LIMIT', 'MOTIR_UPLOAD_RATE_LIMIT_WINDOW_MS'];

/**
 * The window the ELEVEN-upload case aligns against — its own, larger than the
 * shared `ALIGNED_WINDOW_MS` the two- and three-upload cases use.
 *
 * Sized from measurement, the way `rateLimitWindow.ts` sizes its own: the
 * eleven-upload section is **147 ms worst-of-5** against a real Postgres
 * (2026-08-10, MOTIR-2598), an order of magnitude heavier than the 2–3 upload
 * sections below (~40 ms) because it is eleven full service calls. 6 s is a ~40×
 * margin over that worst case, matching what the small cases get from the 2 s
 * shared window — so the remaining failure would need a runner 40× slower than
 * measured, not an unlucky phase.
 *
 * The ceiling on this number is `testTimeout` (15 s): aligning costs up to a
 * whole window, so a larger one would trade a rare flake for a routine timeout.
 */
const ELEVEN_UPLOAD_WINDOW_MS = 6_000;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "attachment" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  await truncateRateLimitCounters();
  // ⚠️ PIN THE STORE DEADLINE (MOTIR-3067). The upload throttle counts through the SHARED
  // Postgres store, whose production deadline is 250 ms for one increment — and
  // `consumeSharedRateLimit` FAILS OPEN when that expires, serving the call this
  // suite expects to be refused. On a CI shard running thousands of tests against
  // one database that is a real outcome, and it presents as a refusal assertion
  // failing on a diff that touched no rate-limiting code. See
  // `tests/helpers/rateLimitStore.ts`.
  pinSharedRateLimitStoreDeadline();
  for (const key of UPLOAD_BUDGET_ENVS) delete process.env[key];
});

afterEach(() => {
  for (const key of UPLOAD_BUDGET_ENVS) delete process.env[key];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('attachmentsService.uploadAttachment', () => {
  it('uploads an IMAGE → writes the audit row + returns {url, mime, isImage:true}', async () => {
    const fx = await makeFixture();
    const res = await attachmentsService.uploadAttachment(fileOf('shot.png', 'image/png', 10), fx);

    expect(res.isImage).toBe(true);
    expect(res.mime).toBe('image/png');
    // The private content path (not a public blob URL), keyed by the row id.
    expect(res.url).toBe(`/api/attachments/${res.id}/content`);

    const row = await adminDb.attachment.findFirst({ where: { workspaceId: fx.workspaceId } });
    expect(row).not.toBeNull();
    expect(row!.uploaderUserId).toBe(fx.userId); // from ctx, never the client
    expect(row!.mimeType).toBe('image/png');
    expect(row!.sizeBytes).toBe(10);
    expect(row!.originalFilename).toBe('shot.png');
    expect(row!.id).toBe(res.id);
    expect(row!.blobPathname).toContain('attachments/');
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
    const attachmentCount = await adminDb.attachment.count();
    expect(attachmentCount).toBe(0);
  });

  it('disallowed MIME → UnsupportedFileTypeError (415)', async () => {
    const fx = await makeFixture();
    await expect(
      attachmentsService.uploadAttachment(fileOf('x.exe', 'application/x-msdownload'), fx),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE', status: 415 });
    const attachmentCount = await adminDb.attachment.count();
    expect(attachmentCount).toBe(0);
  });

  it('rate limit → the 11th upload in the window throws RateLimitError (429)', async () => {
    // ⚠️ PIN THE WINDOW, THEN ALIGN TO IT. The throttle now counts through the
    // shared store, which buckets on an EPOCH-ALIGNED grid — the window does not
    // open at the first upload. Eleven uploads that straddle a boundary reset the
    // counter mid-case and the 11th is served, which is a flake that needs
    // unlucky PHASE rather than a slow runner: invisible locally, green on every
    // rerun, and mis-read as "CI was loaded" (MOTIR-2101 / MOTIR-2224).
    //
    // So the case shrinks the window through the very env pair a deployment
    // uses, and waits for the next boundary before the first counted upload —
    // which hands it a WHOLE window instead of whatever was left of a
    // randomly-phased one. The limit stays the shipped 10: the assertion is
    // about the count, not the window's length.
    process.env['MOTIR_UPLOAD_RATE_LIMIT_WINDOW_MS'] = String(ELEVEN_UPLOAD_WINDOW_MS);
    const fx = await makeFixture('rate@example.com');

    await waitForWindowBoundary(ELEVEN_UPLOAD_WINDOW_MS);
    for (let i = 0; i < 10; i++) {
      await attachmentsService.uploadAttachment(fileOf(`f${i}.png`, 'image/png'), fx);
    }
    await expect(
      attachmentsService.uploadAttachment(fileOf('f10.png', 'image/png'), fx),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  });

  it('the ceiling is the SHARED counter, not this process — a second process sees the same tally', async () => {
    // The defect MOTIR-2598 fixes, asserted at the only altitude a single-process
    // test can reach: the count lives in the `rate_limit_counter` TABLE, so a
    // second machine reading the same row inherits the tally rather than starting
    // its own. Truncating the table mid-case is the observable proxy for "the
    // count is not in this process's memory" — under the old module-level Map the
    // budget would survive the truncate untouched.
    process.env['MOTIR_UPLOAD_RATE_LIMIT'] = '2';
    process.env['MOTIR_UPLOAD_RATE_LIMIT_WINDOW_MS'] = String(ALIGNED_WINDOW_MS);
    const fx = await makeFixture('shared@example.com');

    await waitForWindowBoundary(ALIGNED_WINDOW_MS);
    await attachmentsService.uploadAttachment(fileOf('a.png', 'image/png'), fx);
    await attachmentsService.uploadAttachment(fileOf('b.png', 'image/png'), fx);
    await expect(
      attachmentsService.uploadAttachment(fileOf('c.png', 'image/png'), fx),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });

    const counters = await adminDb.$queryRawUnsafe<Array<{ count: number }>>(
      'SELECT COUNT(*)::int AS count FROM "rate_limit_counter"',
    );
    expect(counters[0]!.count).toBeGreaterThan(0);

    await truncateRateLimitCounters();
    await expect(
      attachmentsService.uploadAttachment(fileOf('d.png', 'image/png'), fx),
    ).resolves.toBeTruthy();
  });

  it('one user spending their budget does not touch another user’s', async () => {
    process.env['MOTIR_UPLOAD_RATE_LIMIT'] = '1';
    process.env['MOTIR_UPLOAD_RATE_LIMIT_WINDOW_MS'] = String(ALIGNED_WINDOW_MS);
    const spender = await makeFixture('spender@example.com');
    const bystander = await makeFixture('bystander@example.com');

    await waitForWindowBoundary(ALIGNED_WINDOW_MS);
    await attachmentsService.uploadAttachment(fileOf('one.png', 'image/png'), spender);
    await expect(
      attachmentsService.uploadAttachment(fileOf('two.png', 'image/png'), spender),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    // A different account keys to a different bucket — the key is per user.
    await expect(
      attachmentsService.uploadAttachment(fileOf('mine.png', 'image/png'), bystander),
    ).resolves.toBeTruthy();
  });

  it('the user id never reaches the counter table in the clear', async () => {
    // ADR §7's obligation on every key this store holds. A user id is not an IP,
    // but the table carries no `workspace_id` and no RLS precisely because its
    // keys are opaque — a plaintext id there would quietly change what the table
    // is.
    process.env['MOTIR_UPLOAD_RATE_LIMIT_WINDOW_MS'] = String(ALIGNED_WINDOW_MS);
    const fx = await makeFixture('hashed@example.com');
    await attachmentsService.uploadAttachment(fileOf('h.png', 'image/png'), fx);

    // Left on `@/lib/db` deliberately (MOTIR-2751 audit): `rate_limit_counter` carries
    // NO RLS — it is in `tenant-root-creation-rls`'s DELIBERATELY_UNGUARDED map, because
    // the surfaces it protects are rate-limited before any workspace is known. There is
    // no tenant to bind and no policy to be blind to.
    const rows = await db.$queryRawUnsafe<Array<{ key: string }>>(
      'SELECT key FROM "rate_limit_counter"',
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.key.startsWith('upload:'))).toBe(true);
    for (const row of rows) expect(row.key).not.toContain(fx.userId);
  });

  it('the audit row is workspace-scoped to ctx — a forged workspace is impossible', async () => {
    const fx = await makeFixture();
    const res = await attachmentsService.uploadAttachment(fileOf('a.png', 'image/png'), fx);
    expect(res).toBeTruthy();
    // The row's workspaceId comes from ctx (the route resolves it from the
    // session's active project), never from the upload payload.
    const row = await adminDb.attachment.findFirst({ where: { workspaceId: fx.workspaceId } });
    expect(row!.workspaceId).toBe(fx.workspaceId);
  });
});
