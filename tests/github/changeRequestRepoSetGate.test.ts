import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-2729 — THE REPOSITORY-SET GATE, the third completion gate and the reason
// the repository SET exists.
//
// The two shipped gates both reason about change requests that EXIST:
// `deferred_non_default_base` reads the merge in hand, `deferred_open_pr` counts
// linked rows with `state: 'open'`. A repository whose pull request has NOT BEEN
// OPENED writes no row at all, so the count is zero and the item completes on half
// its work — which is what happened on 2026-08-11 (MOTIR-2664). The missing input
// was never the count; it was the EXPECTED side.
//
// Real Postgres, the real webhook service, the real provider seam — no mocks (the
// motir-core convention). What is pinned here:
//
//   1. Two repositories, one merged and the other with NO PR ROW AT ALL → HELD.
//      This is the case the shipped gates structurally cannot see, and it is the
//      card's primary test.
//   2. The second merge completes it.
//   3. An empty set behaves EXACTLY as it does today — the common case, and every
//      card in the product.
//   4. A one-repository card behaves exactly as it does today.
//   5. The gate ORDER: a non-default base still reports `deferred_non_default_base`,
//      and an open sibling still reports `deferred_open_pr` — the more specific
//      diagnosis wins where both hold.
//   6. A sibling repository whose only merged PR landed on a NON-default branch does
//      NOT satisfy it — the composition of MOTIR-1873 and MOTIR-1604, and the reason
//      `github_pull_request.base_ref` had to be persisted at all.
//   7. A merged row with a NULL base (mirrored before the column existed) holds, and
//      says so in its own words rather than naming a branch Motir does not know.
//   8. The hold posts its note ONCE per merge and a failed note never breaks the hold.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-repo-set';

interface RepoSpec {
  name: string;
  providerRepoId: string;
  defaultBranch?: string;
}

const CORE: RepoSpec = { name: 'motir-core', providerRepoId: '7001', defaultBranch: 'main' };
const AI: RepoSpec = { name: 'motir-ai', providerRepoId: '7002', defaultBranch: 'trunk' };

/** A workspace + project + a work item, plus a mirrored installation carrying
 *  every repo in `repos`. The item is left at `in_progress` unless a delivery
 *  moves it. */
async function makeScenario(email: string, repos: RepoSpec[], targetRepos: string[]) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
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

  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: repos.map((r) => ({
      providerRepoId: r.providerRepoId,
      owner: 'moooon',
      name: r.name,
      defaultBranch: r.defaultBranch ?? 'main',
      archived: false,
    })),
  });

  const item = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'task',
      title: 'A change that ships in more than one repository',
      ...(targetRepos.length > 0 ? { targetRepos } : {}),
    },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  return { user, workspace, project, item, ctx };
}

function prPayload(opts: {
  action: string;
  identifier: string;
  repo: RepoSpec;
  baseRef?: string;
  number: number;
  state?: 'open' | 'closed';
  merged?: boolean;
}) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(opts.repo.providerRepoId) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: `Some change (${opts.identifier})`,
      head: { ref: `subtask/${opts.identifier}-a-change` },
      base: { ref: opts.baseRef ?? opts.repo.defaultBranch ?? 'main' },
      user: { id: 4242 },
    },
  };
}

const open = async (identifier: string, repo: RepoSpec, number: number, baseRef?: string) => {
  // MOTIR-3674 — the link is the only association a pull request has; the key in
  // the branch is a label. A run writes it the moment `gh pr create` returns,
  // which is before the `opened` delivery lands.
  await linkPrByIdentifier({
    identifier,
    owner: 'moooon',
    name: repo.name,
    number,
    headRef: `subtask/${identifier}-a-change`,
    baseRef: baseRef ?? repo.defaultBranch ?? 'main',
    title: `Some change (${identifier})`,
  });
  return githubWebhookService.handleEvent(
    'pull_request',
    prPayload({ action: 'opened', identifier, repo, number, baseRef }),
  );
};

const merge = (identifier: string, repo: RepoSpec, number: number, baseRef?: string) =>
  githubWebhookService.handleEvent(
    'pull_request',
    prPayload({
      action: 'closed',
      identifier,
      repo,
      number,
      baseRef,
      state: 'closed',
      merged: true,
    }),
  );

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

async function commentBodies(workItemId: string): Promise<string[]> {
  const rows = await adminDb.comment.findMany({
    where: { workItemId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((c) => c.bodyMd);
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the repository-SET gate — the case the shipped gates cannot see', () => {
  it('HOLDS a two-repository item when the other repository has NO pull request row at all', async () => {
    const { item } = await makeScenario(
      'set-hold@example.com',
      [CORE, AI],
      ['motir-core', 'motir-ai'],
    );
    await open(item.identifier, CORE, 1);
    // Only motir-core's PR exists. motir-ai's has never been opened, so it writes
    // no row — `countOtherOpenByWorkItem` returns 0 and the shipped gate would
    // complete the item here.
    const result = await merge(item.identifier, CORE, 1);

    expect(result).toMatchObject({ outcome: 'deferred_incomplete_repo_set' });
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('NAMES the outstanding repository on the item, so the hold is not a mystery', async () => {
    const { item } = await makeScenario(
      'set-note@example.com',
      [CORE, AI],
      ['motir-core', 'motir-ai'],
    );
    await open(item.identifier, CORE, 1);
    await merge(item.identifier, CORE, 1);

    const bodies = await commentBodies(item.id);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('motir-ai');
    // It states the condition that WILL complete the item — a hold that does not
    // say what unblocks it reads as a stuck integration.
    expect(bodies[0]).toContain('default branch');
    expect(bodies[0]).not.toContain('motir-core');
  });

  it('COMPLETES when the second repository merges onto its own default branch', async () => {
    const { item } = await makeScenario(
      'set-complete@example.com',
      [CORE, AI],
      ['motir-core', 'motir-ai'],
    );
    await open(item.identifier, CORE, 1);
    await merge(item.identifier, CORE, 1);
    expect(await statusOf(item.id)).toBe('implemented');

    await open(item.identifier, AI, 2);
    // `trunk`, not `main` — the mirrored default branch, never a hard-coded guess.
    const second = await merge(item.identifier, AI, 2, 'trunk');

    expect(second).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(item.id)).toBe('done');
  });

  it('does NOT count a sibling repository’s merge onto a NON-default branch', async () => {
    // The composition of MOTIR-1873 and MOTIR-1604: motir-ai's change request
    // merged, truthfully, onto a branch that is not its trunk. `merged: true`
    // forever, no path to `trunk`. Without the recorded base this would read as
    // satisfied and the item would complete on a stranded merge.
    const { item } = await makeScenario(
      'set-stranded@example.com',
      [CORE, AI],
      ['motir-core', 'motir-ai'],
    );
    await open(item.identifier, AI, 2, 'feature/stack-base');
    const stranded = await merge(item.identifier, AI, 2, 'feature/stack-base');
    expect(stranded).toMatchObject({ outcome: 'deferred_non_default_base' });

    await open(item.identifier, CORE, 1);
    const result = await merge(item.identifier, CORE, 1);

    // ⚠️ The DIAGNOSIS moved with MOTIR-3674 and the design is unchanged. Both
    // pull requests are LINKED now (the parse that used to associate them is
    // gone), so each carries a `work_item_delivery` row and the delivery-set
    // gate — more specific, evaluated first (`work-item-delivery-links.md` Q3)
    // — answers before the repository-set gate is asked. Its note names the same
    // fact in the pull request's own terms: this one merged somewhere that is
    // not its repository's trunk. The HOLD is identical, which is the property
    // this case exists for.
    expect(result).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect(await statusOf(item.id)).toBe('implemented');
    expect((await commentBodies(item.id)).at(-1)).toContain('Merged, but not onto the trunk');
  });

  it('holds on a merged row whose base is UNKNOWN, and says that rather than naming a branch', async () => {
    const { item } = await makeScenario(
      'set-unknown@example.com',
      [CORE, AI],
      ['motir-core', 'motir-ai'],
    );
    await open(item.identifier, AI, 2);
    await merge(item.identifier, AI, 2, 'trunk');
    // Put the row back into the shape a PR mirrored BEFORE `base_ref` existed has.
    await adminDb.githubPullRequest.updateMany({
      where: { number: 2 },
      data: { baseRef: null },
    });

    await open(item.identifier, CORE, 1);
    const result = await merge(item.identifier, CORE, 1);

    // Same gate shift as the case above (MOTIR-3674): linked deliveries mean the
    // delivery-set gate answers first. It carries the SAME unknown-base wording,
    // which is what this case is really pinning.
    expect(result).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect(await statusOf(item.id)).toBe('implemented');
    const note = (await commentBodies(item.id)).at(-1)!;
    // UNKNOWN in both directions: it must not claim the repository is outstanding
    // (the merge may well have reached the trunk), and it must not claim a branch.
    expect(note).toContain('No record of which branch');
    expect(note).toContain('motir-ai');
    expect(note).not.toContain('Still outstanding');
  });
});

describe('the gate ABSTAINS wherever the product behaves as it does today', () => {
  it('an item carrying NO repositories completes on the first merge, exactly as before', async () => {
    const { item } = await makeScenario('set-empty@example.com', [CORE], []);
    await open(item.identifier, CORE, 1);
    const result = await merge(item.identifier, CORE, 1);

    expect(result).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(item.id)).toBe('done');
    expect(await commentBodies(item.id)).toEqual([]);
  });

  it('an item carrying ONE repository completes on that repository’s merge', async () => {
    const { item } = await makeScenario('set-one@example.com', [CORE], ['motir-core']);
    await open(item.identifier, CORE, 1);
    const result = await merge(item.identifier, CORE, 1);

    expect(result).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(item.id)).toBe('done');
  });

  it('a NON-default merge still reports deferred_non_default_base — checked BEFORE this gate', async () => {
    const { item } = await makeScenario(
      'set-order-base@example.com',
      [CORE, AI],
      ['motir-core', 'motir-ai'],
    );
    await open(item.identifier, CORE, 1, 'release/1.x');
    const result = await merge(item.identifier, CORE, 1, 'release/1.x');

    // A merge with no path to the trunk is not PARTIAL completion, it is none —
    // so the stronger statement wins even though the set is also incomplete.
    expect(result).toMatchObject({ outcome: 'deferred_non_default_base' });
  });

  it('an OPEN sibling still reports deferred_open_pr — the more specific diagnosis wins', async () => {
    const { item } = await makeScenario(
      'set-order-open@example.com',
      [CORE, AI],
      ['motir-core', 'motir-ai'],
    );
    await open(item.identifier, CORE, 1);
    await open(item.identifier, AI, 2);
    const result = await merge(item.identifier, CORE, 1);

    // ⚠️ THREE gates hold here now (MOTIR-3674). With both pull requests linked,
    // `deferred_incomplete_delivery_set` is the most specific of them and is
    // evaluated first: it names the still-open pull request AND says what would
    // complete the item, which is what `deferred_open_pr` was preferred for over
    // "motir-ai has no merge". The ordering is `work-item-delivery-links.md` Q3's.
    expect(result).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect((await commentBodies(item.id)).at(-1)).toContain('Still open');
    expect(await statusOf(item.id)).toBe('implemented');
  });
});

describe('the hold is idempotent under redelivery', () => {
  it('posts its note ONCE per merge, however many times the host redelivers', async () => {
    const { item } = await makeScenario(
      'set-redeliver@example.com',
      [CORE, AI],
      ['motir-core', 'motir-ai'],
    );
    await open(item.identifier, CORE, 1);
    await merge(item.identifier, CORE, 1);
    await merge(item.identifier, CORE, 1);
    const third = await merge(item.identifier, CORE, 1);

    expect(third).toMatchObject({ outcome: 'deferred_incomplete_repo_set' });
    expect(await commentBodies(item.id)).toHaveLength(1);
    expect(await statusOf(item.id)).toBe('implemented');
  });
});

describe('the mirror RECORDS the base — the column the gate reads', () => {
  it('persists the base branch of every delivery, on open and on merge', async () => {
    const { item } = await makeScenario('set-baseref@example.com', [CORE, AI], ['motir-core']);
    await open(item.identifier, CORE, 1);
    expect((await adminDb.githubPullRequest.findFirst({ where: { number: 1 } }))?.baseRef).toBe(
      'main',
    );

    await open(item.identifier, AI, 2, 'feature/stack');
    expect((await adminDb.githubPullRequest.findFirst({ where: { number: 2 } }))?.baseRef).toBe(
      'feature/stack',
    );
  });
});
