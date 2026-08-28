import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dataExportService } from '@/lib/services/dataExportService';
import { withSystemContext } from '@/lib/workspaces/context';
import { dataExportRequestRepository } from '@/lib/repositories/dataExportRequestRepository';
import { DATA_EXPORT_RETENTION_DAYS } from '@/lib/users/dataSubjectRequests';
import { createTestUser } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `dataExportService.getLatestExportForUser` (Story 8.4 · Subtask MOTIR-1136) —
// the READ the `Data › Data & privacy` pane's export card renders, against the
// real Postgres.
//
// Three properties, and none of them is assertable against a mocked repository:
//
//   1. IDLE IS THE ABSENCE OF A ROW. `null` is a legitimate answer, not an
//      error — the pane's first panel is what a reader who has never asked for
//      an export sees.
//   2. IT IS THE READER'S OWN ROW. The read runs under the reader's bound
//      context, so `data_export_request`'s `app.user_id` policy is what decides
//      the row is theirs. Another user's export must be invisible, and a mocked
//      repository would assert only that we passed the right `where`.
//   3. LATEST WINS, and the projection drops what the reader must not receive:
//      the private object's storage key and the operator-facing failure reason.
//
// The requests are written on the SYSTEM context — the same arm the build job
// uses — so the fixture never depends on the read path it is testing.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** One request row, written the way the build job writes one. */
async function seedRequest(input: {
  userId: string;
  status: 'preparing' | 'ready' | 'failed' | 'expired';
  requestedAt: Date;
  builtAt?: Date;
  blobPathname?: string;
  failureReason?: string;
}): Promise<string> {
  const created = await withSystemContext((tx) =>
    dataExportRequestRepository.create(
      { userId: input.userId, requestedAt: input.requestedAt },
      tx,
    ),
  );
  await withSystemContext((tx) =>
    dataExportRequestRepository.update(
      created.id,
      {
        status: input.status,
        builtAt: input.builtAt ?? null,
        expiresAt:
          input.builtAt === undefined
            ? null
            : new Date(input.builtAt.getTime() + DATA_EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
        blobPathname: input.blobPathname ?? null,
        failureReason: input.failureReason ?? null,
      },
      tx,
    ),
  );
  return created.id;
}

describe('getLatestExportForUser — the pane read', () => {
  it('answers NULL for a reader who has never asked — idle is an absence, not a status', async () => {
    const user = await createTestUser();
    await expect(dataExportService.getLatestExportForUser(user.id)).resolves.toBeNull();
  });

  it('returns the reader’s most recent request, not an older one', async () => {
    const user = await createTestUser();
    await seedRequest({
      userId: user.id,
      status: 'expired',
      requestedAt: new Date('2026-08-01T10:00:00.000Z'),
      builtAt: new Date('2026-08-01T10:05:00.000Z'),
    });
    const newest = await seedRequest({
      userId: user.id,
      status: 'ready',
      requestedAt: new Date('2026-08-20T10:00:00.000Z'),
      builtAt: new Date('2026-08-20T10:07:00.000Z'),
      blobPathname: `exports/${user.id}/newest/motir-export.zip`,
    });

    const dto = await dataExportService.getLatestExportForUser(user.id);
    expect(dto?.id).toBe(newest);
    expect(dto?.status).toBe('ready');
  });

  it('is the READER’S row — another user’s export is invisible', async () => {
    const [reader, stranger] = await Promise.all([createTestUser(), createTestUser()]);
    await seedRequest({
      userId: stranger.id,
      status: 'ready',
      requestedAt: new Date('2026-08-20T10:00:00.000Z'),
      builtAt: new Date('2026-08-20T10:07:00.000Z'),
      blobPathname: `exports/${stranger.id}/theirs/motir-export.zip`,
    });

    // The row exists — this is a SCOPE assertion, not an empty-table one.
    expect(await adminDb.dataExportRequest.count()).toBe(1);
    await expect(dataExportService.getLatestExportForUser(reader.id)).resolves.toBeNull();
  });

  it.each(['preparing', 'ready', 'failed', 'expired'] as const)(
    'carries %s across the boundary as the pane renders it',
    async (status) => {
      const user = await createTestUser();
      const requestedAt = new Date('2026-08-20T09:00:00.000Z');
      const builtAt =
        status === 'ready' || status === 'expired'
          ? new Date('2026-08-20T09:12:00.000Z')
          : undefined;
      await seedRequest({ userId: user.id, status, requestedAt, builtAt });

      const dto = await dataExportService.getLatestExportForUser(user.id);
      expect(dto?.status).toBe(status);
      expect(dto?.requestedAt).toBe(requestedAt.toISOString());
      expect(dto?.builtAt).toBe(builtAt === undefined ? null : builtAt.toISOString());
    },
  );

  it('⚠️ drops the blob pathname and the operator-facing failure reason', async () => {
    const user = await createTestUser();
    await seedRequest({
      userId: user.id,
      status: 'failed',
      requestedAt: new Date('2026-08-20T09:00:00.000Z'),
      blobPathname: `exports/${user.id}/secret/motir-export.zip`,
      failureReason: 'S3 PutObject denied for bucket motir-private',
    });

    const dto = await dataExportService.getLatestExportForUser(user.id);
    // The pathname is the one string the download route exists to keep
    // server-side, and `failureReason` is written "in operator terms… for the
    // person answering that mail" — neither belongs in a rendered payload.
    const serialised = JSON.stringify(dto);
    expect(serialised).not.toContain('secret');
    expect(serialised).not.toContain('PutObject');
    expect(Object.keys(dto!).sort()).toEqual([
      'builtAt',
      'expiresAt',
      'id',
      'requestedAt',
      'status',
    ]);
  });

  it('carries the persisted expiry, measured from the BUILD', async () => {
    const user = await createTestUser();
    const builtAt = new Date('2026-08-20T09:12:00.000Z');
    await seedRequest({
      userId: user.id,
      status: 'ready',
      requestedAt: new Date('2026-08-20T09:00:00.000Z'),
      builtAt,
      blobPathname: `exports/${user.id}/ready/motir-export.zip`,
    });

    const dto = await dataExportService.getLatestExportForUser(user.id);
    // A stored deadline does not move: the pane shows the date the row carries,
    // never `now + DATA_EXPORT_RETENTION_DAYS` recomputed at render time.
    expect(dto?.expiresAt).toBe(
      new Date(builtAt.getTime() + DATA_EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    );
  });
});
