import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ONBOARDING_SUBSTRATE_ITEM_CAP,
  readOnboardingSubstrate,
} from '@/lib/services/onboardingSubstrateService';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';

// THE ONBOARDING SUBSTRATE READ (Story MOTIR-4753 · MOTIR-4756), against a REAL
// Postgres (the motir-core convention) — every signal it composes is a genuine
// committed one:
//
//   items      → real work-item rows, read through the repository
//   connected  → a repo in the GitHub grant mirror (`resolveCodeContext`)
//   indexed    → a SUCCEEDED `system.code-graph-index` job_run
//
// ⚠️ THE TRUNCATION FLAG IS THE POINT OF THE SUITE, NOT A DETAIL OF IT. The
// consumer downstream is asked whether the substrate ANSWERS a question, and a
// capped count that presents as exact is the one input that turns a careful
// judgement into a confident wrong one. So the BOUNDARY is asserted in both
// directions — at the cap and one over it — and the flag is asserted to change
// the reported count as well as its own value.

/** Seed a connected GitHub repo so `resolveCodeContext` resolves it. */
async function seedConnectedRepo(fx: WorkItemFixture, owner = 'acme', name = 'widgets') {
  const rand = randomToken(6);
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${rand}`,
      workspaceId: fx.workspaceId,
      accountLogin: owner,
      accountType: 'Organization',
    },
  });
  await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `repo-${rand}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  return `${owner}/${name}`;
}

/** Seed a SUCCEEDED code-graph-index job_run for a repo. */
async function seedSucceededIndexJob(fx: WorkItemFixture, repoRef: string) {
  await adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${randomToken()}`,
      lane: 'engine',
      attempt: 0,
      status: 'succeeded',
      finishedAt: new Date(),
      output: { indexed: true, repoRef, projectsIndexed: 1 },
    },
  });
}

async function seedItems(fx: WorkItemFixture, n: number) {
  for (let i = 0; i < n; i += 1) {
    await createTestWorkItem(fx, { kind: 'story', title: `Imported story ${i + 1}` });
  }
}

const read = (fx: WorkItemFixture, options?: { itemCap?: number }) =>
  readOnboardingSubstrate(
    fx.projectId,
    { userId: fx.ownerId, workspaceId: fx.workspaceId },
    options ?? {},
  );

describe('readOnboardingSubstrate', () => {
  beforeEach(async () => {
    await truncateJobRuns();
    await truncateAuthTables();
  });

  it('THE FLOOR — an empty project with nothing connected reports all four negatives', async () => {
    const fx = await makeWorkItemFixture();
    expect(await read(fx)).toEqual({
      itemCount: 0,
      itemCountTruncated: false,
      // The NAMES, not just the booleans (MOTIR-4768) — empty here, and empty is
      // the honest floor answer rather than an absent key.
      repositories: [],
      repositoryConnected: false,
      repositoryIndexed: false,
    });
  });

  it('counts the committed work items', async () => {
    const fx = await makeWorkItemFixture();
    await seedItems(fx, 3);
    const substrate = await read(fx);
    expect(substrate.itemCount).toBe(3);
    expect(substrate.itemCountTruncated).toBe(false);
  });

  describe('the truncation flag, at the boundary in BOTH directions', () => {
    it('is FALSE at exactly the cap, and the count is exact', async () => {
      const fx = await makeWorkItemFixture();
      await seedItems(fx, 3);
      const substrate = await read(fx, { itemCap: 3 });
      expect(substrate.itemCountTruncated).toBe(false);
      expect(substrate.itemCount).toBe(3);
    });

    it('is TRUE one over the cap, and the count is the CAP — a floor, not a total', async () => {
      const fx = await makeWorkItemFixture();
      await seedItems(fx, 4);
      const substrate = await read(fx, { itemCap: 3 });
      expect(substrate.itemCountTruncated).toBe(true);
      // ⚠️ NOT 4. Reporting the over-read's length would leak the `+1` probe and
      // tell a consumer a number the read is not entitled to claim.
      expect(substrate.itemCount).toBe(3);
    });

    it('is FALSE below the cap', async () => {
      const fx = await makeWorkItemFixture();
      await seedItems(fx, 2);
      expect((await read(fx, { itemCap: 3 })).itemCountTruncated).toBe(false);
    });
  });

  it('the default cap is the one the discovery grounding already reads at', () => {
    // ⚠️ ASSERTED AGAINST THE OTHER SITE'S SOURCE, not against a number typed
    // twice. The whole reason this constant is named is that the two must not
    // drift — a substrate read capped somewhere the grounding is not would
    // report a truncation that never happens, or miss one that does.
    expect(ONBOARDING_SUBSTRATE_ITEM_CAP).toBe(200);
    const service = readFileSync(
      join(process.cwd(), 'lib/services/migrateOnboardingService.ts'),
      'utf8',
    );
    expect(service).toContain(`{ take: ${ONBOARDING_SUBSTRATE_ITEM_CAP} }`);
  });

  describe('the repositories are NAMED, and the booleans are derived from them (MOTIR-4768)', () => {
    // The reading state has to say *"reading acme/widgets and 214 work items"*,
    // and a boolean cannot be named. The call already resolved these refs and
    // threw them away; it now returns them. No new query, and no new question.
    it('returns the ref and the per-repo index state', async () => {
      const fx = await makeWorkItemFixture();
      const repoRef = await seedConnectedRepo(fx, 'acme', 'widgets');
      await seedSucceededIndexJob(fx, repoRef);
      expect((await read(fx)).repositories).toEqual([{ ref: 'acme/widgets', indexed: true }]);
    });

    it('a CONNECTED but unindexed repository is named, and says so', async () => {
      const fx = await makeWorkItemFixture();
      await seedConnectedRepo(fx, 'acme', 'widgets');
      const substrate = await read(fx);
      expect(substrate.repositories).toEqual([{ ref: 'acme/widgets', indexed: false }]);
      // The row is DRAWN either way — what changes is its sub-line. A repository
      // whose graph is still building is a thing Motir is reading, not a thing
      // it is missing.
      expect(substrate.repositoryConnected).toBe(true);
      expect(substrate.repositoryIndexed).toBe(false);
    });

    it('the two booleans are DERIVED, so they cannot disagree with the list', async () => {
      // Asserted as a property over both shapes rather than restated: a caller
      // reading the booleans and a caller reading the names are answering the
      // same question, and this is what stops them drifting.
      const fx = await makeWorkItemFixture();
      for (const seed of [
        async () => {},
        async () => void (await seedConnectedRepo(fx, 'acme', 'widgets')),
      ]) {
        await seed();
        const s = await read(fx);
        expect(s.repositoryConnected).toBe(s.repositories.length > 0);
        expect(s.repositoryIndexed).toBe(s.repositories.some((r) => r.indexed));
      }
    });
  });

  describe('the repository half', () => {
    it('reports CONNECTED with no index — the two are not interchangeable', async () => {
      const fx = await makeWorkItemFixture();
      await seedConnectedRepo(fx);
      const substrate = await read(fx);
      expect(substrate.repositoryConnected).toBe(true);
      expect(substrate.repositoryIndexed).toBe(false);
    });

    it('reports INDEXED once a succeeded code-graph run exists for that repo', async () => {
      const fx = await makeWorkItemFixture();
      const repoRef = await seedConnectedRepo(fx);
      await seedSucceededIndexJob(fx, repoRef);
      const substrate = await read(fx);
      expect(substrate.repositoryConnected).toBe(true);
      expect(substrate.repositoryIndexed).toBe(true);
    });

    it('an index of a DIFFERENT repo does not count', async () => {
      // The ledger is workspace-scoped, so a stale index of some other repository
      // is visible to the read and must not be mistaken for this one's.
      const fx = await makeWorkItemFixture();
      await seedConnectedRepo(fx, 'acme', 'widgets');
      await seedSucceededIndexJob(fx, 'acme/something-else');
      expect((await read(fx)).repositoryIndexed).toBe(false);
    });

    it('the ROW THIS STORY IS FOR — a repository connected and no work items yet', async () => {
      const fx = await makeWorkItemFixture();
      const repoRef = await seedConnectedRepo(fx);
      await seedSucceededIndexJob(fx, repoRef);
      expect(await read(fx)).toEqual({
        itemCount: 0,
        itemCountTruncated: false,
        repositories: [{ ref: repoRef, indexed: true }],
        repositoryConnected: true,
        repositoryIndexed: true,
      });
    });
  });
});
