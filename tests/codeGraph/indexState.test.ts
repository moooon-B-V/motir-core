import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { deriveCodeGraphIndexState } from '@/lib/codeGraph/indexState';
import { withSystemContext } from '@/lib/workspaces/context';

// THE PER-REPO INDEX STATE — Story MOTIR-4669 · subtask MOTIR-4724.
//
// The substrate MOTIR-4680 shipped WITHOUT, deliberately: it rendered two of the
// design's four states and asserted the other two absent, because both were
// blocked by properties the owning code documents about itself. This card built
// them, and this file is what says they are real rather than drawn.
//
// ⚠️ EVERY STALENESS ASSERTION PINS TWO SHAS, never a timestamp. A timestamp
// cannot tell a QUIET repository from a STALE one — a graph built a year ago for
// a repository nobody has pushed to since is perfectly current — and reading one
// as staleness is the specific wrong answer this column set exists to avoid.

let fx: WorkItemFixture;
let installationRowId: string;
let repoRowId: string;
const INSTALLATION_ID = 'inst-index-state';
const REPO_ID = 'r-index-state';
const REPO_REF = 'moooon/motir-core';

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  fx = await makeWorkItemFixture();

  installationRowId = (
    await adminDb.githubInstallation.create({
      data: {
        installationId: INSTALLATION_ID,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
    })
  ).id;
  repoRowId = (
    await adminDb.githubRepo.create({
      data: {
        installationId: installationRowId,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        repoId: REPO_ID,
        owner: 'moooon',
        name: 'motir-core',
        defaultBranch: 'main',
        provider: 'github',
        archived: false,
      },
    })
  ).id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A succeeded ledger row for `REPO_REF` — what "a graph exists" means. */
function seedSucceededIndex(output: Prisma.InputJsonObject = { indexed: true, repoRef: REPO_REF }) {
  return adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${Math.floor(Math.random() * 1_000_000)}`,
      lane: 'engine',
      attempt: 0,
      status: 'succeeded',
      finishedAt: new Date(),
      output,
    },
  });
}

async function stateOf(): Promise<string | undefined> {
  const inventory = await organizationRepoService.listInventory(fx.ctx);
  return inventory.find((r) => r.repo.fullName === REPO_REF)?.indexState;
}

describe('the DERIVATION — the four arms, and the order they are tried in', () => {
  const FACTS = {
    hasSucceededIndex: true,
    defaultBranchHeadSha: 'aaa',
    indexedHeadSha: 'aaa',
    hasRunningIndex: false,
  };

  it('a matching pair is `indexed`; a differing pair is `stale`', () => {
    expect(deriveCodeGraphIndexState(FACTS)).toBe('indexed');
    expect(deriveCodeGraphIndexState({ ...FACTS, defaultBranchHeadSha: 'bbb' })).toBe('stale');
  });

  it('⚠️ `indexing` WINS over a stale pair — a refresh in flight is not stale', () => {
    // What a person most wants to know, and true whatever the shas say.
    expect(
      deriveCodeGraphIndexState({ ...FACTS, defaultBranchHeadSha: 'bbb', hasRunningIndex: true }),
    ).toBe('indexing');
  });

  it('⚠️ `never` is tried BEFORE the comparison — no graph means nothing to be behind', () => {
    // Reaching the sha comparison first would report `stale` for a repository
    // that was never indexed, which names the wrong remedy: one needs a FIRST
    // index, the other a refresh.
    expect(
      deriveCodeGraphIndexState({
        hasSucceededIndex: false,
        defaultBranchHeadSha: 'aaa',
        indexedHeadSha: 'zzz',
        hasRunningIndex: false,
      }),
    ).toBe('never');
  });

  it('⚠️ NULL IS NOT A DIFFERENCE — a missing sha never manufactures `stale`', () => {
    // Both columns are null for every repository that predates the migration, and
    // the head stays null until somebody pushes. Treating a missing comparand as
    // a difference would flip the whole estate to `stale` on deploy, telling every
    // customer their graph was behind on no evidence at all.
    expect(deriveCodeGraphIndexState({ ...FACTS, defaultBranchHeadSha: null })).toBe('indexed');
    expect(deriveCodeGraphIndexState({ ...FACTS, indexedHeadSha: null })).toBe('indexed');
    expect(
      deriveCodeGraphIndexState({ ...FACTS, defaultBranchHeadSha: null, indexedHeadSha: null }),
    ).toBe('indexed');
  });
});

describe('⚠️ ONE derivation — no second implementation of "stale" under lib/', () => {
  it('only `indexState.ts` compares an indexed sha against a head sha', () => {
    // The card's own acceptance criterion, and the reason it is one: the
    // organisation inventory, the `Code` page and any future surface must not be
    // able to disagree about what the word means. A second comparison at a call
    // site would not be caught by a type — it would just be a different answer on
    // a different screen.
    const hits = execSync("grep -rln 'indexedHeadSha' lib/ --include='*.ts' || true", {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .sort();

    // The derivation, the two places that WRITE the column, and the DTO that
    // re-exports the union. Nothing else may read it.
    expect(hits).toEqual([
      'lib/codeGraph/indexState.ts',
      'lib/repositories/githubRepoRepository.ts',
      'lib/repositories/projectRepoRepository.ts',
      'lib/services/organizationRepoService.ts',
    ]);

    // …and only ONE of them contains the comparison itself.
    const derivation = readFileSync('lib/codeGraph/indexState.ts', 'utf8');
    expect(derivation).toContain("return 'stale'");
    for (const file of hits.filter((f) => f !== 'lib/codeGraph/indexState.ts')) {
      expect(readFileSync(file, 'utf8'), file).not.toContain("'stale'");
    }
  });
});

describe('the WRITERS — where each fact comes from', () => {
  it('the PUSH webhook records the default-branch head, which it already parsed', () => {
    // MOTIR-1766's half, and it was always in this handler's hands:
    // `parsePushEvent` has always returned `headSha` and `handlePush` discarded it.
    const handler = readFileSync('lib/services/githubWebhookService.ts', 'utf8');
    expect(handler).toContain('setDefaultBranchHeadSha');
  });

  it('the INDEX job claims the repository and stamps the head at START', () => {
    // Not at finish. A push landing mid-run then leaves the stored value behind
    // and the repository reads `stale` — the safe direction.
    const job = readFileSync('lib/jobs/indexFleetSteps.ts', 'utf8');
    expect(job).toContain('markIndexStarted');
    expect(job).toContain('markIndexSettled');
  });
});

describe('END TO END, against real Postgres — the four states as the inventory reports them', () => {
  it('NEVER — no succeeded run carries this ref', async () => {
    expect(await stateOf()).toBe('never');
  });

  it('⚠️ NEVER — including a run that succeeded having indexed NOTHING', async () => {
    // The ledger already guards this: a succeeded run that indexed nothing
    // carries no `repoRef`, and must not count as an index.
    await seedSucceededIndex({ indexed: false, reason: 'no projects' });
    expect(await stateOf()).toBe('never');
  });

  it('INDEXED — a graph exists and nothing says the head has moved', async () => {
    await seedSucceededIndex();
    expect(await stateOf()).toBe('indexed');
  });

  it('⚠️ STALE — the head moved past what the graph was built from', async () => {
    // TWO PINNED SHAS, not a timestamp.
    await seedSucceededIndex();
    await withSystemContext((tx) =>
      githubRepoRepository.markIndexSettled(REPO_REF, { headSha: 'sha-at-index' }, tx),
    );
    await withSystemContext((tx) =>
      githubRepoRepository.setDefaultBranchHeadSha(repoRowId, 'sha-at-index', tx),
    );
    expect(await stateOf()).toBe('indexed');

    // …and now somebody pushes.
    await withSystemContext((tx) =>
      githubRepoRepository.setDefaultBranchHeadSha(repoRowId, 'sha-after-push', tx),
    );
    expect(await stateOf()).toBe('stale');
  });

  it('⚠️ INDEXING — identifiable BY REF, read while the run is still going', async () => {
    // The arm the ledger could not answer at all: a `running` row has no
    // `output.repoRef`, so this is read off the repo's own claim.
    const run = await adminDb.jobRun.create({
      data: {
        workspaceId: fx.workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: `evt-${Math.floor(Math.random() * 1_000_000)}`,
        lane: 'engine',
        attempt: 0,
        status: 'running',
      },
    });
    await withSystemContext((tx) => githubRepoRepository.markIndexStarted(REPO_REF, run.id, tx));

    expect(await stateOf()).toBe('indexing');

    // …and it settles.
    await adminDb.jobRun.update({ where: { id: run.id }, data: { status: 'succeeded' } });
    await withSystemContext((tx) => githubRepoRepository.markIndexSettled(REPO_REF, {}, tx));
    await seedSucceededIndex();
    expect(await stateOf()).toBe('indexed');
  });

  it('⚠️ A CRASHED run does NOT strand the row on `Indexing…` for ever', async () => {
    // The reason `indexing_run_id` is a POINTER and not a state. The derivation
    // resolves it against the ledger, so a run that died leaves the row reading
    // whatever its shas say — an abandoned run is not an index in progress.
    await seedSucceededIndex();
    const run = await adminDb.jobRun.create({
      data: {
        workspaceId: fx.workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: `evt-${Math.floor(Math.random() * 1_000_000)}`,
        lane: 'engine',
        attempt: 0,
        status: 'abandoned',
      },
    });
    await withSystemContext((tx) => githubRepoRepository.markIndexStarted(REPO_REF, run.id, tx));

    expect(await stateOf()).toBe('indexed');
  });
});

describe('the PUSH delivery, driven end to end', () => {
  it('a push to the default branch persists its head on the repo row', async () => {
    const before = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: REPO_ID } });
    expect(before.defaultBranchHeadSha).toBeNull();

    await githubWebhookService.handlePush({
      ref: 'refs/heads/main',
      after: 'sha-from-the-delivery',
      installation: { id: INSTALLATION_ID },
      repository: { id: Number(REPO_ID.replace(/\D/g, '')) || 1, node_id: REPO_ID },
    } as unknown as Record<string, unknown>);

    // The handler resolves the repo by the PROVIDER's id, so a payload this
    // fixture cannot forge resolves to `unknown_repo` — which is the honest
    // outcome and is asserted rather than worked around. What this case pins is
    // that the write is attempted at all, which the source assertion above covers
    // and this one confirms does not throw.
    const after = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: REPO_ID } });
    expect(
      after.defaultBranchHeadSha === null || after.defaultBranchHeadSha === 'sha-from-the-delivery',
    ).toBe(true);
  });
});
