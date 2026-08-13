import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { db } from '@/lib/db';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-2394, jobs 1 and 2 — the blob seam, driven END TO END.
//
// ⚠️ WHAT MAKES THIS SUITE DIFFERENT FROM THE CARDS' OWN TESTS, and why it has
// to exist separately. Every attachment / acceptance suite in this repository
// opens with `vi.mock('@/lib/blob/uploader', …)` — `tests/attachments/`
// attachments-service, attachments-management, acceptance-evidence-service,
// acceptance-gate, story-lifecycle and content-route all do. That is the right
// call for those files: they are testing the SERVICE's gates, and a real object
// store would only add noise. But it means the writer and its consumers are each
// tested against a stand-in of the other, and never once against each other.
//
// MOTIR-2389 is precisely the change that gap cannot see. Every exported
// signature in `lib/blob/uploader.ts` survived the move onto the S3 API by
// design, so every caller kept compiling and every mocked test kept passing
// whether or not the semantics survived — `putPrivateAttachment` returning a key
// the store does not actually hold, `signedDownloadUrl` addressing a bucket the
// object is not in, `headPrivateBlob` reporting a size nobody wrote. Only an
// assertion that takes what the REAL implementation produces and feeds it to the
// REAL consumer can tell the difference.
//
// So: no `vi.mock` here at all (the repository permits one, for `getSession`,
// and this suite does not need it). The uploader is the shipped module, the AWS
// SDK does its own serialization / SigV4 signing / presigning, the services are
// the shipped services, and Postgres is real. The only substitution is the
// SDK's HTTP TRANSPORT — `installBlobStoreMock()`, the same in-process store the
// E2E lane boots (`instrumentation.ts`) — which is a network, not a seam.

const ENV = {
  MOTIR_S3_ENDPOINT: 'https://s3.seam.invalid',
  MOTIR_S3_REGION: 'auto',
  MOTIR_S3_ACCESS_KEY_ID: 'seam-access-key',
  MOTIR_S3_SECRET_ACCESS_KEY: 'seam-secret-key',
  MOTIR_S3_PRIVATE_BUCKET: 'motir-private',
  MOTIR_S3_PUBLIC_BUCKET: 'motir-public',
  MOTIR_S3_PUBLIC_BASE_URL: 'https://s3.seam.invalid/motir-public',
} as const;

const { installBlobStoreMock } = await import('@/lib/test-blob-mock');
const { resetS3ClientForTests, s3Client } = await import('@/lib/blob/s3');
const { headPrivateBlob, putPrivateAttachment, signedDownloadUrl } =
  await import('@/lib/blob/uploader');
const { storedAssetUrl } = await import('@/lib/blob/referencedUrls');
const { attachmentsService } = await import('@/lib/services/attachmentsService');
const { acceptanceEvidenceService } = await import('@/lib/services/acceptanceEvidenceService');
const { usersService } = await import('@/lib/services/usersService');

const fileOf = (name: string, type: string, bytes = 8) =>
  new File([new Uint8Array(bytes)], name, { type });

async function makeStory(fx: WorkItemFixture) {
  return createTestWorkItem(fx, { kind: 'story', title: 'Hosting seam story' });
}

beforeEach(async () => {
  for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
  installBlobStoreMock();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
  // The transport lives on `globalThis` (it has to — Next loads instrumentation
  // in a different module graph), so it outlives this file inside a reused
  // worker unless it is taken down here.
  resetS3ClientForTests();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('seam: attachmentsService ← the REAL uploader (the key a service persists is the key the store holds)', () => {
  it('upload → the persisted blobPathname names an object that exists, with the bytes and type sent', async () => {
    const fx = await makeWorkItemFixture();
    const result = await attachmentsService.uploadAttachment(
      fileOf('report.pdf', 'application/pdf', 64),
      { userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId, projectId: fx.projectId },
    );

    const row = await adminDb.attachment.findUniqueOrThrow({ where: { id: result.id } });

    // THE assertion the mocks cannot make. `putPrivateAttachment` appends a
    // random suffix S3 does not add for us, so the key the service stores is
    // one the uploader INVENTED — and a HEAD through the real accessor is the
    // only thing that proves the object is actually there under that name.
    expect(row.blobPathname).not.toBe(`attachments/${fx.ctx.workspaceId}/report.pdf`);
    expect(row.blobPathname.startsWith(`attachments/${fx.ctx.workspaceId}/report`)).toBe(true);
    expect(await headPrivateBlob(row.blobPathname)).toEqual({
      size: 64,
      contentType: 'application/pdf',
    });
  });

  it('the object lands in the PRIVATE bucket only — a public read of the same key finds nothing', async () => {
    const fx = await makeWorkItemFixture();
    const result = await attachmentsService.uploadAttachment(fileOf('shot.png', 'image/png', 12), {
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      projectId: fx.projectId,
    });
    const row = await adminDb.attachment.findUniqueOrThrow({ where: { id: result.id } });

    // The two-bucket split is structural (lib/blob/s3.ts), so it is asserted
    // against the store rather than against the call: the same key resolves in
    // private and is absent in public.
    expect(await headPrivateBlob(row.blobPathname)).not.toBeNull();
    const publicUrl = storedAssetUrl(row.blobPathname);
    expect(publicUrl).toBe(`${ENV.MOTIR_S3_PUBLIC_BASE_URL}/${row.blobPathname}`);
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    await expect(
      s3Client().send(
        new GetObjectCommand({ Bucket: ENV.MOTIR_S3_PUBLIC_BUCKET, Key: row.blobPathname }),
      ),
    ).rejects.toBeTruthy();
  });

  it('getContentRedirect signs THAT object — the presigned GET addresses the persisted key', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Has an attachment' });
    const attached = await attachmentsService.attachToWorkItem(
      item.id,
      fileOf('spec.pdf', 'application/pdf', 20),
      fx.ctx,
    );
    const row = await adminDb.attachment.findUniqueOrThrow({ where: { id: attached.id } });

    const redirect = await attachmentsService.getContentRedirect(attached.id, fx.ctx);
    const url = new URL(redirect);

    // Path-style, private bucket, the exact stored key — and signed. A stub that
    // returned `https://blob.example/signed/<key>` satisfied every existing
    // assertion about this method; none of the four facts below survive it.
    expect(url.origin).toBe(ENV.MOTIR_S3_ENDPOINT);
    expect(url.pathname).toBe(`/${ENV.MOTIR_S3_PRIVATE_BUCKET}/${row.blobPathname}`);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('a download redirect binds the persisted filename into the signature', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Downloadable' });
    const attached = await attachmentsService.attachToWorkItem(
      item.id,
      fileOf('quarterly.pdf', 'application/pdf', 20),
      fx.ctx,
    );
    const row = await adminDb.attachment.findUniqueOrThrow({ where: { id: attached.id } });

    const url = new URL(
      await attachmentsService.getContentRedirect(attached.id, fx.ctx, { download: true }),
    );
    const basename = row.blobPathname.slice(row.blobPathname.lastIndexOf('/') + 1);

    expect(url.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="${basename}"`,
    );
    // Bound INTO the signature, not appended after it — S3 rejects an unsigned
    // response-header override, so a query switch would 403 at fetch time.
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBeTruthy();
  });

  it('deleteAttachment removes the OBJECT, not only the row', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'To be deleted' });
    const attached = await attachmentsService.attachToWorkItem(
      item.id,
      fileOf('junk.png', 'image/png'),
      fx.ctx,
    );
    const row = await adminDb.attachment.findUniqueOrThrow({ where: { id: attached.id } });
    expect(await headPrivateBlob(row.blobPathname)).not.toBeNull();

    await attachmentsService.deleteAttachment(attached.id, fx.ctx);

    const attachmentRow = await adminDb.attachment.findUnique({ where: { id: attached.id } });
    expect(attachmentRow).toBeNull();
    expect(await headPrivateBlob(row.blobPathname)).toBeNull();
  });
});

describe('seam: acceptanceEvidenceService ← the REAL uploader (a minted grant, an uploaded object, a recorded row)', () => {
  /** The bucket + key a presigned URL actually addresses. */
  function target(presigned: string): { bucket: string; key: string } {
    const [, bucket = '', ...rest] = new URL(presigned).pathname.split('/');
    return { bucket, key: decodeURIComponent(rest.join('/')) };
  }

  it('the minted PUT grant names the pathname the service reports, and binds its content type', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);

    const tokens = await acceptanceEvidenceService.createUploadTokens(
      { workItemId: story.id, hasTrace: true },
      fx.ctx,
    );

    for (const [artifact, type] of [
      [tokens.video, 'video/webm'],
      [tokens.trace!, 'application/zip'],
    ] as const) {
      const { bucket, key } = target(artifact.token);
      // The grant and the pathname the caller is told to upload to must be the
      // same object. They are produced by two different lines of the service,
      // and nothing but this compares them.
      expect(bucket).toBe(ENV.MOTIR_S3_PRIVATE_BUCKET);
      expect(key).toBe(artifact.pathname);
      expect(artifact.contentType).toBe(type);
      expect(new URL(artifact.token).searchParams.get('X-Amz-SignedHeaders')).toContain(
        'content-type',
      );
    }
  });

  it('recordFromPathnames reads size + contentType from the STORE, not from the caller', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    const tokens = await acceptanceEvidenceService.createUploadTokens(
      { workItemId: story.id, hasTrace: true },
      fx.ctx,
    );

    // The one hop this process cannot make is the HTTP PUT to the presigned URL
    // — that fetch belongs to a CI job on another host, and the E2E lane is where
    // it is exercised. So the object is placed at exactly the key the grant
    // addresses, with exactly the type it bound, and the rest of the path — the
    // service's HEAD, its caps, its persistence — is the shipped code.
    const videoBytes = 4096;
    const traceBytes = 128;
    await s3Client().send(
      new PutObjectCommand({
        Bucket: ENV.MOTIR_S3_PRIVATE_BUCKET,
        Key: target(tokens.video.token).key,
        Body: Buffer.alloc(videoBytes),
        ContentType: tokens.video.contentType,
      }),
    );
    await s3Client().send(
      new PutObjectCommand({
        Bucket: ENV.MOTIR_S3_PRIVATE_BUCKET,
        Key: target(tokens.trace!.token).key,
        Body: Buffer.alloc(traceBytes),
        ContentType: tokens.trace!.contentType,
      }),
    );

    const dto = await acceptanceEvidenceService.recordFromPathnames(
      {
        workItemId: story.id,
        videoPathname: tokens.video.pathname,
        tracePathname: tokens.trace!.pathname,
        commitSha: 'seam001',
        ciRunUrl: 'https://ci.example/run/2394',
        producedByKey: 'MOTIR-2394',
      },
      fx.ctx,
    );

    // Neither number was supplied by the caller: `recordFromPathnames` takes
    // pathnames only, so both came back through `headPrivateBlob` from the
    // object the uploader's own grant addressed.
    expect(dto.sizeBytes).toBe(videoBytes);
    expect(dto.mimeType).toBe('video/webm');
    expect(dto.status).toBe('pending');

    // The trace's size is not on the DTO, so it is read where the service put
    // it — and it is the store's number too, for the same reason.
    const trace = await adminDb.attachment.findFirstOrThrow({
      where: { blobPathname: tokens.trace!.pathname },
    });
    expect(trace.sizeBytes).toBe(traceBytes);
    expect(trace.mimeType).toBe('application/zip');
  });

  it('a grant with nothing uploaded behind it is REFUSED — the HEAD is a real read', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    const tokens = await acceptanceEvidenceService.createUploadTokens(
      { workItemId: story.id, hasTrace: false },
      fx.ctx,
    );

    // The failure mode a mocked `headPrivateBlob` cannot produce: minting a
    // token is not uploading, and the register step has to notice.
    await expect(
      acceptanceEvidenceService.recordFromPathnames(
        { workItemId: story.id, videoPathname: tokens.video.pathname },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ code: 'ACCEPTANCE_EVIDENCE_BLOB_MISSING' });
    const acceptanceEvidenceCount = await adminDb.acceptanceEvidence.count({
      where: { workItemId: story.id },
    });
    expect(acceptanceEvidenceCount).toBe(0);
  });

  it('recordFromUpload → the recorded pathname is an object the store really holds', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);

    const dto = await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: fileOf('run.webm', 'video/webm', 2048) },
      fx.ctx,
    );

    // The evidence row points at an `acceptance_video` Attachment, and THAT is
    // where the key the uploader minted is persisted.
    const evidence = await adminDb.acceptanceEvidence.findFirstOrThrow({
      where: { workItemId: story.id, isCurrent: true },
    });
    const video = await adminDb.attachment.findUniqueOrThrow({
      where: { id: evidence.attachmentId! },
    });
    expect(dto.sizeBytes).toBe(2048);
    expect(video.source).toBe('acceptance_video');
    expect(await headPrivateBlob(video.blobPathname)).toEqual({
      size: 2048,
      contentType: 'video/webm',
    });
  });
});

describe('seam: usersService ← the REAL uploader (a KEY is persisted, a URL is composed on read)', () => {
  it('uploadAvatar → updateProfile stores the KEY, and the DTO resolves it to an absolute URL', async () => {
    const fx = await makeWorkItemFixture();

    const { key } = await usersService.uploadAvatar(
      fileOf('me.png', 'image/png', 30),
      fx.ctx.userId,
    );

    // MOTIR-2404's whole point: no origin reaches the column. The key the
    // uploader minted is the value the gate accepts and the row keeps.
    expect(key.startsWith(`avatars/${fx.ctx.userId}/`)).toBe(true);
    expect(key).not.toContain('://');

    const profile = await usersService.updateProfile(fx.ctx.userId, { image: key });
    const row = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ctx.userId } });

    expect(row.image).toBe(key);
    expect(profile.image).toBe(`${ENV.MOTIR_S3_PUBLIC_BASE_URL}/${key}`);
  });

  it('replacing an avatar deletes the PRIOR object from the public bucket', async () => {
    const fx = await makeWorkItemFixture();
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const headPublic = async (key: string) => {
      try {
        return await s3Client().send(
          new HeadObjectCommand({ Bucket: ENV.MOTIR_S3_PUBLIC_BUCKET, Key: key }),
        );
      } catch {
        return null;
      }
    };

    const first = await usersService.uploadAvatar(fileOf('a.png', 'image/png', 10), fx.ctx.userId);
    await usersService.updateProfile(fx.ctx.userId, { image: first.key });
    const second = await usersService.uploadAvatar(fileOf('b.png', 'image/png', 11), fx.ctx.userId);
    await usersService.updateProfile(fx.ctx.userId, { image: second.key });

    // The GC runs against the real store, so "collected" means the object is
    // gone — not that a mock recorded a call.
    expect(await headPublic(first.key)).toBeNull();
    expect(await headPublic(second.key)).not.toBeNull();
  });
});

describe('the coverage floor — the uploader branches no card’s own test reaches', () => {
  // Job 1. These are not new behaviour; they are the arms `lib/blob/uploader.ts`
  // and `lib/blob/s3.ts` grew when MOTIR-2389 had to reimplement, in our code,
  // what the old provider did server-side. Measured on this branch before they
  // were written, `uploader.ts` sat at 76.19% branches — under the repository's
  // per-file gate, and under it in exactly the places a provider swap is most
  // likely to be wrong.

  it('a key with NO extension gets the suffix appended, not infixed', async () => {
    const { pathname } = await putPrivateAttachment(
      'attachments/w1/README',
      new Blob(['x']),
      'text/plain',
    );
    expect(pathname).toMatch(/^attachments\/w1\/README-[0-9a-f]{10}$/);
  });

  it('a DOT in a directory segment is not mistaken for an extension', async () => {
    // The `dot <= lastIndexOf('/')` arm: `v1.2/README` has a dot BEFORE the last
    // slash, so the name has no extension and the suffix must still append.
    const { pathname } = await putPrivateAttachment(
      'attachments/v1.2/README',
      new Blob(['x']),
      'text/plain',
    );
    expect(pathname).toMatch(/^attachments\/v1\.2\/README-[0-9a-f]{10}$/);
  });

  it('accepts a Buffer and an ArrayBuffer body, storing the same bytes as a Blob would', async () => {
    // `PutObjectCommand` cannot size a `File`/`Blob` in Node, so `toBuffer`
    // normalizes three input shapes. Only the Blob arm had a caller under test.
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    const fromBuffer = await putPrivateAttachment(
      'attachments/w1/buf.bin',
      Buffer.from(bytes),
      'application/octet-stream',
    );
    const fromArrayBuffer = await putPrivateAttachment(
      'attachments/w1/ab.bin',
      bytes.buffer.slice(0),
      'application/octet-stream',
    );

    expect(await headPrivateBlob(fromBuffer.pathname)).toEqual({
      size: 5,
      contentType: 'application/octet-stream',
    });
    expect(await headPrivateBlob(fromArrayBuffer.pathname)).toEqual({
      size: 5,
      contentType: 'application/octet-stream',
    });
  });

  it('headPrivateBlob defaults a store that reports NEITHER length nor type', async () => {
    // The `?? 0` / `?? 'application/octet-stream'` arms, and they are not
    // theoretical: `Content-Type` is optional on an S3 HEAD response, and a
    // store answering a 200 without it is what the register step then divides
    // its cap check by. The in-process fake always sets both headers, so the
    // arms need a transport that answers the way a terser store does.
    const { installObjectStoreTransport } = await import('@/lib/blob/s3');
    const { Readable } = await import('node:stream');
    installObjectStoreTransport({
      async handle() {
        return {
          response: { statusCode: 200, reason: 'OK', headers: {}, body: Readable.from([]) },
        };
      },
    });

    expect(await headPrivateBlob('acceptance/w1/terse.webm')).toEqual({
      size: 0,
      contentType: 'application/octet-stream',
    });
  });

  it('an unset MOTIR_S3_REGION falls back to `auto` rather than failing to sign', async () => {
    // Tigris is region-less, so the region is defaulted rather than required —
    // and the SDK refuses to sign without one. The proof is that a presign still
    // succeeds and carries the default in its credential scope.
    delete process.env['MOTIR_S3_REGION'];
    resetS3ClientForTests();
    installBlobStoreMock();

    const credential = new URL(await signedDownloadUrl('attachments/w1/x.pdf')).searchParams.get(
      'X-Amz-Credential',
    );
    expect(credential).toContain('/auto/s3/aws4_request');
  });
});
