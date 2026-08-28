import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-3659 — THE DELIVERY-SET GATE, the fourth completion gate and the one keyed
// on the thing actually being waited for (Story MOTIR-3655, ADR
// `docs/decisions/work-item-delivery-links.md`).
//
// The three shipped gates are each keyed on a PROXY: how many linked pull requests
// are open, which base the merge in hand landed on, which repositories the card
// promised. This one reads the card's DELIVERY SET — the pull requests that
// actually deliver it — and holds until every one of them has merged onto its own
// repository's default branch.
//
// Real Postgres, the real webhook service, the real link path — no mocks (the
// motir-core convention). What is pinned here:
//
//   1. Two deliveries, the first merges → HELD, status UNCHANGED, and the note
//      names the one still outstanding.
//   2. The second merge completes it.
//   3. ORDER-INDEPENDENCE. B-then-A ends identically. A gate that only works in
//      the order its author imagined is a gate that works once, and the second
//      half of a two-repository card frequently lands first because it is smaller.
//   4. The gate ABSTAINS wherever the product behaves as it does today — zero
//      links and one link are the overwhelming majority of cards, and they must be
//      byte-identical.
//   5. A merge onto a NON-default base is still `deferred_non_default_base`, which
//      is checked FIRST — the outcomes must not shadow each other.
//   6. The note is posted ONCE per merge, however often the host redelivers.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-delivery-set';

interface RepoSpec {
  name: string;
  providerRepoId: string;
  defaultBranch?: string;
}

const CORE: RepoSpec = { name: 'motir-core', providerRepoId: '7301', defaultBranch: 'main' };
// A DIFFERENT default branch on purpose: the gate compares each member against ITS
// repository's own trunk, never a hard-coded `main`.
const AI: RepoSpec = { name: 'motir-ai', providerRepoId: '7302', defaultBranch: 'trunk' };

async function makeScenario(email: string, repos: RepoSpec[]) {
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
    { projectId: project.id, kind: 'task', title: 'A change delivered by more than one branch' },
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
  /** Omit the key from head/title — the case where NOTHING but an explicit link
   *  could associate this pull request. */
  anonymous?: boolean;
}) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(opts.repo.providerRepoId) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: opts.anonymous ? 'Some change' : `Some change (${opts.identifier})`,
      head: {
        ref: opts.anonymous ? 'work/a-change' : `subtask/${opts.identifier}-a-change`,
      },
      base: { ref: opts.baseRef ?? opts.repo.defaultBranch ?? 'main' },
      user: { id: 4242 },
    },
  };
}

const open = (identifier: string, repo: RepoSpec, number: number, anonymous = false) =>
  githubWebhookService.handleEvent(
    'pull_request',
    prPayload({ action: 'opened', identifier, repo, number, anonymous }),
  );

const merge = (
  identifier: string,
  repo: RepoSpec,
  number: number,
  baseRef?: string,
  anonymous = false,
) =>
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
      anonymous,
    }),
  );

/** Declare a delivery the way an agent does after `gh pr create`. */
async function declare(
  s: Awaited<ReturnType<typeof makeScenario>>,
  repo: RepoSpec,
  number: number,
) {
  return githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId: s.item.id,
      projectId: s.project.id,
      owner: 'moooon',
      name: repo.name,
      number,
      headRef: 'work/a-change',
      baseRef: repo.defaultBranch ?? 'main',
      title: 'Some change',
    },
    s.ctx,
  );
}

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

describe('the delivery-SET gate — a card is done when EVERY delivery has landed', () => {
  it('HOLDS a two-delivery card when the first merges and the second has not', async () => {
    const s = await makeScenario('two-deliveries@example.com', [CORE, AI]);
    await open(s.item.identifier, CORE, 1, true);
    await open(s.item.identifier, AI, 2, true);
    await declare(s, CORE, 1);
    await declare(s, AI, 2);

    const result = await merge(s.item.identifier, CORE, 1, undefined, true);

    expect(result).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    // The STATUS and the OUTCOME are asserted separately on purpose: the two came
    // apart in the incident this story exists for.
    expect(await statusOf(s.item.id)).toBe('in_progress');
  });

  it('NAMES the outstanding delivery on the card, so the hold is not a mystery', async () => {
    const s = await makeScenario('names-outstanding@example.com', [CORE, AI]);
    await open(s.item.identifier, CORE, 1, true);
    await open(s.item.identifier, AI, 2, true);
    await declare(s, CORE, 1);
    await declare(s, AI, 2);

    await merge(s.item.identifier, CORE, 1, undefined, true);

    const notes = await commentBodies(s.item.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Merged, but this item is not complete');
    expect(notes[0]).toContain('moooon/motir-ai#2');
    // And it must be distinguishable from the repository-SET note, which names
    // repositories the card PROMISED rather than pull requests that EXIST.
    expect(notes[0]).toContain('Still open');
  });

  it('COMPLETES when the second delivery merges onto its own default branch', async () => {
    const s = await makeScenario('completes@example.com', [CORE, AI]);
    await open(s.item.identifier, CORE, 1, true);
    await open(s.item.identifier, AI, 2, true);
    await declare(s, CORE, 1);
    await declare(s, AI, 2);

    await merge(s.item.identifier, CORE, 1, undefined, true);
    // `trunk`, not `main` — the comparison is per repository.
    const second = await merge(s.item.identifier, AI, 2, 'trunk', true);

    expect(second).toMatchObject({ outcome: 'transitioned' });
    expect(await statusOf(s.item.id)).toBe('done');
  });

  it('is ORDER-INDEPENDENT — the smaller half landing first ends identically', async () => {
    const s = await makeScenario('order-independent@example.com', [CORE, AI]);
    await open(s.item.identifier, CORE, 1, true);
    await open(s.item.identifier, AI, 2, true);
    await declare(s, CORE, 1);
    await declare(s, AI, 2);

    const first = await merge(s.item.identifier, AI, 2, 'trunk', true);
    expect(first).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect(await statusOf(s.item.id)).toBe('in_progress');

    const second = await merge(s.item.identifier, CORE, 1, undefined, true);
    expect(second).toMatchObject({ outcome: 'transitioned' });
    expect(await statusOf(s.item.id)).toBe('done');
  });

  it('HOLDS when a delivery merged onto a base that is not its own trunk, and says so', async () => {
    const s = await makeScenario('stranded-member@example.com', [CORE, AI]);
    await open(s.item.identifier, CORE, 1, true);
    await open(s.item.identifier, AI, 2, true);
    await declare(s, CORE, 1);
    await declare(s, AI, 2);

    // The AI half lands on a side branch — merged, but nothing reached its trunk.
    await merge(s.item.identifier, AI, 2, 'release/1.x', true);
    const result = await merge(s.item.identifier, CORE, 1, undefined, true);

    expect(result).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
    const notes = await commentBodies(s.item.id);
    expect(notes.join('\n')).toContain('not onto the trunk');
  });
});

describe('the gate ABSTAINS wherever the product behaves as it does today', () => {
  // ⚠️ REWRITTEN by MOTIR-3674. This case used to say *no `declare` — the title
  // parse is what associates this one, as it always did*, and it was the gate's
  // abstain arm for a card whose association came from text. There is no such
  // card any more: with the parse retired, a pull request nobody declared
  // delivers nothing, so the delivery never reaches the gate at all. What the
  // abstain arm still has to cover is a card whose link was written by
  // `mark_integrated` rather than `link_pull_request` — asserted below — and
  // this case now pins the honest consequence for the unlinked one.
  it('a card whose pull request was never declared is not completed by its merge at all', async () => {
    const s = await makeScenario('no-links@example.com', [CORE]);
    await open(s.item.identifier, CORE, 1);
    const result = await merge(s.item.identifier, CORE, 1);

    expect(result).toMatchObject({ outcome: 'no_work_item' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
  });

  it('a card with ONE delivery link completes on that delivery’s merge', async () => {
    const s = await makeScenario('one-link@example.com', [CORE]);
    await open(s.item.identifier, CORE, 1, true);
    await declare(s, CORE, 1);

    const result = await merge(s.item.identifier, CORE, 1, undefined, true);

    expect(result).toMatchObject({ outcome: 'transitioned' });
    expect(await statusOf(s.item.id)).toBe('done');
    expect(await commentBodies(s.item.id)).toEqual([]);
  });

  it('a NON-default merge still reports deferred_non_default_base — checked BEFORE this gate', async () => {
    const s = await makeScenario('non-default-first@example.com', [CORE, AI]);
    await open(s.item.identifier, CORE, 1, true);
    await open(s.item.identifier, AI, 2, true);
    await declare(s, CORE, 1);
    await declare(s, AI, 2);

    // This merge itself never reached the trunk. That is not partial completion,
    // it is none — and the more specific diagnosis must win.
    const result = await merge(s.item.identifier, CORE, 1, 'release/2.x', true);

    expect(result).toMatchObject({ outcome: 'deferred_non_default_base' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
  });
});

describe('the hold is idempotent under redelivery', () => {
  it('posts its note ONCE per merge, however many times the host redelivers', async () => {
    const s = await makeScenario('redelivered@example.com', [CORE, AI]);
    await open(s.item.identifier, CORE, 1, true);
    await open(s.item.identifier, AI, 2, true);
    await declare(s, CORE, 1);
    await declare(s, AI, 2);

    await merge(s.item.identifier, CORE, 1, undefined, true);
    await merge(s.item.identifier, CORE, 1, undefined, true);
    await merge(s.item.identifier, CORE, 1, undefined, true);

    expect(await commentBodies(s.item.id)).toHaveLength(1);
    expect(await statusOf(s.item.id)).toBe('in_progress');
  });
});
