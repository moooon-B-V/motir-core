import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { historicalPullRequestBackfillService } from '@/lib/services/historicalPullRequestBackfillService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The historical-PR mirror backfill against real Postgres (MOTIR-1965) — the
// half the leaf's unit suite cannot assert: that the sweep reads the right
// repositories, writes rows the live path cannot tell apart from its own, and
// rewrites nothing on a second run. Real Postgres, no mocks below the host
// boundary, per CLAUDE.md.
//
// ⚠️ MOTIR-3674 removed the ATTRIBUTION pass (option A of that card). The sweep
// used to link each mirrored row to the work item whose key appeared in the head
// ref or the title, through the sync's own resolver; that resolver is gone at
// both call sites, so every row this sweep writes now carries a NULL link. The
// cases below assert exactly that, and the indistinguishable-from-live claim is
// unchanged — it is just that both paths now write the same null.
//
// Only two things are stubbed, both ABOVE the code under test: `fetch` (the
// GitHub REST listing) and `mintInstallationToken` (a real mint needs an App
// private key the test env has no business carrying). Everything from the
// service down — the resolver, the repository, the row lock, RLS — is real.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const INSTALLATION_ID = 'inst-hist-1';
const REPO_PROVIDER_ID = '9001';

let fetchMock: ReturnType<typeof vi.fn>;

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "github_pull_request", "github_repo", "github_installation", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A workspace + project + a connected GitHub repo, mirrored exactly as
 *  `githubInstallationService.persistInstallation` writes them. */
async function makeConnectedRepo(): Promise<{ fx: WorkItemFixture; repoId: string }> {
  const fx = await makeWorkItemFixture();
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: INSTALLATION_ID,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      repoId: REPO_PROVIDER_ID,
      owner: 'moooon-B-V',
      name: 'motir-core',
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  return { fx, repoId: repo.id };
}

/** One row as GitHub's `GET /repos/{o}/{n}/pulls` returns it. */
function ghPull(
  number: number,
  opts: { headRef?: string; title?: string | null; mergedAt?: string | null } = {},
): Record<string, unknown> {
  return {
    number,
    state: 'closed',
    title: opts.title === undefined ? `A change` : opts.title,
    merged_at: opts.mergedAt === undefined ? '2026-06-20T10:00:00Z' : opts.mergedAt,
    head: { ref: opts.headRef ?? 'subtask/no-key' },
    base: { ref: 'main' },
  };
}

/** Serve the whole listing on page 1 (a short page ends the walk). */
function serveListing(rows: Record<string, unknown>[]): void {
  fetchMock.mockImplementation(async (url: string) =>
    // `endsWith`, never `includes`: `page` is the last query parameter, and
    // `includes('page=1')` would also match page=10 / page=100 — re-serving a
    // FULL page forever, so the walk would only stop at the page bound.
    url.endsWith('page=1')
      ? new Response(JSON.stringify(rows), { status: 200 })
      : new Response('[]', { status: 200 }),
  );
}

/** The `pull_request` webhook payload for the SAME PR the listing would carry —
 *  the live ingest path, used as the reference the backfill is diffed against. */
function prWebhookPayload(
  number: number,
  opts: { headRef: string; title: string | null },
): Record<string, unknown> {
  return {
    action: 'closed',
    installation: { id: INSTALLATION_ID },
    repository: { id: REPO_PROVIDER_ID, full_name: 'moooon-B-V/motir-core' },
    pull_request: {
      number,
      state: 'closed',
      merged: true,
      title: opts.title,
      head: { ref: opts.headRef },
      base: { ref: 'main' },
    },
  };
}

const CONTENT_COLUMNS = {
  provider: true,
  number: true,
  state: true,
  merged: true,
  headRef: true,
  title: true,
  workItemId: true,
  linkedManually: true,
} as const;

function readRow(repoId: string, number: number) {
  return adminDb.githubPullRequest.findUniqueOrThrow({
    where: { repoId_number: { repoId, number } },
    select: CONTENT_COLUMNS,
  });
}

const DRY = { dryRun: true };
const APPLY = { dryRun: false };

describe('historicalPullRequestBackfillService — mirroring merged history', () => {
  it('attributes NOTHING — a branch key and a title key both mirror with a null link (MOTIR-3674)', async () => {
    const { fx, repoId } = await makeConnectedRepo();
    const byBranch = await createTestWorkItem(fx, { kind: 'task', title: 'Branch-named' });
    const byTitle = await createTestWorkItem(fx, { kind: 'task', title: 'Title-named' });

    // The first two are exactly the cases that USED to link — a resolvable key in
    // the head ref, and one in the title. Both are now text.
    serveListing([
      ghPull(1, { headRef: `subtask/${byBranch.identifier}-slug`, title: 'no key here' }),
      ghPull(2, { headRef: 'subtask/unnamed', title: `feat(x): a change (${byTitle.identifier})` }),
      ghPull(3, { headRef: 'subtask/nothing', title: 'no key anywhere' }),
    ]);

    const report = await historicalPullRequestBackfillService.backfillMergedPullRequests(APPLY);

    const repo = report.repos[0]!;
    expect(repo.repoRef).toBe('moooon-B-V/motir-core');
    expect(repo.scanned).toBe(3);
    expect(repo.unattributed).toBe(3);
    expect(repo.written).toBe(3);
    // All three mirrored, all three unlinked. The rows are the workspace's pull
    // request HISTORY — a fact worth keeping — and the explicit-link picker
    // (MOTIR-1596) is what attaches one to a card, by a human's act.
    expect((await readRow(repoId, 1)).workItemId).toBeNull();
    expect((await readRow(repoId, 2)).workItemId).toBeNull();
    expect((await readRow(repoId, 3)).workItemId).toBeNull();
  });

  it('never mirrors a closed-UNMERGED PR — hasLinkedPr does not read the merged column', async () => {
    const { fx, repoId } = await makeConnectedRepo();
    const abandoned = await createTestWorkItem(fx, { kind: 'task', title: 'Abandoned work' });

    serveListing([ghPull(4, { headRef: `subtask/${abandoned.identifier}`, mergedAt: null })]);

    const report = await historicalPullRequestBackfillService.backfillMergedPullRequests(APPLY);

    expect(report.repos[0]!.scanned).toBe(1);
    expect(report.repos[0]!.written).toBe(0);
    await expect(readRow(repoId, 4)).rejects.toThrow();
    // The whole point: with no row, the classifier still abstains on this item
    // rather than claiming a BYOK agent shipped it.
    expect(await adminDb.githubPullRequest.count()).toBe(0);
  });

  it("walks past a FULL page onto the next, accumulating both pages' counts", async () => {
    const { fx, repoId } = await makeConnectedRepo();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'On page two' });
    // A FULL page (100) is what makes the walk ask for page 2; the short second
    // page ends it. Page 1 is entirely closed-UNMERGED, which keeps this test
    // about the PAGINATION arithmetic — 100 rows of lock + resolve + upsert
    // would buy nothing the single-page write tests above have not proven, and
    // on a Postgres shared with sibling suites it costs minutes.
    const page1 = Array.from({ length: 100 }, (_, i) => ghPull(i + 1, { mergedAt: null }));
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('page=1')
        ? new Response(JSON.stringify(page1), { status: 200 })
        : new Response(JSON.stringify([ghPull(101, { headRef: `subtask/${item.identifier}` })]), {
            status: 200,
          }),
    );

    const report = await historicalPullRequestBackfillService.backfillMergedPullRequests(APPLY);

    const repo = report.repos[0]!;
    expect(repo.pages).toBe(2);
    expect(repo.scanned).toBe(101); // both pages counted
    expect(repo.truncated).toBe(false);
    // Page 2 was actually REACHED, not merely requested: its one merged PR is
    // the only row written, and page 1's hundred abandoned PRs wrote none.
    expect(repo.written).toBe(1);
    expect(repo.unattributed).toBe(1);
    expect(await adminDb.githubPullRequest.count()).toBe(1);
    expect((await readRow(repoId, 101)).workItemId).toBeNull();
  });

  it('a DRY RUN decides and reports but writes nothing', async () => {
    const { fx, repoId } = await makeConnectedRepo();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Dry' });
    serveListing([ghPull(5, { headRef: `subtask/${item.identifier}` })]);

    const report = await historicalPullRequestBackfillService.backfillMergedPullRequests(DRY);

    expect(report.dryRun).toBe(true);
    expect(report.repos[0]!.written).toBe(1);
    expect(report.repos[0]!.unattributed).toBe(1);
    await expect(readRow(repoId, 5)).rejects.toThrow();
  });

  it('a SECOND consecutive run writes zero and does not touch updated_at', async () => {
    const { fx, repoId } = await makeConnectedRepo();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Idempotent' });
    serveListing([ghPull(6, { headRef: `subtask/${item.identifier}` })]);

    await historicalPullRequestBackfillService.backfillMergedPullRequests(APPLY);
    const first = await adminDb.githubPullRequest.findUniqueOrThrow({
      where: { repoId_number: { repoId, number: 6 } },
    });

    const second = await historicalPullRequestBackfillService.backfillMergedPullRequests(APPLY);

    expect(second.repos[0]!.written).toBe(0);
    expect(second.repos[0]!.unchanged).toBe(1);
    const after = await adminDb.githubPullRequest.findUniqueOrThrow({
      where: { repoId_number: { repoId, number: 6 } },
    });
    // Not merely "the values are the same" — the row was never WRITTEN. A blind
    // re-upsert would bump this, churning the Development surface's ordering.
    expect(after.updatedAt.toISOString()).toBe(first.updatedAt.toISOString());
  });

  it('preserves ANY STORED link, manual or historical — the MOTIR-3674 grandfathering', async () => {
    const { fx, repoId } = await makeConnectedRepo();
    const branchItem = await createTestWorkItem(fx, { kind: 'task', title: 'Named by branch' });
    const manualItem = await createTestWorkItem(fx, { kind: 'task', title: 'Linked by hand' });
    await adminDb.githubPullRequest.create({
      data: {
        provider: 'github',
        repoId,
        number: 7,
        state: 'closed',
        merged: true,
        headRef: `subtask/${branchItem.identifier}`,
        workItemId: manualItem.id,
        linkedManually: true,
      },
    });

    serveListing([ghPull(7, { headRef: `subtask/${branchItem.identifier}` })]);
    const report = await historicalPullRequestBackfillService.backfillMergedPullRequests(APPLY);

    expect(report.repos[0]!.skippedLinked).toBe(1);
    expect(report.repos[0]!.written).toBe(0);
    expect((await readRow(repoId, 7)).workItemId).toBe(manualItem.id);
  });

  it('preserves a link the RETIRED PARSE wrote — `linked_manually: false` is still a link', async () => {
    // The production population this protects: 1026 rows the parse linked, all
    // carrying `linked_manually: false`. Gating the skip on that flag would have
    // the sweep overwrite every one of them with a null link.
    const { fx, repoId } = await makeConnectedRepo();
    const parseLinked = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Linked by the parse',
    });
    await adminDb.githubPullRequest.create({
      data: {
        provider: 'github',
        repoId,
        number: 8,
        state: 'closed',
        merged: true,
        headRef: `subtask/${parseLinked.identifier}`,
        workItemId: parseLinked.id,
        linkedManually: false,
      },
    });

    serveListing([ghPull(8, { headRef: `subtask/${parseLinked.identifier}` })]);
    const report = await historicalPullRequestBackfillService.backfillMergedPullRequests(APPLY);

    expect(report.repos[0]!.skippedLinked).toBe(1);
    expect(report.repos[0]!.written).toBe(0);
    expect((await readRow(repoId, 8)).workItemId).toBe(parseLinked.id);
  });

  it('scopes to one workspace / one repo, and reports a skipped non-GitHub connection', async () => {
    const { fx: keep, repoId } = await makeConnectedRepo();
    const item = await createTestWorkItem(keep, { kind: 'task', title: 'In scope' });

    // A second tenant with its own connection, plus a GitLab project.
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const otherInst = await adminDb.githubInstallation.create({
      data: {
        installationId: 'inst-other',
        workspaceId: other.workspaceId,
        accountLogin: 'other',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    await adminDb.githubRepo.create({
      data: {
        installationId: otherInst.id,
        workspaceId: other.workspaceId,
        repoId: '9002',
        owner: 'other',
        name: 'app',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    await adminDb.githubRepo.create({
      data: {
        installationId: otherInst.id,
        workspaceId: other.workspaceId,
        repoId: '9003',
        owner: 'other',
        name: 'gl-project',
        defaultBranch: 'main',
        provider: 'gitlab',
      },
    });

    serveListing([ghPull(8, { headRef: `subtask/${item.identifier}` })]);

    const all = await historicalPullRequestBackfillService.backfillMergedPullRequests(DRY);
    expect(all.repos.map((r) => r.repoRef).sort()).toEqual(['moooon-B-V/motir-core', 'other/app']);
    expect(all.skippedNonGithub).toEqual(['other/gl-project']);

    const scoped = await historicalPullRequestBackfillService.backfillMergedPullRequests({
      ...APPLY,
      workspaceId: keep.workspaceId,
    });
    expect(scoped.repos.map((r) => r.repoRef)).toEqual(['moooon-B-V/motir-core']);
    // The row is written for the in-scope repository and for that one only. Its
    // link is null since MOTIR-3674 — this case is about SCOPE, and the sweep no
    // longer attributes anything (see the first case in this file).
    expect((await readRow(repoId, 8)).workItemId).toBeNull();

    const byRepo = await historicalPullRequestBackfillService.backfillMergedPullRequests({
      ...DRY,
      repoRef: 'OTHER/APP', // case-insensitive
    });
    expect(byRepo.repos.map((r) => r.repoRef)).toEqual(['other/app']);
  });

  it('records a failing repository and keeps sweeping the others', async () => {
    const { fx } = await makeConnectedRepo();
    await createTestWorkItem(fx, { kind: 'task', title: 'Anything' });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const otherInst = await adminDb.githubInstallation.create({
      data: {
        installationId: 'inst-other',
        workspaceId: other.workspaceId,
        accountLogin: 'other',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    await adminDb.githubRepo.create({
      data: {
        installationId: otherInst.id,
        workspaceId: other.workspaceId,
        repoId: '9002',
        owner: 'other',
        name: 'app',
        defaultBranch: 'main',
        provider: 'github',
      },
    });

    // The first repo 404s (the installation lost it); the second answers.
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/motir-core/')
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify([ghPull(9)]), { status: 200 }),
    );

    const report = await historicalPullRequestBackfillService.backfillMergedPullRequests(APPLY);

    const failed = report.repos.find((r) => r.repoRef === 'moooon-B-V/motir-core')!;
    const ok = report.repos.find((r) => r.repoRef === 'other/app')!;
    expect(failed.error).toMatch(/404/);
    expect(ok.error).toBeUndefined();
    expect(ok.written).toBe(1);
  });

  it('reports a mint failure per repo rather than aborting the sweep', async () => {
    await makeConnectedRepo();
    const { mintInstallationToken } = await import('@/lib/github/appAuth');
    vi.mocked(mintInstallationToken).mockRejectedValueOnce(new Error('no private key'));

    const report = await historicalPullRequestBackfillService.backfillMergedPullRequests(APPLY);

    expect(report.repos[0]!.error).toMatch(/could not mint an installation token: no private key/);
    expect(report.repos[0]!.written).toBe(0);
  });
});

describe('a backfilled row is INDISTINGUISHABLE from a live-ingested one', () => {
  it('the sweep reads a webhook-written row as already current, and writes an identical one', async () => {
    const { fx, repoId } = await makeConnectedRepo();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Shipped by an agent' });
    const headRef = `subtask/${item.identifier}-a-change`;
    const title = `feat(x): a change (${item.identifier})`;

    // (1) INGEST PR #100 THE LIVE WAY — the real webhook entry point.
    const live = await githubWebhookService.handleEvent(
      'pull_request',
      prWebhookPayload(100, { headRef, title }),
    );
    expect(live.event).toBe('pull_request');
    const liveRow = await readRow(repoId, 100);
    // NULL since MOTIR-3674 — the live path does not infer a link either, which
    // is what makes the two paths identical rather than merely similar.
    expect(liveRow.workItemId).toBeNull();

    // (2) Now run the sweep over a listing carrying that SAME PR plus an
    //     otherwise-identical sibling #101 the webhook never saw.
    serveListing([ghPull(100, { headRef, title }), ghPull(101, { headRef, title })]);
    const report = await historicalPullRequestBackfillService.backfillMergedPullRequests(APPLY);

    // The strongest form of the claim: the sweep would write EXACTLY what the
    // webhook already wrote, so it recognises #100 as current and skips it.
    expect(report.repos[0]!.unchanged).toBe(1);
    expect(report.repos[0]!.written).toBe(1);

    // And the explicit column diff for the one it did write. Every content
    // column matches; only `number` (the row's identity) differs.
    const backfilled = await readRow(repoId, 101);
    expect({ ...backfilled, number: 100 }).toEqual(liveRow);
  });
});

describe('composed with the provenance backfill', () => {
  // ⚠️ MOTIR-3674 CHANGED WHAT THIS COMPOSITION CAN DO, and the change is a real
  // cost of retiring the parse rather than a test detail.
  //
  // `classifyImplementationSource` stamps `byok` on `row.hasLinkedPr`, and
  // `hasLinkedPr` is `githubPullRequests.length > 0` — the relation on
  // `github_pull_request.work_item_id`. The historical sweep used to SET that
  // column from the head ref, which is how MOTIR-1965 recovered provenance for
  // ~1100 items whose pull requests predated the App installation. With the
  // attribution pass gone, a mirrored row carries no link, so it is not evidence
  // for any card and the classifier keeps abstaining.
  //
  // That is the correct reading of the data Motir actually has: an inferred link
  // producing a provenance STAMP is a guess wearing a fact's clothes. It is also
  // not a regression against the live tenant — that sweep has already run, and
  // its 1026 links are grandfathered (see the case above). What is lost is the
  // recovery for a repository connected FROM NOW ON, and the recovery path for
  // those is an explicit link, asserted below.
  it('no longer recovers byok from a text-named pull request — the link is what counts', async () => {
    const { fx } = await makeConnectedRepo();
    const recovered = await createTestWorkItem(fx, { kind: 'task', title: 'Pre-App merge' });
    const alreadyStamped = await createTestWorkItem(fx, { kind: 'task', title: 'Already stamped' });
    await adminDb.workItem.updateMany({
      where: { id: { in: [recovered.id, alreadyStamped.id] } },
      data: { status: 'done', executor: 'coding_agent', type: 'code' },
    });
    await adminDb.workItem.update({
      where: { id: alreadyStamped.id },
      data: { implementationSource: 'manual' },
    });

    // BEFORE: no PR evidence anywhere, so the classifier abstains on both.
    const before = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId, {
      dryRun: true,
    });
    expect(before.implementation.byok.count).toBe(0);

    serveListing([
      ghPull(200, { headRef: `subtask/${recovered.identifier}` }),
      ghPull(201, { headRef: `subtask/${alreadyStamped.identifier}` }),
    ]);
    await historicalPullRequestBackfillService.backfillMergedPullRequests(APPLY);

    // AFTER the sweep: the ROWS exist, but they name no work item, so there is
    // still no evidence for `recovered` and the classifier still abstains.
    await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId, {
      dryRun: false,
    });
    const afterSweep = await adminDb.workItem.findMany({
      where: { id: { in: [recovered.id, alreadyStamped.id] } },
      select: { id: true, implementationSource: true },
    });
    expect(afterSweep.find((r) => r.id === recovered.id)!.implementationSource).toBeNull();
    // The null guard is unaffected: an item that already carried a source is
    // untouched either way.
    expect(afterSweep.find((r) => r.id === alreadyStamped.id)!.implementationSource).toBe('manual');

    // Now LINK one of the mirrored pull requests, which is the recovery path
    // that survives — a human on the item page, or `link_pull_request`. The
    // MOTIR-1758 decision table is untouched: the data changed, not the reading.
    const mirrored = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 200 } });
    await githubPullRequestService.linkPullRequest(recovered.id, mirrored.id, {
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });
    await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId, {
      dryRun: false,
    });

    const rows = await adminDb.workItem.findMany({
      where: { id: { in: [recovered.id, alreadyStamped.id] } },
      select: {
        id: true,
        implementationSource: true,
        implementationHarness: true,
        implementationModel: true,
      },
    });
    const recoveredRow = rows.find((r) => r.id === recovered.id)!;
    const stampedRow = rows.find((r) => r.id === alreadyStamped.id)!;

    expect(recoveredRow.implementationSource).toBe('byok');
    // The out-of-scope columns stay NULL: a merged PR proves a BYOK agent
    // shipped it, and reveals nothing about the harness or the model.
    expect(recoveredRow.implementationHarness).toBeNull();
    expect(recoveredRow.implementationModel).toBeNull();
    expect(stampedRow.implementationSource).toBe('manual');
  });
});
