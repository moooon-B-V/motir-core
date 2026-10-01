import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { INDEX_REPO_REF, seedIndexWorkspace } from '../helpers/indexFleet';

// A REPOSITORY REMEMBERS THAT ITS LAST INDEX WAS REFUSED FOR SIZE (MOTIR-7129 ·
// Story MOTIR-7092). The pair is `markIndexPaused` / `clearIndexPause`'s shape,
// written from the job runtime under `withSystemContext`, but the columns are the
// opposite kind: these are shown to the customer, so they are NUMBERS a row renders,
// never a sentence.

const [REPO_OWNER, REPO_NAME] = INDEX_REPO_REF.split('/') as [string, string];

function repoRow() {
  return adminDb.githubRepo.findFirstOrThrow({
    where: { owner: REPO_OWNER, name: REPO_NAME },
    select: {
      indexRefusedSizeBytes: true,
      indexRefusedCapBytes: true,
      indexRefusedAt: true,
      indexedHeadSha: true,
      indexPausedReason: true,
    },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('githubRepoRepository — the size-refusal pair', () => {
  it('a connected repository starts with no refusal', async () => {
    await seedIndexWorkspace('refuse-fresh', 1);
    expect(await repoRow()).toMatchObject({
      indexRefusedSizeBytes: null,
      indexRefusedCapBytes: null,
      indexRefusedAt: null,
    });
  });

  it('mark then read: both numbers and a timestamp, nothing else touched', async () => {
    await seedIndexWorkspace('refuse-mark', 1);
    const before = await repoRow();

    const count = await withSystemContext((tx) =>
      githubRepoRepository.markIndexRefusedForSize(
        INDEX_REPO_REF,
        { sizeBytes: 1_500_000_000, capBytes: 1_073_741_824 },
        tx,
      ),
    );

    expect(count).toBe(1);
    const after = await repoRow();
    expect(after.indexRefusedSizeBytes).toBe(BigInt(1_500_000_000));
    expect(after.indexRefusedCapBytes).toBe(BigInt(1_073_741_824));
    expect(after.indexRefusedAt).toBeInstanceOf(Date);
    expect(after.indexedHeadSha).toBe(before.indexedHeadSha);
    expect(after.indexPausedReason).toBe(before.indexPausedReason);
  });

  it('keeps a size past int4 exactly', async () => {
    await seedIndexWorkspace('refuse-big', 1);
    await withSystemContext((tx) =>
      githubRepoRepository.markIndexRefusedForSize(
        INDEX_REPO_REF,
        { sizeBytes: 4 * 1024 ** 3, capBytes: 1024 ** 3 },
        tx,
      ),
    );
    expect((await repoRow()).indexRefusedSizeBytes).toBe(BigInt(4 * 1024 ** 3));
  });

  it('clear then read: all three null, and the count says one row changed', async () => {
    await seedIndexWorkspace('refuse-clear', 1);
    await withSystemContext((tx) =>
      githubRepoRepository.markIndexRefusedForSize(
        INDEX_REPO_REF,
        { sizeBytes: 1_500_000_000, capBytes: 1_073_741_824 },
        tx,
      ),
    );

    const count = await withSystemContext((tx) =>
      githubRepoRepository.clearIndexRefusal(INDEX_REPO_REF, tx),
    );

    expect(count).toBe(1);
    expect(await repoRow()).toMatchObject({
      indexRefusedSizeBytes: null,
      indexRefusedCapBytes: null,
      indexRefusedAt: null,
    });
  });

  it('clearing a repository with no refusal returns 0', async () => {
    await seedIndexWorkspace('refuse-none', 1);
    const count = await withSystemContext((tx) =>
      githubRepoRepository.clearIndexRefusal(INDEX_REPO_REF, tx),
    );
    expect(count).toBe(0);
  });

  it('a malformed repoRef matches no row rather than every row', async () => {
    await seedIndexWorkspace('refuse-malformed', 1);
    const counts = await withSystemContext(async (tx) => [
      await githubRepoRepository.markIndexRefusedForSize(
        'no-slash',
        { sizeBytes: 2, capBytes: 1 },
        tx,
      ),
      await githubRepoRepository.clearIndexRefusal('no-slash', tx),
    ]);
    expect(counts).toEqual([0, 0]);
    expect((await repoRow()).indexRefusedAt).toBeNull();
  });
});
