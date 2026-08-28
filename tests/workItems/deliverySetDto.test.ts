import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { presentWorkItemDetail, workItemDetailSchema } from '@/lib/api/v1/workItems/schema';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// The DELIVERY SET on the READ path (Story MOTIR-3655 · MOTIR-3697) — the DTO, the
// v1 resource, and the one property the whole card exists for: that a client's CI
// verdict is `derivePrCiState`'s and not a second one.
//
// What this pins:
//
//   1. THE CI VERDICT FOLLOWS THE CHECK ROWS. A check row is written, then changed,
//      and the DTO's `ci` moves with it — asserted through the service, over real
//      Postgres, not against a mocked derivation. This is the criterion that makes
//      `gh pr checks` unnecessary in MOTIR-3685's loop, so it is asserted at the
//      altitude the loop reads from.
//   2. THE THREE SHORTFALL KINDS ARE DERIVABLE. `merged` (via `state`), `baseRef`
//      and `defaultBranch` are all on the member, so OUTSTANDING / STRANDED /
//      UNKNOWN separate without a second round trip — and `defaultBranch` is that
//      repository's OWN, never `main` by assumption.
//   3. ZERO AND ONE DELIVERY ARE UNPERTURBED. Nearly every card in the tree is one
//      of those two, so they are the cases a regression here would hit hardest.
//      Empty is an ARRAY, never null and never absent.
//   4. RLS. The delivery read is bound; a card's set does not leak across
//      workspaces, and — the failure that looks like an answer — an unbound read
//      returns empty rather than raising.

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

async function addRepo(
  fx: WorkItemFixture,
  name: string,
  defaultBranch = 'main',
): Promise<{ id: string }> {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}` },
    create: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      repoId: `repo-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch,
      archived: false,
      provider: 'github',
    },
    select: { id: true },
  });
}

let nextPrNumber = 500;

async function addPr(
  repoId: string,
  opts: { merged?: boolean; baseRef?: string | null; title?: string } = {},
): Promise<{ id: string; number: number }> {
  const number = nextPrNumber++;
  const row = await adminDb.githubPullRequest.create({
    data: {
      repoId,
      number,
      state: opts.merged ? 'closed' : 'open',
      merged: opts.merged ?? false,
      headRef: `subtask/PROD-1-${randomToken(4)}`,
      baseRef: opts.baseRef === undefined ? 'main' : opts.baseRef,
      title: opts.title ?? null,
      provider: 'github',
    },
    select: { id: true },
  });
  return { id: row.id, number };
}

/** Record one check row. `createdAt` is explicit because `derivePrCiState` orders
 *  shas by FIRST SIGHTING — a test that let two rows share a default timestamp
 *  would be asserting against whichever the reducer happened to keep. */
async function addCheck(
  pullRequestId: string,
  opts: { sha: string; name: string; conclusion: string; createdAt: Date },
): Promise<{ id: string }> {
  return adminDb.githubCheckRun.create({
    data: {
      pullRequestId,
      commitSha: opts.sha,
      checkName: opts.name,
      checkSuiteId: '',
      conclusion: opts.conclusion,
      createdAt: opts.createdAt,
    },
    select: { id: true },
  });
}

async function link(
  fx: WorkItemFixture,
  workItemId: string,
  prId: string,
  repoId: string,
): Promise<void> {
  await withWorkspaceContext(fx.ctx, (tx) =>
    workItemDeliveryRepository.add(
      { workspaceId: fx.workspaceId, workItemId, githubPullRequestId: prId, repoId },
      tx,
    ),
  );
}

describe('the CI verdict on a delivery is `derivePrCiState`, and it MOVES', () => {
  it('follows a check row from running to failing to passing', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'watched' });
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id);
    await link(fx, card.id, pr.id, repo.id);

    // No check rows at all. Absence of CI is NOT a state — the surface renders no
    // pill, and a loop must not read it as a failure.
    let set = await workItemsService.listDeliverySet(card.id, fx.ctx);
    expect(set).toHaveLength(1);
    expect(set[0]?.pullRequest.ci).toBeNull();

    const check = await addCheck(pr.id, {
      sha: 'aaa111',
      name: 'CI complete',
      conclusion: 'pending',
      createdAt: new Date('2026-08-27T10:00:00.000Z'),
    });
    set = await workItemsService.listDeliverySet(card.id, fx.ctx);
    expect(set[0]?.pullRequest.ci).toBe('running');

    await adminDb.githubCheckRun.update({
      where: { id: check.id },
      data: { conclusion: 'failure' },
    });
    set = await workItemsService.listDeliverySet(card.id, fx.ctx);
    expect(set[0]?.pullRequest.ci).toBe('failing');

    await adminDb.githubCheckRun.update({
      where: { id: check.id },
      data: { conclusion: 'success' },
    });
    set = await workItemsService.listDeliverySet(card.id, fx.ctx);
    expect(set[0]?.pullRequest.ci).toBe('passing');
  });

  it('reads the LATEST sha, so a stale red on an old commit does not decide', async () => {
    // The property that makes the verdict usable by a loop that pushes a fix: the
    // failing run it is fixing must stop counting the moment its new commit reports.
    // A second derivation is where this rule gets lost, which is why there is one.
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'pushed a fix' });
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id);
    await link(fx, card.id, pr.id, repo.id);

    await addCheck(pr.id, {
      sha: 'old000',
      name: 'CI complete',
      conclusion: 'failure',
      createdAt: new Date('2026-08-27T10:00:00.000Z'),
    });
    await addCheck(pr.id, {
      sha: 'new111',
      name: 'CI complete',
      conclusion: 'success',
      createdAt: new Date('2026-08-27T11:00:00.000Z'),
    });

    const set = await workItemsService.listDeliverySet(card.id, fx.ctx);
    expect(set[0]?.pullRequest.ci).toBe('passing');
  });

  it('a card with two deliveries reports each pull request its OWN verdict', async () => {
    // One green and one red is the case that must NOT collapse: the card stays
    // Implemented, and a reader has to be able to say WHICH one is red.
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'spans two repos' });
    const core = await addRepo(fx, 'motir-core');
    const ai = await addRepo(fx, 'motir-ai');
    const corePr = await addPr(core.id);
    const aiPr = await addPr(ai.id);
    await link(fx, card.id, corePr.id, core.id);
    await link(fx, card.id, aiPr.id, ai.id);

    await addCheck(corePr.id, {
      sha: 'c1',
      name: 'CI complete',
      conclusion: 'success',
      createdAt: new Date('2026-08-27T10:00:00.000Z'),
    });
    await addCheck(aiPr.id, {
      sha: 'a1',
      name: 'CI complete',
      conclusion: 'failure',
      createdAt: new Date('2026-08-27T10:00:00.000Z'),
    });

    const set = await workItemsService.listDeliverySet(card.id, fx.ctx);
    expect(set).toHaveLength(2);
    const byRepo = new Map(set.map((d) => [d.pullRequest.repo, d.pullRequest.ci]));
    expect(byRepo.get('moooon/motir-core')).toBe('passing');
    expect(byRepo.get('moooon/motir-ai')).toBe('failing');
    expect(set.every((d) => d.pullRequest.ci === 'passing')).toBe(false);
  });
});

describe('the member carries what the three shortfall kinds need', () => {
  it('separates outstanding, stranded and unknown WITHOUT a second round trip', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'three kinds' });
    // ⚠️ A repository whose trunk is NOT `main`. A hard-coded comparison would call
    // the merge below stranded, which is the bug this field exists to prevent.
    const trunkRepo = await addRepo(fx, 'motir-ai', 'trunk');
    const coreRepo = await addRepo(fx, 'motir-core');

    const openPr = await addPr(coreRepo.id);
    const strandedPr = await addPr(coreRepo.id, { merged: true, baseRef: 'release/1.4' });
    const unknownPr = await addPr(coreRepo.id, { merged: true, baseRef: null });
    const landedPr = await addPr(trunkRepo.id, { merged: true, baseRef: 'trunk' });

    for (const [pr, repo] of [
      [openPr, coreRepo],
      [strandedPr, coreRepo],
      [unknownPr, coreRepo],
      [landedPr, trunkRepo],
    ] as const) {
      await link(fx, card.id, pr.id, repo.id);
    }

    const set = await workItemsService.listDeliverySet(card.id, fx.ctx);
    const by = new Map(set.map((d) => [d.pullRequest.number, d]));

    const open = by.get(openPr.number)!;
    expect(open.pullRequest.state).toBe('open');

    const stranded = by.get(strandedPr.number)!;
    expect(stranded.pullRequest.state).toBe('merged');
    expect(stranded.baseRef).toBe('release/1.4');
    expect(stranded.baseRef).not.toBe(stranded.defaultBranch);

    const unknown = by.get(unknownPr.number)!;
    expect(unknown.pullRequest.state).toBe('merged');
    expect(unknown.baseRef).toBeNull();

    const landed = by.get(landedPr.number)!;
    expect(landed.pullRequest.state).toBe('merged');
    // The trunk it had to reach is its OWN repository's, and it is not `main`.
    expect(landed.defaultBranch).toBe('trunk');
    expect(landed.baseRef).toBe('trunk');
  });
});

describe('zero and one delivery — the cases nearly every card is', () => {
  it('a card with NO deliveries reports an empty ARRAY, not null and not absent', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'ordinary' });

    const set = await workItemsService.listDeliverySet(card.id, fx.ctx);
    expect(set).toEqual([]);

    // And on the wire. `deliveries` is a declared key on every work item, so a
    // client needs no branch — the schema's own parse is the assertion.
    const detail = await workItemsService.getIssueDetail(fx.projectId, card.identifier, fx.ctx);
    const body = workItemDetailSchema.parse(presentWorkItemDetail(detail, 0, {}, set));
    expect(body.deliveries).toEqual([]);
  });

  it('a single-delivery card publishes exactly one member, flattened onto the wire', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'one branch' });
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id, { title: 'feat: the thing' });
    await link(fx, card.id, pr.id, repo.id);
    await addCheck(pr.id, {
      sha: 's1',
      name: 'CI complete',
      conclusion: 'success',
      createdAt: new Date('2026-08-27T10:00:00.000Z'),
    });

    const set = await workItemsService.listDeliverySet(card.id, fx.ctx);
    const detail = await workItemsService.getIssueDetail(fx.projectId, card.identifier, fx.ctx);
    const body = workItemDetailSchema.parse(presentWorkItemDetail(detail, 0, {}, set));

    expect(body.deliveries).toEqual([
      {
        repo: 'moooon/motir-core',
        number: pr.number,
        title: 'feat: the thing',
        url: `https://github.com/moooon/motir-core/pull/${pr.number}`,
        state: 'open',
        ci: 'passing',
        baseRef: 'main',
        defaultBranch: 'main',
      },
    ]);
  });
});

describe('the delivery set is workspace-bound', () => {
  it("does not publish another workspace's deliveries", async () => {
    const a = await makeWorkItemFixture();
    const b = await makeWorkItemFixture();
    const cardA = await createTestWorkItem(a, { kind: 'task', title: 'A' });
    const cardB = await createTestWorkItem(b, { kind: 'task', title: 'B' });
    const repoA = await addRepo(a, 'motir-core');
    const repoB = await addRepo(b, 'motir-core');
    const prA = await addPr(repoA.id);
    const prB = await addPr(repoB.id);
    await link(a, cardA.id, prA.id, repoA.id);
    await link(b, cardB.id, prB.id, repoB.id);

    // Read A's card while bound to B. The row exists; the policy hides it.
    expect(await workItemsService.listDeliverySet(cardA.id, b.ctx)).toEqual([]);
    expect(await workItemsService.listDeliverySet(cardA.id, a.ctx)).toHaveLength(1);
  });
});
