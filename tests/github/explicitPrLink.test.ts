import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { GithubNotConnectedError, GithubPullRequestNotFoundError } from '@/lib/github/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { deliveredItemIds, linkPrByIdentifier } from '../helpers/prLink';

// Story 7.10 · MOTIR-1596 — the EXPLICIT item→PR link (the manual override of
// the MOTIR-892 auto-resolver). Covers the service branches (happy link, takeover
// move, cross-workspace, unknown PR, disconnected workspace, candidate search
// annotation/exclusion) AND the correctness invariant the flag exists for: a
// manual link is STICKY against the webhook resolver and still drives the status
// sync. Real Postgres — the writes go through the actual webhook + service paths.

const PASSWORD = 'hunter2hunter2';

async function makeScenario(opts: {
  email: string;
  installationId: string;
  repoProviderId: string;
  withInstallation?: boolean;
}) {
  const user = await usersService.createUser({
    email: opts.email,
    password: PASSWORD,
    name: 'Own',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  if (opts.withInstallation !== false) {
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: opts.installationId,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: opts.repoProviderId,
          owner: 'moooon',
          name: 'acme',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
  }
  return { user, workspace, project, ctx };
}

function prEvent(opts: {
  installationId: string;
  repoProviderId: string;
  number: number;
  headBranch: string;
  title: string;
  state?: string;
  merged?: boolean;
  action?: string;
}) {
  return {
    action: opts.action ?? 'opened',
    installation: { id: opts.installationId, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(opts.repoProviderId) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: opts.title,
      head: { ref: opts.headBranch },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
}

/** Ingest a PR via the real webhook and return its internal row id. A branch that
 *  does NOT name any item key leaves it UNLINKED (the manual-link starting point). */
async function ingestPr(opts: {
  installationId: string;
  repoProviderId: string;
  number: number;
  headBranch: string;
  title: string;
}): Promise<string> {
  await githubWebhookService.handleEvent('pull_request', prEvent(opts));
  const row = await adminDb.githubPullRequest.findFirst({ where: { number: opts.number } });
  return row!.id;
}

const INST_A = 'inst-explicit-a';
const REPO_A = '9101';
const INST_B = 'inst-explicit-b';
const REPO_B = '9202';

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('githubPullRequestService.linkPullRequest — the explicit override (MOTIR-1596)', () => {
  it('links an unlinked PR to the item (writes ONE delivery row), returns the DTO', async () => {
    const s = await makeScenario({
      email: 'link-happy@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Rate-limit the API' },
      s.ctx,
    );
    // A PR whose branch never names the item's key — the resolver skipped it.
    const prId = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 12,
      headBranch: 'feature/unrelated-branch',
      title: 'Add per-route throttling',
    });
    expect(await deliveredItemIds(prId)).toEqual([]);

    const dto = await githubPullRequestService.linkPullRequest(item.id, prId, s.ctx);
    expect(dto).toMatchObject({ number: 12, repo: 'moooon/acme' });
    // The DTO no longer carries provenance at all (MOTIR-4894) — a client that
    // parsed `linkedManually` off this shape has nothing to read.
    expect(dto).not.toHaveProperty('linkedManually');

    expect(await deliveredItemIds(prId)).toEqual([item.id]);
    // …and the MIRROR ROW is untouched by the link. The picker used to stamp
    // `linked_manually` here; the delivery above is now the whole write.
    const after = await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: prId } });
    expect(after.linkedManually).toBe(false);
  });

  // ⚠️ THE ASSERTION IS INVERTED FROM WHAT THIS TEST USED TO PIN, and the
  // inversion is the deliverable rather than a fixture repair. It read *a takeover
  // MOVES the link to the picking item (single FK, no confirm)* — true while the
  // association was `github_pull_request.work_item_id`, and the reason the corpus
  // told a parent run to link the PARENT once. MOTIR-3757 dropped that column, so
  // a second link ADDS a delivery and the first one stands; `unlink_pull_request`
  // is the only thing that takes one away.
  it('a second link ADDS a delivery — the first item keeps its own (no confirm)', async () => {
    const s = await makeScenario({
      email: 'link-takeover@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const itemA = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Item A' },
      s.ctx,
    );
    const itemB = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Item B' },
      s.ctx,
    );
    const prId = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 15,
      headBranch: 'feature/shared',
      title: 'Shared change',
    });
    await githubPullRequestService.linkPullRequest(itemA.id, prId, s.ctx);
    await githubPullRequestService.linkPullRequest(itemB.id, prId, s.ctx);

    expect(await deliveredItemIds(prId)).toEqual([itemA.id, itemB.id]);
  });

  it('a cross-workspace PR is rejected (no existence leak)', async () => {
    // ws1 owns the PR (its installation + repo) — the object itself isn't needed.
    await makeScenario({
      email: 'xws-1@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const ws2 = await makeScenario({
      email: 'xws-2@example.com',
      installationId: INST_B,
      repoProviderId: REPO_B,
    });
    const prId = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 21,
      headBranch: 'feature/ws1',
      title: 'WS1 PR',
    });
    const item2 = await workItemsService.createWorkItem(
      { projectId: ws2.project.id, kind: 'task', title: 'WS2 item' },
      ws2.ctx,
    );
    await expect(
      githubPullRequestService.linkPullRequest(item2.id, prId, ws2.ctx),
    ).rejects.toBeInstanceOf(GithubPullRequestNotFoundError);
  });

  it('an unknown PR id is rejected', async () => {
    const s = await makeScenario({
      email: 'unknown-pr@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Item' },
      s.ctx,
    );
    await expect(
      githubPullRequestService.linkPullRequest(item.id, 'pr-does-not-exist', s.ctx),
    ).rejects.toBeInstanceOf(GithubPullRequestNotFoundError);
  });
});

describe('githubPullRequestService.searchLinkCandidates (MOTIR-1596)', () => {
  it('returns matches, annotates a PR linked elsewhere, and excludes the current item’s PRs', async () => {
    const s = await makeScenario({
      email: 'candidates@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const itemA = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Alpha' },
      s.ctx,
    );
    const itemB = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Beta' },
      s.ctx,
    );
    // PR#30 is LINKED to itemA (MOTIR-3674 — the branch naming it is no longer
    // enough, and this case is about the takeover chip a linked PR carries);
    // PR#40 is unlinked.
    await linkPrByIdentifier({
      identifier: itemA.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 30,
      headRef: `feat/${itemA.identifier}-rate`,
      title: 'Rate limiting alpha',
    });
    await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 30,
      headBranch: `feat/${itemA.identifier}-rate`,
      title: 'Rate limiting alpha',
    });
    const pr40 = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 40,
      headBranch: 'feat/beta-rate',
      title: 'Rate limiting beta',
    });

    // Searching from itemB: both match "rate"; #30 carries the takeover chip.
    let results = await githubPullRequestService.searchLinkCandidates(itemB.id, 'rate', s.ctx);
    const byNumber = Object.fromEntries(results.map((r) => [r.number, r]));
    expect(byNumber[30]?.linkedTo).toEqual([itemA.identifier]);
    expect(byNumber[40]?.linkedTo).toEqual([]);

    // Search by NUMBER also resolves.
    results = await githubPullRequestService.searchLinkCandidates(itemB.id, '40', s.ctx);
    expect(results.map((r) => r.number)).toContain(40);

    // Once #40 is linked to itemB, it drops out of itemB's own candidate list.
    await githubPullRequestService.linkPullRequest(itemB.id, pr40, s.ctx);
    results = await githubPullRequestService.searchLinkCandidates(itemB.id, 'rate', s.ctx);
    expect(results.map((r) => r.number)).not.toContain(40);
    expect(results.map((r) => r.number)).toContain(30);
  });

  // MOTIR-3756 — `linkedTo` is the DELIVERY SET, and the two things that depend
  // on its being a set are asserted here: what the chip renders at n ≥ 2, and the
  // self-exclusion, which is a CONTAINS test and not an equality.
  it('a candidate delivering several cards carries every identifier, oldest link first', async () => {
    const s = await makeScenario({
      email: 'candidate-set@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const [first, second, asking] = [
      await workItemsService.createWorkItem(
        { projectId: s.project.id, kind: 'task', title: 'First carried' },
        s.ctx,
      ),
      await workItemsService.createWorkItem(
        { projectId: s.project.id, kind: 'task', title: 'Second carried' },
        s.ctx,
      ),
      await workItemsService.createWorkItem(
        { projectId: s.project.id, kind: 'task', title: 'The asking card' },
        s.ctx,
      ),
    ];
    const pr = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 55,
      headBranch: 'motir/auto-abc',
      title: 'Session run carrying several cards',
    });
    // Linked in order, so "oldest link first" has something to be true OF.
    await githubPullRequestService.linkPullRequest(first.id, pr, s.ctx);
    await githubPullRequestService.linkPullRequest(second.id, pr, s.ctx);

    const results = await githubPullRequestService.searchLinkCandidates(
      asking.id,
      'Session run',
      s.ctx,
    );
    const candidate = results.find((r) => r.number === 55);
    // BOTH, in link order — the singular column names only the SECOND link, so a
    // reader on the column would have shown one identifier and the wrong one.
    expect(candidate?.linkedTo).toEqual([first.identifier, second.identifier]);
  });

  it('a candidate is dropped when its delivery set CONTAINS the current item, not only when it equals it', async () => {
    const s = await makeScenario({
      email: 'candidate-contains@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const asking = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'The asking card' },
      s.ctx,
    );
    const other = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A sibling on the same run' },
      s.ctx,
    );
    const pr = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 56,
      headBranch: 'motir/auto-def',
      title: 'Session run delivering the asker among others',
    });
    // The ASKER is linked FIRST and the sibling SECOND, so the singular column —
    // which moves on each link — ends up naming the SIBLING. Under the old
    // `row.workItemId !== currentItemId` filter this candidate survived and the
    // picker offered the asking card its own pull request as a fresh one.
    await githubPullRequestService.linkPullRequest(asking.id, pr, s.ctx);
    await githubPullRequestService.linkPullRequest(other.id, pr, s.ctx);

    const results = await githubPullRequestService.searchLinkCandidates(
      asking.id,
      'Session run',
      s.ctx,
    );
    expect(results.map((r) => r.number)).not.toContain(56);
  });

  it('a short query returns [] (the type-to-search prompt)', async () => {
    const s = await makeScenario({
      email: 'short-q@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Item' },
      s.ctx,
    );
    expect(await githubPullRequestService.searchLinkCandidates(item.id, 'a', s.ctx)).toEqual([]);
  });

  it('a disconnected workspace throws GithubNotConnectedError', async () => {
    const s = await makeScenario({
      email: 'disconnected@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
      withInstallation: false,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Item' },
      s.ctx,
    );
    await expect(
      githubPullRequestService.searchLinkCandidates(item.id, 'rate', s.ctx),
    ).rejects.toBeInstanceOf(GithubNotConnectedError);
  });

  it('a cross-workspace current item is rejected', async () => {
    const ws1 = await makeScenario({
      email: 'cand-xws-1@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const ws2 = await makeScenario({
      email: 'cand-xws-2@example.com',
      installationId: INST_B,
      repoProviderId: REPO_B,
    });
    const item1 = await workItemsService.createWorkItem(
      { projectId: ws1.project.id, kind: 'task', title: 'WS1 item' },
      ws1.ctx,
    );
    await expect(
      githubPullRequestService.searchLinkCandidates(item1.id, 'rate', ws2.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

// MOTIR-5150 — a pull request can be found by its REFERENCE, not only by a
// substring of its title / owner / name and not only by a bare number.
//
// ⚠️ THE FIXTURE IS WHAT MAKES THESE LOAD-BEARING, so it is built deliberately:
// the repository is `zeta-labs/widgets` and the pull request is titled "Tighten
// the provisioning gate", so NO query below is a substring of the title, the
// owner or the name. The four pre-existing `contains` clauses therefore cannot
// satisfy a single one of them — revert the reference arm and every assertion in
// the first four tests fails. (That is the check the card asks for: a passing
// test that the old grammar could also have passed proves nothing.)
//
// The second repository, `zeta-labs/widgets-internal`, carries a pull request
// with the SAME number. It is what separates `equals` from `contains` — and it
// is also the concrete reason the bare-number form was never sufficient.
const INST_C = 'inst-explicit-c';
const REPO_C_PUBLIC = '9303';
const REPO_C_INTERNAL = '9304';

/** A workspace whose installation carries TWO repositories, one of them a
 *  name-PREFIX of the other. `persistInstallation` reconciles its repo set, so
 *  both are passed in one call rather than in two. */
async function makeTwoRepoScenario(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Own' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Zeta',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Zeta',
    identifier: 'ZETA',
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INST_C,
      accountLogin: 'zeta-labs',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_C_PUBLIC,
        owner: 'zeta-labs',
        name: 'widgets',
        defaultBranch: 'main',
        archived: false,
      },
      {
        providerRepoId: REPO_C_INTERNAL,
        owner: 'zeta-labs',
        name: 'widgets-internal',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

/** Ingest a PR and resolve its row by (repo, number) — `ingestPr` above keys on
 *  the number alone, which cannot tell two repositories' #466 apart. */
async function ingestPrInRepo(opts: {
  repoProviderId: string;
  number: number;
  headBranch: string;
  title: string;
}): Promise<string> {
  await githubWebhookService.handleEvent(
    'pull_request',
    prEvent({ installationId: INST_C, ...opts }),
  );
  const repo = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: opts.repoProviderId },
  });
  const row = await adminDb.githubPullRequest.findFirstOrThrow({
    where: { repoId: repo.id, number: opts.number },
  });
  return row.id;
}

/** The fixture both halves of this describe share: two repositories, each with a
 *  pull request numbered 466, and an asking item to search from. */
async function seedReferenceFixture(email: string) {
  const s = await makeTwoRepoScenario(email);
  const asking = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'Asking' },
    s.ctx,
  );
  const publicPr = await ingestPrInRepo({
    repoProviderId: REPO_C_PUBLIC,
    number: 466,
    headBranch: 'feature/provisioning-gate',
    title: 'Tighten the provisioning gate',
  });
  const internalPr = await ingestPrInRepo({
    repoProviderId: REPO_C_INTERNAL,
    number: 466,
    headBranch: 'feature/internal-gate',
    title: 'Internal gate tightening',
  });
  return { ...s, asking, publicPr, internalPr };
}

describe('searchLinkCandidates — a pull-request REFERENCE (MOTIR-5150)', () => {
  it('finds the pull request by the URL a person pasted', async () => {
    const f = await seedReferenceFixture('ref-url@example.com');
    const results = await githubPullRequestService.searchLinkCandidates(
      f.asking.id,
      'https://github.com/zeta-labs/widgets/pull/466',
      f.ctx,
    );
    expect(results.map((r) => r.id)).toEqual([f.publicPr]);
  });

  it('finds it by owner/name#n', async () => {
    const f = await seedReferenceFixture('ref-owner-name@example.com');
    const results = await githubPullRequestService.searchLinkCandidates(
      f.asking.id,
      'zeta-labs/widgets#466',
      f.ctx,
    );
    expect(results.map((r) => r.id)).toEqual([f.publicPr]);
  });

  it('finds it by name#n — and `widgets` does NOT reach `widgets-internal`', async () => {
    const f = await seedReferenceFixture('ref-name@example.com');
    const results = await githubPullRequestService.searchLinkCandidates(
      f.asking.id,
      'widgets#466',
      f.ctx,
    );
    // The whole point of matching a coordinate with `equals` rather than
    // `contains`: a repository whose name merely STARTS with the one named is a
    // different repository.
    expect(results.map((r) => r.id)).toEqual([f.publicPr]);
  });

  it('finds both repositories’ #466 by the bare #n form — the form that cannot disambiguate', async () => {
    const f = await seedReferenceFixture('ref-hash@example.com');
    const results = await githubPullRequestService.searchLinkCandidates(f.asking.id, '#466', f.ctx);
    expect(results.map((r) => r.id).sort()).toEqual([f.publicPr, f.internalPr].sort());
  });

  it('a coordinate naming a repository in ANOTHER workspace returns no candidate', async () => {
    const mine = await makeScenario({
      email: 'ref-xws-mine@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    // A second workspace with the repository the coordinate names, and a pull
    // request in it. Nothing about the coordinate is wrong — the workspace gate
    // is what refuses it, which is the tenancy decision staying where it was.
    const theirs = await seedReferenceFixture('ref-xws-theirs@example.com');
    expect(theirs.publicPr).toBeTruthy();
    const item = await workItemsService.createWorkItem(
      { projectId: mine.project.id, kind: 'task', title: 'Mine' },
      mine.ctx,
    );
    for (const query of [
      'https://github.com/zeta-labs/widgets/pull/466',
      'zeta-labs/widgets#466',
      'widgets#466',
      '#466',
    ]) {
      expect(
        await githubPullRequestService.searchLinkCandidates(item.id, query, mine.ctx),
        query,
      ).toEqual([]);
    }
  });
});

describe('searchLinkCandidates — the free-text grammar is UNCHANGED (MOTIR-5150)', () => {
  it('still matches a substring of the TITLE', async () => {
    const f = await seedReferenceFixture('free-title@example.com');
    const results = await githubPullRequestService.searchLinkCandidates(
      f.asking.id,
      'provisioning',
      f.ctx,
    );
    expect(results.map((r) => r.id)).toEqual([f.publicPr]);
  });

  it('still matches a substring of the repo OWNER', async () => {
    const f = await seedReferenceFixture('free-owner@example.com');
    const results = await githubPullRequestService.searchLinkCandidates(
      f.asking.id,
      'zeta-labs',
      f.ctx,
    );
    expect(results.map((r) => r.id).sort()).toEqual([f.publicPr, f.internalPr].sort());
  });

  it('still matches a substring of the repo NAME — `contains`, so both repositories', async () => {
    const f = await seedReferenceFixture('free-name@example.com');
    const results = await githubPullRequestService.searchLinkCandidates(
      f.asking.id,
      'widgets',
      f.ctx,
    );
    expect(results.map((r) => r.id).sort()).toEqual([f.publicPr, f.internalPr].sort());
  });

  it('still matches a BARE number', async () => {
    const f = await seedReferenceFixture('free-number@example.com');
    const results = await githubPullRequestService.searchLinkCandidates(f.asking.id, '466', f.ctx);
    expect(results.map((r) => r.id).sort()).toEqual([f.publicPr, f.internalPr].sort());
  });
});

describe('a manual link is STICKY against the webhook resolver (MOTIR-1596)', () => {
  it('survives a later PR event whose branch never names the key', async () => {
    const s = await makeScenario({
      email: 'sticky@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Manual target' },
      s.ctx,
    );
    const prId = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 55,
      headBranch: 'feature/no-key-here',
      title: 'Unnamed PR',
    });
    await githubPullRequestService.linkPullRequest(item.id, prId, s.ctx);

    // A later delivery (reopened) whose branch STILL names no key: the resolver
    // finds nothing, but the manual link is preserved — NOT cleared to null.
    await githubWebhookService.handleEvent(
      'pull_request',
      prEvent({
        installationId: INST_A,
        repoProviderId: REPO_A,
        number: 55,
        headBranch: 'feature/no-key-here',
        title: 'Unnamed PR (reopened)',
        action: 'reopened',
      }),
    );
    expect(await deliveredItemIds(prId)).toEqual([item.id]);
  });

  it('drives the status sync on merge (merged → Done via the declared link)', async () => {
    const s = await makeScenario({
      email: 'sticky-merge@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Merge target' },
      s.ctx,
    );
    const prId = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 66,
      headBranch: 'feature/unnamed-merge',
      title: 'Unnamed merge PR',
    });
    await githubPullRequestService.linkPullRequest(item.id, prId, s.ctx);
    // Move to In Review so the merge's Done transition is workflow-legal.
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);

    await githubWebhookService.handleEvent(
      'pull_request',
      prEvent({
        installationId: INST_A,
        repoProviderId: REPO_A,
        number: 66,
        headBranch: 'feature/unnamed-merge',
        title: 'Unnamed merge PR',
        action: 'closed',
        state: 'closed',
        merged: true,
      }),
    );
    const moved = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(moved?.status).toBe('done');
    // The link survives the merge delivery — as a delivery ROW, which is the
    // only place it has lived since MOTIR-3757 and the only place it is recorded
    // at all since MOTIR-4894 retired the flag beside it.
    expect(await deliveredItemIds(prId)).toEqual([item.id]);
  });
});
