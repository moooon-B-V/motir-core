import { unzipSync, strFromU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE PERSONAL-DATA EXPORT, end to end (Story 8.4 · Subtask MOTIR-3701),
// against a REAL Postgres — the repo's testing contract, and the only way to
// test what this card's criteria actually assert. The scope rule is enforced by
// RLS, the archive is opened as a zip rather than inspected as a plan, and the
// expiry is a head request against a blob. All three are properties of systems
// outside this process; a mocked repository would assert that we called a
// function.
//
// ⚠️ THE ARCHIVE IS OPENED, NEVER INTROSPECTED. Every assertion about what is
// in the export reads the ZIP BYTES back through an unzip — the card's criterion
// says so, and it is the difference between testing the artifact and testing the
// builder's intentions. A builder that assembled the right inputs and wrote a
// corrupt container would pass the second and fail a reader.

// ── the blob store, in memory ─────────────────────────────────────────────
// `lib/blob/uploader` is the network seam; its own header says tests mock THIS
// module so nothing hits S3. The store is real enough to answer a HEAD after a
// delete, which is what the expiry criterion is asserted with.
const blobs = new Map<string, { bytes: Buffer; contentType: string }>();
const putPrivateAttachment = vi.fn(async (pathname: string, body: Buffer, contentType: string) => {
  blobs.set(pathname, { bytes: Buffer.from(body), contentType });
  return { pathname };
});
const putPublicAsset = vi.fn(async () => {
  throw new Error('the export must never write a PUBLIC asset');
});

vi.mock('@/lib/blob/uploader', () => ({
  putPrivateAttachment: (...a: Parameters<typeof putPrivateAttachment>) =>
    putPrivateAttachment(...a),
  putPublicAsset: (...a: unknown[]) => (putPublicAsset as (...x: unknown[]) => unknown)(...a),
  putAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  mintPrivateUploadToken: vi.fn(),
  getPrivateBlobBytes: vi.fn(async (pathname: string) => blobs.get(pathname)?.bytes ?? null),
  deleteAttachmentBlob: vi.fn(async (pathname: string) => {
    blobs.delete(pathname);
  }),
  headPrivateBlob: vi.fn(async (pathname: string) => {
    const hit = blobs.get(pathname);
    return hit ? { size: hit.bytes.byteLength, contentType: hit.contentType } : null;
  }),
}));

// ── the event bus ─────────────────────────────────────────────────────────
const emitted: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    emitted.push({ name, data });
  },
}));

const { dataExportService } = await import('@/lib/services/dataExportService');
const { headPrivateBlob } = await import('@/lib/blob/uploader');
const { PERSONAL_DATA_SECTIONS } = await import('@/lib/export/personalDataSections');
const { DATA_EXPORT_RETENTION_DAYS } = await import('@/lib/users/dataSubjectRequests');
const { attachmentArchivePath } = await import('@/lib/export/personalDataArchive');
const { dataExportRequestRepository } =
  await import('@/lib/repositories/dataExportRequestRepository');
const { withSystemContext } = await import('@/lib/workspaces/context');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Open the archive the service uploaded, as a reader would. */
function openArchive(pathname: string): Record<string, Uint8Array> {
  const stored = blobs.get(pathname);
  expect(stored, `no blob at ${pathname}`).toBeDefined();
  // The zip magic — proof this is a container, before we trust any reader.
  expect(Array.from(stored!.bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  return unzipSync(stored!.bytes);
}

function readJson(
  entries: Record<string, Uint8Array>,
  name: string,
): {
  table: string;
  rows: Array<Record<string, unknown>>;
} {
  expect(Object.keys(entries), `${name} missing from archive`).toContain(name);
  return JSON.parse(strFromU8(entries[name]!));
}

interface Fixture {
  userId: string;
  otherUserId: string;
  sharedWorkspaceId: string;
  foreignWorkspaceId: string;
  attachmentId: string;
  attachmentPathname: string;
  secretComment: string;
}

/**
 * A fully-populated exporting user, plus a stranger whose data must NOT appear.
 *
 * TWO kinds of unreadable data, because they fail differently:
 *   - rows in a workspace the exporter is NOT a member of (RLS never admits
 *     them — the scope rule's real subject), and
 *   - rows in a workspace they ARE in, authored by somebody else (admitted by
 *     RLS, excluded because they are not this person's data).
 * An implementation could pass either one alone and leak the other.
 */
async function makeFixture(): Promise<Fixture> {
  const org = await adminDb.organization.create({
    data: { name: 'Export Org', slug: `export-org-${Date.now()}` },
  });
  const user = await adminDb.user.create({
    data: { email: `exporter-${Date.now()}@example.com`, name: 'Exporter', emailVerified: true },
  });
  const other = await adminDb.user.create({
    data: { email: `stranger-${Date.now()}@example.com`, name: 'Stranger', emailVerified: true },
  });

  const shared = await adminDb.workspace.create({
    data: { name: 'Shared', slug: `shared-${Date.now()}`, organizationId: org.id },
  });
  const foreign = await adminDb.workspace.create({
    data: { name: 'Foreign', slug: `foreign-${Date.now()}`, organizationId: org.id },
  });

  // The exporter is a member of `shared` ONLY.
  await adminDb.workspaceMembership.create({ data: { userId: user.id, workspaceId: shared.id } });
  await adminDb.organizationMembership.create({
    data: { organizationId: org.id, userId: user.id, role: 'member' },
  });
  await adminDb.workspaceMembership.create({
    data: { userId: other.id, workspaceId: shared.id },
  });
  await adminDb.workspaceMembership.create({
    data: { userId: other.id, workspaceId: foreign.id },
  });

  const project = await adminDb.project.create({
    data: { workspaceId: shared.id, name: 'Proj', slug: 'proj', identifier: 'PROJ' },
  });
  const foreignProject = await adminDb.project.create({
    data: { workspaceId: foreign.id, name: 'Far', slug: 'far', identifier: 'FAR' },
  });

  // The exporter's own identity-tier rows.
  await adminDb.account.create({
    data: {
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      // The two things that must never reach the archive.
      password: 'HASH-DO-NOT-EXPORT',
      accessToken: 'TOKEN-DO-NOT-EXPORT',
    },
  });
  await adminDb.session.create({
    data: {
      userId: user.id,
      token: 'SESSION-TOKEN-DO-NOT-EXPORT',
      expiresAt: new Date(Date.now() + DAY_MS),
      ipAddress: '203.0.113.9',
      userAgent: 'Firefox',
    },
  });
  await adminDb.legalAcceptance.create({
    data: { userId: user.id, documentSlug: 'privacy', version: '2026-01-01' },
  });

  // Tenant-tier rows in the SHARED workspace — the exporter's own.
  const item = await adminDb.workItem.create({
    data: {
      workspaceId: shared.id,
      projectId: project.id,
      kind: 'task',
      key: 1,
      identifier: 'PROJ-1',
      title: 'The exporter’s own task',
      reporterId: user.id,
      position: 'a0',
    },
  });
  await adminDb.comment.create({
    data: {
      workspaceId: shared.id,
      workItemId: item.id,
      authorId: user.id,
      bodyMd: 'A comment the exporter wrote.',
    },
  });
  await adminDb.watcher.create({ data: { workItemId: item.id, userId: user.id } });

  const attachmentPathname = `attachments/${shared.id}/report.pdf`;
  blobs.set(attachmentPathname, {
    bytes: Buffer.from('PDF-BYTES-BELONGING-TO-THE-EXPORTER'),
    contentType: 'application/pdf',
  });
  const attachment = await adminDb.attachment.create({
    data: {
      workspaceId: shared.id,
      uploaderUserId: user.id,
      workItemId: item.id,
      blobPathname: attachmentPathname,
      mimeType: 'application/pdf',
      sizeBytes: 35,
      originalFilename: 'report.pdf',
    },
  });

  // (a) A stranger's comment in the SHARED workspace — readable by the
  //     exporter in the product, and still not their personal data.
  const secretComment = 'STRANGER-COMMENT-IN-SHARED-WORKSPACE';
  await adminDb.comment.create({
    data: {
      workspaceId: shared.id,
      workItemId: item.id,
      authorId: other.id,
      bodyMd: secretComment,
    },
  });

  // (b) A stranger's work item in a workspace the exporter cannot reach at all.
  await adminDb.workItem.create({
    data: {
      workspaceId: foreign.id,
      projectId: foreignProject.id,
      kind: 'task',
      key: 1,
      identifier: 'FAR-1',
      title: 'FOREIGN-WORKSPACE-ITEM',
      reporterId: other.id,
      position: 'a0',
    },
  });

  // (c) ⚠️ THE ONE FIXTURE THAT MAKES THE SCOPE ASSERTION LOAD-BEARING: an item
  // in the unreachable workspace that the EXPORTER reported — someone who left
  // a workspace, or was removed from one. Rows (a) and (b) are excluded by the
  // attribution filter alone, so an implementation that ignored access entirely
  // would still pass them. This row matches `reporterId = the exporter` exactly,
  // so the ONLY thing that can keep it out of the archive is that the export
  // never reaches a workspace they are not a member of. It is also the precise
  // case DECISION 1's "as far as their access reaches" clause is written about.
  await adminDb.workItem.create({
    data: {
      workspaceId: foreign.id,
      projectId: foreignProject.id,
      kind: 'task',
      key: 2,
      identifier: 'FAR-2',
      title: 'EXPORTER-REPORTED-BUT-NO-LONGER-READABLE',
      reporterId: user.id,
      position: 'a1',
    },
  });

  return {
    userId: user.id,
    otherUserId: other.id,
    sharedWorkspaceId: shared.id,
    foreignWorkspaceId: foreign.id,
    attachmentId: attachment.id,
    attachmentPathname,
    secretComment,
  };
}

beforeEach(async () => {
  blobs.clear();
  emitted.length = 0;
  putPrivateAttachment.mockClear();
  await truncateAuthTables();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('requestDataExport', () => {
  it('writes ONE preparing row and emits the build event', async () => {
    const f = await makeFixture();
    const result = await dataExportService.requestDataExport(f.userId);

    expect(result.started).toBe(true);
    expect(result.request.status).toBe('preparing');
    expect(result.request.blobPathname).toBeNull();

    const rows = await adminDb.dataExportRequest.findMany({ where: { userId: f.userId } });
    expect(rows).toHaveLength(1);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.name).toBe('account/data-export.requested');
    expect(emitted[0]!.data).toMatchObject({
      userId: f.userId,
      requestId: result.request.id,
      // Identity-scoped: an export spans every workspace, so it has no single
      // owning tenant (the `email.send` carve-out).
      workspaceId: null,
    });
  });

  it('returns the EXISTING row and starts NO second build while one is preparing', async () => {
    const f = await makeFixture();
    const first = await dataExportService.requestDataExport(f.userId);
    emitted.length = 0;

    const second = await dataExportService.requestDataExport(f.userId);

    expect(second.started).toBe(false);
    expect(second.request.id).toBe(first.request.id);
    expect(await adminDb.dataExportRequest.count({ where: { userId: f.userId } })).toBe(1);
    expect(emitted, 'a second build event would build a second archive').toHaveLength(0);
  });

  it('allows a NEW request once the previous one is no longer preparing', async () => {
    const f = await makeFixture();
    const first = await dataExportService.requestDataExport(f.userId);
    await adminDb.dataExportRequest.update({
      where: { id: first.request.id },
      data: { status: 'expired' },
    });

    const second = await dataExportService.requestDataExport(f.userId);
    expect(second.started).toBe(true);
    expect(second.request.id).not.toBe(first.request.id);
  });
});

describe('the built archive', () => {
  it('is a zip of JSON-per-table plus the uploaded files, uploaded PRIVATELY', async () => {
    const f = await makeFixture();
    const { request } = await dataExportService.requestDataExport(f.userId);

    const outcome = await dataExportService.buildDataExport({
      userId: f.userId,
      requestId: request.id,
    });
    expect(outcome.status).toBe('ready');

    const row = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.status).toBe('ready');
    expect(row.blobPathname).toBeTruthy();
    expect(row.builtAt).toBeTruthy();
    expect(row.failureReason).toBeNull();

    // PRIVATE, and only private. A public asset would make the whole archive
    // world-readable to anyone who learned the URL.
    expect(putPrivateAttachment).toHaveBeenCalledTimes(1);
    expect(putPublicAsset).not.toHaveBeenCalled();
    expect(putPrivateAttachment.mock.calls[0]![2]).toBe('application/zip');
    expect(row.blobPathname).toMatch(/^exports\/.*\/motir-export-\d{4}-\d{2}-\d{2}\.zip$/);

    const entries = openArchive(row.blobPathname!);

    // The reader's own file, by the path the JSON references it by.
    const filePath = attachmentArchivePath(f.attachmentId, 'report.pdf');
    expect(Object.keys(entries)).toContain(filePath);
    expect(strFromU8(entries[filePath]!)).toBe('PDF-BYTES-BELONGING-TO-THE-EXPORTER');

    const attachments = readJson(entries, 'attachment.json');
    expect(attachments.rows).toHaveLength(1);
    expect(attachments.rows[0]!.id).toBe(f.attachmentId);

    const manifest = JSON.parse(strFromU8(entries['manifest.json']!));
    expect(manifest.files).toEqual({ packaged: 1, missing: 0 });
  });

  it('sets expiresAt to builtAt + the retention window, from the named constant', async () => {
    const f = await makeFixture();
    const { request } = await dataExportService.requestDataExport(f.userId);
    await dataExportService.buildDataExport({ userId: f.userId, requestId: request.id });

    const row = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.expiresAt!.getTime() - row.builtAt!.getTime()).toBe(
      DATA_EXPORT_RETENTION_DAYS * DAY_MS,
    );
  });

  it('contains a section for EVERY enumerated table', async () => {
    // The card's criterion, and the reason the enumeration is data: a table on
    // the list with no section in the archive is the failure a hand-written list
    // produces silently.
    const f = await makeFixture();
    const { request } = await dataExportService.requestDataExport(f.userId);
    await dataExportService.buildDataExport({ userId: f.userId, requestId: request.id });
    const row = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    const entries = openArchive(row.blobPathname!);

    for (const section of PERSONAL_DATA_SECTIONS) {
      const doc = readJson(entries, `${section.table}.json`);
      expect(doc.table).toBe(section.table);
      expect(Array.isArray(doc.rows)).toBe(true);
    }

    const manifest = JSON.parse(strFromU8(entries['manifest.json']!));
    expect(manifest.tables.map((t: { table: string }) => t.table)).toEqual(
      PERSONAL_DATA_SECTIONS.map((s) => s.table),
    );
  });

  it('populates the sections the fixture filled — an empty archive is not a pass', async () => {
    // Without this, the totality assertion above is satisfied by 44 empty files.
    const f = await makeFixture();
    const { request } = await dataExportService.requestDataExport(f.userId);
    await dataExportService.buildDataExport({ userId: f.userId, requestId: request.id });
    const row = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    const entries = openArchive(row.blobPathname!);

    // One from each tier, plus the row the export is about.
    expect(readJson(entries, 'user.json').rows).toHaveLength(1);
    expect(readJson(entries, 'account.json').rows).toHaveLength(1);
    expect(readJson(entries, 'session.json').rows).toHaveLength(1);
    expect(readJson(entries, 'legal_acceptance.json').rows).toHaveLength(1);
    expect(readJson(entries, 'workspace_membership.json').rows).toHaveLength(1);
    expect(readJson(entries, 'work_item.json').rows).toHaveLength(1);
    expect(readJson(entries, 'comment.json').rows).toHaveLength(1);
    expect(readJson(entries, 'watcher.json').rows).toHaveLength(1);
    expect(readJson(entries, 'attachment.json').rows).toHaveLength(1);
    expect(readJson(entries, 'data_export_request.json').rows).toHaveLength(1);
  });

  it('never exports a credential, on any table', async () => {
    const f = await makeFixture();
    const { request } = await dataExportService.requestDataExport(f.userId);
    await dataExportService.buildDataExport({ userId: f.userId, requestId: request.id });
    const row = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    const entries = openArchive(row.blobPathname!);

    // Asserted over the WHOLE archive rather than per table: a secret that
    // leaked through a section nobody thought to check is the case that matters.
    const whole = Object.entries(entries)
      .filter(([name]) => name.endsWith('.json'))
      .map(([, bytes]) => strFromU8(bytes))
      .join('\n');
    expect(whole).not.toContain('HASH-DO-NOT-EXPORT');
    expect(whole).not.toContain('TOKEN-DO-NOT-EXPORT');
    expect(whole).not.toContain('SESSION-TOKEN-DO-NOT-EXPORT');

    // …and the surrounding rows DID ship, so the assertion above is about
    // redaction rather than about an empty section.
    const accounts = readJson(entries, 'account.json');
    expect(accounts.rows[0]!.providerId).toBe('credential');
    expect(accounts.rows[0]).not.toHaveProperty('password');
    const sessions = readJson(entries, 'session.json');
    expect(sessions.rows[0]!.ipAddress).toBe('203.0.113.9');
    expect(sessions.rows[0]).not.toHaveProperty('token');
  });
});

describe('the scope rule — an export is not a privilege escalation', () => {
  it('omits rows from a workspace the reader is not a member of', async () => {
    const f = await makeFixture();
    const { request } = await dataExportService.requestDataExport(f.userId);
    await dataExportService.buildDataExport({ userId: f.userId, requestId: request.id });
    const row = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    const entries = openArchive(row.blobPathname!);

    const whole = Object.entries(entries)
      .filter(([name]) => name.endsWith('.json'))
      .map(([, bytes]) => strFromU8(bytes))
      .join('\n');

    expect(whole).not.toContain('FOREIGN-WORKSPACE-ITEM');
    expect(whole).not.toContain(f.foreignWorkspaceId);

    // The load-bearing one: a row the ATTRIBUTION filter matches, kept out
    // solely because the reader's access does not reach that workspace. An
    // export that queried tenant tables globally — or under a system context —
    // would ship this and pass every other assertion in this file.
    expect(
      whole,
      'an item the reader reported in a workspace they are no longer in is beyond their access',
    ).not.toContain('EXPORTER-REPORTED-BUT-NO-LONGER-READABLE');

    // …and the item they CAN reach did ship, so the assertion above is about
    // scope rather than about an empty section.
    const items = readJson(entries, 'work_item.json');
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0]!.identifier).toBe('PROJ-1');

    const manifest = JSON.parse(strFromU8(entries['manifest.json']!));
    expect(manifest.workspaceIds).toEqual([f.sharedWorkspaceId]);
  });

  it("omits another member's rows from a workspace the reader IS in", async () => {
    const f = await makeFixture();
    const { request } = await dataExportService.requestDataExport(f.userId);
    await dataExportService.buildDataExport({ userId: f.userId, requestId: request.id });
    const row = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    const entries = openArchive(row.blobPathname!);

    const comments = readJson(entries, 'comment.json');
    expect(comments.rows).toHaveLength(1);
    expect(comments.rows[0]!.bodyMd).toBe('A comment the exporter wrote.');

    const whole = Object.entries(entries)
      .filter(([name]) => name.endsWith('.json'))
      .map(([, bytes]) => strFromU8(bytes))
      .join('\n');
    expect(whole).not.toContain(f.secretComment);
  });
});

describe('a failed build', () => {
  it('marks the row failed with a reason and does NOT throw into the caller', async () => {
    const f = await makeFixture();
    const { request } = await dataExportService.requestDataExport(f.userId);
    putPrivateAttachment.mockRejectedValueOnce(new Error('blob store unreachable'));

    const outcome = await dataExportService.buildDataExport({
      userId: f.userId,
      requestId: request.id,
    });

    expect(outcome.status).toBe('failed');
    const row = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.status).toBe('failed');
    expect(row.failureReason).toContain('blob store unreachable');
    expect(row.blobPathname).toBeNull();
  });
});

describe('the expiry sweep', () => {
  it('expires a ready archive past its window AND deletes its blob', async () => {
    const f = await makeFixture();
    const { request } = await dataExportService.requestDataExport(f.userId);
    await dataExportService.buildDataExport({ userId: f.userId, requestId: request.id });
    const built = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    const pathname = built.blobPathname!;

    // It is there before the sweep — otherwise the assertion after it proves
    // nothing.
    expect(await headPrivateBlob(pathname)).not.toBeNull();

    const summary = await dataExportService.sweepExpiredDataExports({
      now: new Date(built.expiresAt!.getTime() + 1000),
    });

    expect(summary).toMatchObject({ scanned: 1, expired: 1, failed: 0 });
    const after = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.status).toBe('expired');
    // A non-null pathname means "there is a file to serve" (the model's own
    // contract), so it is cleared with the status.
    expect(after.blobPathname).toBeNull();
    // The seven-day promise, kept: the object is gone.
    expect(await headPrivateBlob(pathname)).toBeNull();
  });

  it('leaves an archive INSIDE its window alone', async () => {
    const f = await makeFixture();
    const { request } = await dataExportService.requestDataExport(f.userId);
    await dataExportService.buildDataExport({ userId: f.userId, requestId: request.id });
    const built = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });

    const summary = await dataExportService.sweepExpiredDataExports({
      now: new Date(built.expiresAt!.getTime() - 1000),
    });

    expect(summary).toMatchObject({ scanned: 0, expired: 0 });
    const after = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.status).toBe('ready');
    expect(await headPrivateBlob(built.blobPathname!)).not.toBeNull();
  });

  it('leaves the row READY when the blob delete fails, so the next run retries', async () => {
    const f = await makeFixture();
    const { request } = await dataExportService.requestDataExport(f.userId);
    await dataExportService.buildDataExport({ userId: f.userId, requestId: request.id });
    const built = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });

    const uploader = await import('@/lib/blob/uploader');
    vi.mocked(uploader.deleteAttachmentBlob).mockRejectedValueOnce(new Error('S3 down'));

    const summary = await dataExportService.sweepExpiredDataExports({
      now: new Date(built.expiresAt!.getTime() + 1000),
    });

    expect(summary).toMatchObject({ scanned: 1, expired: 0, failed: 1 });
    const after = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    // Marking it expired here would say "the file is gone" about a file that is
    // still there — the row keeps its pathname so the next run finds it again.
    expect(after.status).toBe('ready');
    expect(after.blobPathname).toBe(built.blobPathname);
  });

  it('reads only READY rows — a preparing row has no window and no blob', async () => {
    const f = await makeFixture();
    await dataExportService.requestDataExport(f.userId);

    const rows = await withSystemContext((tx) =>
      dataExportRequestRepository.listExpirable(
        { now: new Date(Date.now() + 400 * DAY_MS), take: 10 },
        tx,
      ),
    );
    expect(rows).toHaveLength(0);
  });
});
