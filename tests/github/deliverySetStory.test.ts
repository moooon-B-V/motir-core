import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE STORY, ASSEMBLED (Story MOTIR-3655 · MOTIR-3661) — a card delivered by
// TWO branches, driven through the real `pull_request` webhook seam over real
// Postgres.
//
// ── Why a story spec, when every card has its own unit tests ───────────────
// All of those pass while the story is broken, and that is not hypothetical:
// the write path, the gate and the read surface each have a coherent LOCAL
// story, and the failure this exists to catch lives between them.
// `completeSession` clearing the whole set instead of one member looks correct
// in its own test and silently disarms the gate; the gate holding correctly
// looks correct in its own test and is useless if the evidence was destroyed
// first.
//
// ── Two properties this file exists for, above the happy path ─────────────
//   1. ORDER-INDEPENDENCE. It is natural to write the gate imagining the
//      branches merge in the order they were stamped, and nothing enforces
//      that — the second half of a two-repository card frequently lands FIRST
//      because it is smaller. A gate that reads "the one that just merged"
//      correctly and "the rest" only in one direction passes every test written
//      from the happy path.
//   2. WHICH gate reports. Four gates that each work alone can still name the
//      wrong one, and the outcome is what a human reads: a stranded merge
//      reported as an incomplete delivery set sends the reader looking for a
//      branch that is not the problem.
//
// Every assertion reads the card's STATUS **and** the sync's OUTCOME. The two
// came apart in the incident this story exists for, so asserting either alone
// would miss exactly that.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-delivery-story';
const CORE_REPO_ID = '9101';
const AI_REPO_ID = '9102';

async function makeScenario(email: string) {
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
    repos: [
      {
        providerRepoId: CORE_REPO_ID,
        owner: 'moooon',
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
      // ⚠️ A DIFFERENT trunk. A gate that compared against a hard-coded `main`
      // would call this repository's merge stranded, and the story would pass
      // in a tree where the product was wrong.
      {
        providerRepoId: AI_REPO_ID,
        owner: 'moooon',
        name: 'motir-ai',
        defaultBranch: 'trunk',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

function prPayload(opts: {
  action: string;
  repoProviderId: string;
  number: number;
  headRef: string;
  baseRef: string;
  state?: 'open' | 'closed';
  merged?: boolean;
}) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(opts.repoProviderId) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      merged_at: opts.merged ? '2026-08-27T10:00:00.000Z' : null,
      // ⚠️ The title names NOTHING. The link is explicit, and a story that let
      // the title carry it would be asserting the mechanism this replaces.
      title: 'Some change',
      head: { ref: opts.headRef },
      base: { ref: opts.baseRef },
      user: { id: 4242 },
    },
  };
}

const pr = (payload: ReturnType<typeof prPayload>) =>
  githubWebhookService.handleEvent('pull_request', payload);

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function commentCount(workItemId: string): Promise<number> {
  return adminDb.comment.count({ where: { workItemId } });
}

async function deliveryCount(workItemId: string): Promise<number> {
  return adminDb.workItemDelivery.count({ where: { workItemId } });
}

/** A card at `implemented`, with `count` pull requests OPEN and LINKED to it. */
async function cardWithDeliveries(
  s: Awaited<ReturnType<typeof makeScenario>>,
  title: string,
  members: { repoProviderId: string; number: number; baseRef: string }[],
) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const m of members) {
    await pr(
      prPayload({
        action: 'opened',
        repoProviderId: m.repoProviderId,
        number: m.number,
        headRef: `subtask/${item.identifier}-part-${m.number}`,
        baseRef: m.baseRef,
      }),
    );
    const repoName = m.repoProviderId === CORE_REPO_ID ? 'motir-core' : 'motir-ai';
    // The EXPLICIT link — `link_pull_request`'s own service door, called once per
    // pull request, which is exactly what a run does per iteration.
    await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: item.id,
        projectId: s.project.id,
        owner: 'moooon',
        name: repoName,
        number: m.number,
        headRef: `subtask/${item.identifier}-part-${m.number}`,
        baseRef: m.baseRef,
        title: null,
      },
      s.ctx,
    );
  }
  if ((await statusOf(item.id)) !== 'implemented') {
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
  }
  return item;
}

function mergeOf(
  item: { identifier: string },
  m: { repoProviderId: string; number: number; baseRef: string },
) {
  return prPayload({
    action: 'closed',
    repoProviderId: m.repoProviderId,
    number: m.number,
    headRef: `subtask/${item.identifier}-part-${m.number}`,
    baseRef: m.baseRef,
    state: 'closed',
    merged: true,
  });
}

const CORE = { repoProviderId: CORE_REPO_ID, number: 101, baseRef: 'main' };
const AI = { repoProviderId: AI_REPO_ID, number: 202, baseRef: 'trunk' };

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a card delivered by TWO branches closes on the SECOND merge', () => {
  it('holds on the first merge, naming what is outstanding, and closes on the second', async () => {
    const s = await makeScenario('story-two@example.com');
    const card = await cardWithDeliveries(s, 'spans two repositories', [CORE, AI]);
    expect(await deliveryCount(card.id)).toBe(2);
    expect(await statusOf(card.id)).toBe('implemented');

    // ── merge A ─────────────────────────────────────────────────────────────
    const first = await pr(mergeOf(card, CORE));

    expect(first).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    // ⚠️ STATUS *and* outcome. The two came apart in the incident this story is
    // about, so an assertion on either alone would not have caught it.
    expect(await statusOf(card.id)).toBe('implemented');
    // ONE comment, naming the branch that is still outstanding.
    expect(await commentCount(card.id)).toBe(1);
    const held = await adminDb.comment.findFirstOrThrow({ where: { workItemId: card.id } });
    expect(held.bodyMd).toContain('moooon/motir-ai#202');

    // ── merge B ─────────────────────────────────────────────────────────────
    const second = await pr(mergeOf(card, AI));

    expect(second).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(card.id)).toBe('done');
  });

  it('ends IDENTICALLY when the branches merge in the OTHER order', async () => {
    // The property most likely to find something: the smaller half of a
    // two-repository card frequently lands first, and nothing enforces the
    // order the author imagined.
    const s = await makeScenario('story-reverse@example.com');
    const card = await cardWithDeliveries(s, 'the small half lands first', [CORE, AI]);

    const first = await pr(mergeOf(card, AI));
    expect(first).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect(await statusOf(card.id)).toBe('implemented');
    const held = await adminDb.comment.findFirstOrThrow({ where: { workItemId: card.id } });
    // …and the comment names the OTHER one, which is the half a one-directional
    // gate gets wrong while still passing the happy-path test.
    expect(held.bodyMd).toContain('moooon/motir-core#101');

    const second = await pr(mergeOf(card, CORE));
    expect(second).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(card.id)).toBe('done');
  });

  it('a REDELIVERY of the first merge adds no second comment and moves nothing', async () => {
    // GitHub redelivers, and a webhook that spoke twice about one event would
    // put two identical notes on a card a person is trying to read.
    const s = await makeScenario('story-redeliver@example.com');
    const card = await cardWithDeliveries(s, 'redelivered', [CORE, AI]);

    await pr(mergeOf(card, CORE));
    expect(await commentCount(card.id)).toBe(1);

    const again = await pr(mergeOf(card, CORE));

    expect(again).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect(await statusOf(card.id)).toBe('implemented');
    expect(await commentCount(card.id)).toBe(1);
  });
});

describe('the cases that must be UNPERTURBED — nearly every card in the tree', () => {
  it('a SINGLE-delivery card closes on its one merge, exactly as before', async () => {
    // Deliberately in the SAME file as the feature: the regression sits beside
    // the thing that could cause it.
    const s = await makeScenario('story-single@example.com');
    const card = await cardWithDeliveries(s, 'the ordinary card', [CORE]);
    expect(await deliveryCount(card.id)).toBe(1);

    const merged = await pr(mergeOf(card, CORE));

    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(card.id)).toBe('done');
    // No hold, so no note.
    expect(await commentCount(card.id)).toBe(0);
  });

  it('a ZERO-delivery pull request moves NOTHING — the legacy column associates no card (MOTIR-3721)', async () => {
    // ⚠️ THIS ASSERTION IS INVERTED FROM THE ONE IT REPLACES, deliberately and on
    // the record. It used to read *"a ZERO-delivery card closes on the merge that
    // names it, with no delivery row involved"* — true while the sync resolved its
    // card from `github_pull_request.work_item_id`. MOTIR-3721 moves that reader
    // onto `work_item_delivery`, so the column associates nothing and a pull
    // request carrying only it resolves NO card at all.
    //
    // ⚠️ AND THE STATE IS UNREACHABLE ON A MIGRATED DATABASE, which is why the
    // change is safe rather than a lost link: `work_item_delivery`'s migration
    // carried EVERY non-null `work_item_id` into a delivery row (pass 1), and
    // every live writer since (`link_pull_request`, `mark_integrated`) writes
    // both halves. What is left is the corrupt pairing the backfill's own guard
    // declined — a pull request whose repository belongs to a different workspace
    // than the card it names — and failing CLOSED there is the correct direction.
    const s = await makeScenario('story-zero@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'linked the old way' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await pr(
      prPayload({
        action: 'opened',
        repoProviderId: CORE_REPO_ID,
        number: 303,
        headRef: `subtask/${item.identifier}-legacy`,
        baseRef: 'main',
      }),
    );
    // The LEGACY column alone — no delivery row.
    await adminDb.githubPullRequest.updateMany({
      where: { number: 303 },
      data: { workItemId: item.id },
    });
    if ((await statusOf(item.id)) !== 'implemented') {
      await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    }
    expect(await deliveryCount(item.id)).toBe(0);

    const merged = await pr(
      prPayload({
        action: 'closed',
        repoProviderId: CORE_REPO_ID,
        number: 303,
        headRef: `subtask/${item.identifier}-legacy`,
        baseRef: 'main',
        state: 'closed',
        merged: true,
      }),
    );

    expect(merged).toMatchObject({ outcome: 'no_work_item' });
    expect(await statusOf(item.id)).toBe('implemented');
    // And the column is left exactly as it stands: the sync stopped reading it,
    // it did not start clearing it (AC 7 — nothing is dropped by this card).
    const after = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 303 } });
    expect(after.workItemId).toBe(item.id);
  });
});

describe('the four gates do not SHADOW each other', () => {
  it('a merge onto a NON-default base reports the stranded gate, not the delivery-set one', async () => {
    // Which outcome a held card gets is what a human reads. If a stranded merge
    // reported as an incomplete delivery set, the reader would go looking for a
    // branch that is not the problem — and both statements are true here, so
    // the ORDER the decision card fixed is what decides which is reported.
    const s = await makeScenario('story-stranded@example.com');
    const card = await cardWithDeliveries(s, 'one landed off-trunk', [
      { ...CORE, baseRef: 'release/1.4' },
      AI,
    ]);

    const merged = await pr(mergeOf(card, { ...CORE, baseRef: 'release/1.4' }));

    expect(merged).toMatchObject({ outcome: 'deferred_non_default_base' });
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('holds on the delivery set when the OTHER member is merely open', async () => {
    // The control for the case above: same shape, a base that IS the trunk, so
    // the stranded gate abstains and this one reports.
    const s = await makeScenario('story-control@example.com');
    const card = await cardWithDeliveries(s, 'both target their trunk', [CORE, AI]);

    const merged = await pr(mergeOf(card, CORE));

    expect(merged).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect(await statusOf(card.id)).toBe('implemented');
  });
});
