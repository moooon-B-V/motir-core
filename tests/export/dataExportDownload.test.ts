import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/account/data-export/[id]/download (Story 8.4 · Subtask MOTIR-3703) —
// the authenticated hand-over of a built personal-data archive, against a REAL
// Postgres and the REAL presigner.
//
// ⚠️ THE PRESIGN IS NOT STUBBED, and that is deliberate rather than thorough.
// Presigning is local crypto — `getSignedUrl` touches no network — so the whole
// path from the row to the `Location` header can run for real, and every
// assertion below reads the URL the browser would actually be sent to. A stub
// returning `https://example/signed/<key>` would agree with the code by
// construction and could not see a missing TTL, an unbound disposition, or a
// URL that never changed between clicks (`tests/attachments/blob-uploader.test.ts`
// makes the same call, one layer down).
//
// The only mocks are the two seams the environment cannot provide: `getSession`
// (no cookies — CLAUDE.md's single sanctioned mock) and `next/headers`.

const S3_ENV = {
  MOTIR_S3_ENDPOINT: 'https://s3.test.invalid',
  MOTIR_S3_REGION: 'auto',
  MOTIR_S3_ACCESS_KEY_ID: 'test-access-key',
  MOTIR_S3_SECRET_ACCESS_KEY: 'test-secret-key',
  MOTIR_S3_PRIVATE_BUCKET: 'motir-private',
  MOTIR_S3_PUBLIC_BUCKET: 'motir-public',
  MOTIR_S3_PUBLIC_BASE_URL: 'https://s3.test.invalid/motir-public',
} as const;
Object.assign(process.env, S3_ENV);

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'localhost:3000', 'x-forwarded-proto': 'http' }),
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: vi.fn() };
});

const { db } = await import('@/lib/db');
const { getSession } = await import('@/lib/auth');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { resetS3ClientForTests } = await import('@/lib/blob/s3');
const { GET } = await import('@/app/api/account/data-export/[id]/download/route');

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = 'http://localhost:3000';

interface Fixture {
  userId: string;
  otherUserId: string;
}

let seq = 0;

async function makeFixture(): Promise<Fixture> {
  seq += 1;
  const user = await adminDb.user.create({
    data: { email: `owner-${seq}-${Date.now()}@example.com`, name: 'Owner', emailVerified: true },
  });
  const other = await adminDb.user.create({
    data: {
      email: `stranger-${seq}-${Date.now()}@example.com`,
      name: 'Stranger',
      emailVerified: true,
    },
  });
  return { userId: user.id, otherUserId: other.id };
}

/** A row in whatever state the case is about. `ready` unless told otherwise. */
async function makeExport(
  userId: string,
  overrides: {
    status?: 'preparing' | 'ready' | 'failed' | 'expired';
    blobPathname?: string | null;
    expiresAt?: Date | null;
  } = {},
) {
  const builtAt = new Date();
  const status = overrides.status ?? 'ready';
  return adminDb.dataExportRequest.create({
    data: {
      userId,
      requestedAt: builtAt,
      status,
      builtAt: status === 'preparing' ? null : builtAt,
      blobPathname:
        overrides.blobPathname === undefined
          ? `exports/${userId}/motir-export-2026-08-28-a1b2c3.zip`
          : overrides.blobPathname,
      expiresAt:
        overrides.expiresAt === undefined
          ? new Date(builtAt.getTime() + 7 * DAY_MS)
          : overrides.expiresAt,
    },
  });
}

function signInAs(userId: string) {
  vi.mocked(getSession).mockResolvedValue({
    user: { id: userId },
  } as unknown as Awaited<ReturnType<typeof getSession>>);
}

const call = (id: string) =>
  GET(new Request(`${BASE}/api/account/data-export/${id}/download`), {
    params: Promise.resolve({ id }),
  });

beforeEach(async () => {
  vi.mocked(getSession).mockResolvedValue(null);
  resetS3ClientForTests();
  Object.assign(process.env, S3_ENV);
  await truncateAuthTables();
});

afterAll(async () => {
  resetS3ClientForTests();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('GET /api/account/data-export/[id]/download', () => {
  it('no session → 401, and nothing is presigned', async () => {
    const fx = await makeFixture();
    const row = await makeExport(fx.userId);

    const res = await call(row.id);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('a READY export belonging to the caller → 302 to a freshly minted presigned URL', async () => {
    const fx = await makeFixture();
    const row = await makeExport(fx.userId);
    signInAs(fx.userId);

    const res = await call(row.id);
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location')!);
    // The real presigner's artefact, read off the wire rather than asserted
    // about: the private bucket, this row's object, a signature, and the ADR's
    // 300-second TTL.
    expect(location.origin + location.pathname).toBe(
      `https://s3.test.invalid/motir-private/${row.blobPathname}`,
    );
    expect(location.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(location.searchParams.get('X-Amz-Expires')).toBe('300');
    // `download: true` — the browser SAVES the archive rather than rendering it,
    // and the disposition is bound INTO the signature (it is a signed header,
    // not an appended query switch).
    expect(location.searchParams.get('response-content-disposition')).toContain(
      'attachment; filename="motir-export-2026-08-28-a1b2c3.zip"',
    );
    expect(location.searchParams.get('X-Amz-SignedHeaders')).toBeTruthy();
  });

  it('two consecutive requests produce TWO DIFFERENT URLs — never a reused grant', async () => {
    const fx = await makeFixture();
    const row = await makeExport(fx.userId);
    signInAs(fx.userId);

    const first = await call(row.id);
    // ⚠️ A REAL SECOND, not a fake timer. A SigV4 presignature is a pure
    // function of the request plus `X-Amz-Date`, which has SECOND resolution —
    // so two presigns inside one second are legitimately byte-identical, and
    // asserting difference without moving the clock would be asserting a race.
    // The point of the criterion is that the route MINTS on every click instead
    // of handing back a stored grant, and a second is what makes that visible.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await call(row.id);

    const a = first.headers.get('location')!;
    const b = second.headers.get('location')!;
    expect(a).not.toEqual(b);
    // Different signature, SAME object — a fresh grant for the same file, not a
    // different file.
    expect(new URL(a).pathname).toBe(new URL(b).pathname);
    expect(new URL(a).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(b).searchParams.get('X-Amz-Signature'),
    );
  });

  it('NO presigned URL is written to the database — the row after two downloads carries none', async () => {
    const fx = await makeFixture();
    const row = await makeExport(fx.userId);
    signInAs(fx.userId);

    await call(row.id);
    await call(row.id);

    const persisted = await adminDb.dataExportRequest.findUniqueOrThrow({ where: { id: row.id } });
    // Grep the WHOLE row rather than the one column we expect to be clean: a
    // minted grant leaking into `failureReason` or a future column would be the
    // same defect, and this assertion does not have to be updated to see it.
    const serialised = JSON.stringify(persisted);
    expect(serialised).not.toContain('X-Amz-Signature');
    expect(serialised).not.toContain('X-Amz-Credential');
    expect(serialised).not.toContain('https://');
    // The pathname is a KEY, which is what the model promises.
    expect(persisted.blobPathname).toBe(row.blobPathname);
  });

  it("another user's export → 404, indistinguishable from one that does not exist", async () => {
    const fx = await makeFixture();
    const row = await makeExport(fx.userId);
    signInAs(fx.otherUserId);

    const foreign = await call(row.id);
    expect(foreign.status).toBe(404);
    const foreignBody = await foreign.json();
    expect(foreignBody.code).toBe('DATA_EXPORT_NOT_FOUND');

    // The two answers must be the same answer — a distinguishable refusal would
    // confirm that a given id names somebody's personal-data archive.
    const missing = await call('cmnonexistentrow000000000');
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('DATA_EXPORT_NOT_FOUND');
  });

  it('a PREPARING export → 409, and refuses rather than redirects', async () => {
    const fx = await makeFixture();
    const row = await makeExport(fx.userId, {
      status: 'preparing',
      blobPathname: null,
      expiresAt: null,
    });
    signInAs(fx.userId);

    const res = await call(row.id);
    expect(res.status).toBe(409);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.json()).toMatchObject({
      code: 'DATA_EXPORT_NOT_READY',
      status: 'preparing',
    });
  });

  it('a FAILED export → 409, naming the status so the pane can route to privacy@', async () => {
    const fx = await makeFixture();
    const row = await makeExport(fx.userId, { status: 'failed', blobPathname: null });
    signInAs(fx.userId);

    const res = await call(row.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'DATA_EXPORT_NOT_READY',
      status: 'failed',
    });
  });

  it('a READY export PAST its expiresAt → 410, before the sweep has caught up', async () => {
    const fx = await makeFixture();
    // The row still reads `ready`: the expiry sweep runs on a schedule, so
    // there is always a window in which the row is stale and the seven-day
    // promise is not. The clock decides, not the status.
    const row = await makeExport(fx.userId, { expiresAt: new Date(Date.now() - 1000) });
    signInAs(fx.userId);

    const res = await call(row.id);
    expect(res.status).toBe(410);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.json()).toMatchObject({ code: 'DATA_EXPORT_EXPIRED' });
  });

  it('an EXPIRED export → 410, once the sweep has deleted the blob', async () => {
    const fx = await makeFixture();
    const row = await makeExport(fx.userId, {
      status: 'expired',
      blobPathname: null,
      expiresAt: new Date(Date.now() - DAY_MS),
    });
    signInAs(fx.userId);

    const res = await call(row.id);
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'DATA_EXPORT_EXPIRED' });
  });
});
