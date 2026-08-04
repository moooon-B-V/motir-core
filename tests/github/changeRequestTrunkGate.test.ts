import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-1873 — THE TRUNK GATE. A merge only completes a work item when it landed
// on the repository's DEFAULT branch. `merged: true` answers "did a merge event
// occur?"; the card's Done means "did this work reach the trunk?", and the two
// diverge whenever a change request's base is not the default branch — a PR STACKED
// on a sibling's branch is the ordinary way that happens (`notes.html` #174:
// MOTIR-1845 sat at Done with zero of its 665 lines on `main`).
//
// Real Postgres, the real webhook service, the real provider seam — no mocks (the
// motir-core convention). Covers: the default-branch merge still completing
// (regression guard), the non-default merge HOLDING at In Review with the reason
// on the item, a repo whose default is `master` behaving identically (the branch
// name is read from the MIRRORED row, never hard-coded), the real #1687/#1688
// payload shapes replayed against each other, and redelivery idempotency.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-trunk';
const REPO_PROVIDER_ID = '9101';

/** A workspace + project + a work item already `in_review` (its PR is open), plus
 *  a mirrored installation + repo whose default branch is `defaultBranch`. */
async function makeScenario(email: string, defaultBranch = 'main') {
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
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'A tracked change' },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch,
        archived: false,
      },
    ],
  });
  return { user, workspace, project, item, ctx };
}

/** A `pull_request` delivery. `baseRef` is the field under test — the branch the PR
 *  merges INTO. */
function prPayload(opts: {
  action: string;
  identifier: string;
  baseRef: string;
  number?: number;
  state?: 'open' | 'closed';
  merged?: boolean;
}) {
  return {
    action: opts.action,
    installation: {
      id: INSTALLATION_ID,
      account: { login: 'moooon', type: 'Organization' },
    },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number ?? 1688,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: `Some change (${opts.identifier})`,
      head: { ref: `subtask/${opts.identifier}-a-change` },
      base: { ref: opts.baseRef },
      user: { id: 4242 },
    },
  };
}

/** Open the PR (so the item sits at In Review, as it does in reality) and then
 *  merge it into `baseRef`. Returns the merge delivery's result. */
async function openThenMergeInto(identifier: string, baseRef: string, number = 1688) {
  const opened = await githubWebhookService.handleEvent(
    'pull_request',
    prPayload({ action: 'opened', identifier, baseRef, number }),
  );
  expect(opened).toMatchObject({ outcome: 'transitioned', toStatus: 'in_review' });
  return githubWebhookService.handleEvent(
    'pull_request',
    prPayload({ action: 'closed', identifier, baseRef, number, state: 'closed', merged: true }),
  );
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await db.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

async function commentsOn(workItemId: string) {
  return db.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });
}

/** The status hops recorded on the append-only revision trail, oldest first. Their
 *  presence is the proof a transition went through `workItemsService` (a raw
 *  `workflow_status` write leaves no revision); the ABSENCE of a `done` hop is the
 *  proof the gate held rather than transitioning and transitioning back. */
async function statusHops(workItemId: string): Promise<string[]> {
  const rows = await db.workItemRevision.findMany({
    where: { workItemId },
    orderBy: { changedAt: 'asc' },
  });
  return rows
    .map((r) => (r.diff as { status?: { to?: string } } | null)?.status?.to)
    .filter((to): to is string => typeof to === 'string');
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the trunk gate — a merge completes an item only on the default branch', () => {
  it('merged into the DEFAULT branch → Done (today’s behaviour, regression-guarded)', async () => {
    const s = await makeScenario('trunk-default@example.com');

    const merged = await openThenMergeInto(s.item.identifier, 'main');

    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
    // No stranded-merge note on the happy path — the gate is silent when it passes.
    expect(await commentsOn(s.item.id)).toHaveLength(0);
  });

  it('merged into a NON-default branch → held at In Review, never Done, with the base ref on the item', async () => {
    const s = await makeScenario('trunk-stacked@example.com');

    const merged = await openThenMergeInto(s.item.identifier, 'subtask/ACME-9-sibling-work');

    expect(merged).toMatchObject({
      event: 'pull_request',
      outcome: 'deferred_non_default_base',
      workItemId: s.item.id,
    });
    expect(await statusOf(s.item.id)).toBe('in_review');

    // The reason lands on the item, naming the base that swallowed the merge — the
    // one fact that turns "why is this still In Review?" into a one-minute answer.
    const comments = await commentsOn(s.item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('subtask/ACME-9-sibling-work');
    expect(comments[0]!.bodyMd).toContain('main'); // the trunk it needed to reach
    expect(comments[0]!.bodyMd).toContain('Done'); // …and that it did NOT get there
    expect(comments[0]!.bodyMd).toContain('pull request'); // GitHub's noun

    // The PR row still records the truth about the merge itself — the gate changes
    // what the CARD says, never what the change request did.
    const prRow = await db.githubPullRequest.findFirst({ where: { number: 1688 } });
    expect(prRow).toMatchObject({ state: 'closed', merged: true, workItemId: s.item.id });

    // The item never reached `done` at all — not even briefly. The trail ends at
    // the PR-opened hop, and every hop on it came from `workItemsService` (a raw
    // `workflow_status` write would leave no revision to read).
    const hops = await statusHops(s.item.id);
    expect(hops).not.toContain('done');
    expect(hops.at(-1)).toBe('in_review');
  });

  it('reads the default branch from the MIRRORED repo row — a `master` repo behaves identically', async () => {
    const s = await makeScenario('trunk-master@example.com', 'master');

    // `master` IS this repo's trunk → completes, even though it is not "main".
    const onMaster = await openThenMergeInto(s.item.identifier, 'master', 3001);
    expect(onMaster).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
    expect(await commentsOn(s.item.id)).toHaveLength(0);

    // …and `main` is just another branch here, so a merge onto it does NOT complete.
    const s2 = await makeScenario('trunk-master2@example.com', 'master');
    const onMain = await openThenMergeInto(s2.item.identifier, 'main', 3002);
    expect(onMain).toMatchObject({ outcome: 'deferred_non_default_base' });
    expect(await statusOf(s2.item.id)).toBe('in_review');
    expect((await commentsOn(s2.item.id))[0]!.bodyMd).toContain('master');
  });

  it('replays the real MOTIR-1845 incident — #1688’s stacked base holds, #1687’s `main` completes', async () => {
    // The stranded PR: base `subtask/MOTIR-1848-show-wave-view`, a sibling branch
    // that had been squash-merged nine minutes earlier and was already dead.
    const stranded = await makeScenario('trunk-1688@example.com');
    const strandedResult = await openThenMergeInto(
      stranded.item.identifier,
      'subtask/MOTIR-1848-show-wave-view',
      1688,
    );
    expect(strandedResult).toMatchObject({ outcome: 'deferred_non_default_base' });
    expect(await statusOf(stranded.item.id)).toBe('in_review');

    // The umbrella PR that DID reach the trunk, same day, same repo shape.
    const landed = await makeScenario('trunk-1687@example.com');
    const landedResult = await openThenMergeInto(landed.item.identifier, 'main', 1687);
    expect(landedResult).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(landed.item.id)).toBe('done');
  });

  it('is idempotent under redelivery — the hold repeats, the note does not', async () => {
    const s = await makeScenario('trunk-redeliver@example.com');
    const payload = prPayload({
      action: 'closed',
      identifier: s.item.identifier,
      baseRef: 'subtask/ACME-9-sibling-work',
      state: 'closed',
      merged: true,
    });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'opened',
        identifier: s.item.identifier,
        baseRef: 'subtask/ACME-9-sibling-work',
      }),
    );
    const first = await githubWebhookService.handleEvent('pull_request', payload);
    const second = await githubWebhookService.handleEvent('pull_request', payload);
    const third = await githubWebhookService.handleEvent('pull_request', payload);

    for (const r of [first, second, third]) {
      expect(r).toMatchObject({ outcome: 'deferred_non_default_base' });
    }
    expect(await statusOf(s.item.id)).toBe('in_review');
    // A redelivery describes the SAME merge event — one note, not three.
    expect(await commentsOn(s.item.id)).toHaveLength(1);
  });

  it('holds even when the item has another open linked PR — the trunk gate is the stronger statement', async () => {
    // MOTIR-1604's gate would also hold this item; the trunk gate answers first and
    // says why, because "no path to the trunk" is not partial completion, it is none.
    const s = await makeScenario('trunk-vs-1604@example.com');
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, baseRef: 'main', number: 4001 }),
    );
    const merged = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        baseRef: 'subtask/ACME-9-sibling-work',
        number: 4002,
        state: 'closed',
        merged: true,
      }),
    );

    expect(merged).toMatchObject({ outcome: 'deferred_non_default_base' });
    expect(await statusOf(s.item.id)).toBe('in_review');
    expect((await commentsOn(s.item.id))[0]!.bodyMd).toContain('subtask/ACME-9-sibling-work');
  });

  it('a closed-UNMERGED PR on a non-default base is untouched by the gate (still the abandoned-work path)', async () => {
    // The gate is scoped to the merged→Done decision. Nothing else moves.
    const s = await makeScenario('trunk-unmerged@example.com');
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'opened',
        identifier: s.item.identifier,
        baseRef: 'subtask/ACME-9-sibling-work',
      }),
    );
    const closed = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        baseRef: 'subtask/ACME-9-sibling-work',
        state: 'closed',
        merged: false,
      }),
    );

    expect(closed).toMatchObject({ outcome: 'transitioned', toStatus: 'in_progress' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
    expect(await commentsOn(s.item.id)).toHaveLength(0);
  });
});
