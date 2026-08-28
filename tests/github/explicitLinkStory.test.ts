import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { LINK_CHECK_NAME } from '@/lib/services/pullRequestLinkCheckService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// STORY-LEVEL vitest for MOTIR-3672 — *a pull request belongs to a card only by an
// EXPLICIT link* (MOTIR-3677).
//
// The two code cards each test their own change. This one asserts the STORY: it
// drives real `pull_request` webhook payloads through `handlePullRequest` →
// `syncChangeRequestStatus` and asserts on THE CARD, never on a resolver's return
// value — because the defect this story exists to end was never visible in a
// return value. It was visible on a card that moved when nobody meant it to.
//
// There is no E2E half and the card says why: the behaviour lives in webhook
// handling and a GitHub-side check, there is no UI surface, and Playwright cannot
// exercise the Checks API. So this is the story's top-level test and carries the
// whole-path scenarios an E2E would otherwise hold.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-link-story';
const REPO_PROVIDER_ID = '97001';
const HEAD_SHA = 'c'.repeat(40);

interface CheckWrite {
  method: string;
  conclusion: string | null;
}

let checkWrites: CheckWrite[] = [];
let existingRunId: number | null = null;

function stubHost(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/check-runs')) {
        if (method === 'GET')
          return new Response(
            JSON.stringify({ check_runs: existingRunId === null ? [] : [{ id: existingRunId }] }),
            { status: 200 },
          );
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        checkWrites.push({ method, conclusion: (body['conclusion'] as string) ?? null });
        // Once a run exists, the next write updates it in place.
        existingRunId = existingRunId ?? 4242;
        return new Response(JSON.stringify({ id: existingRunId }), { status: 200 });
      }
      if (/\/pulls\/\d+$/.test(url))
        return new Response(JSON.stringify({ head: { sha: HEAD_SHA } }), { status: 200 });
      if (url.includes('/files')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response('{}', { status: 404 });
    }),
  );
}

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
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const repoRow = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: REPO_PROVIDER_ID },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      role: 'web',
      name: 'acme',
      seedSource: 'starter',
      state: 'connected',
      position: 'a0',
      githubRepoId: repoRow.id,
    },
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  return { user, workspace, project, ctx };
}

/** A card sitting at `in_progress`, which is where a card is when its pull
 *  request opens. */
async function card(
  s: Awaited<ReturnType<typeof makeScenario>>,
  title: string,
): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  return item;
}

function delivery(opts: {
  action: string;
  number: number;
  title: string;
  headRef?: string;
  state?: 'open' | 'closed';
  merged?: boolean;
  authorType?: string;
  baseRef?: string;
}) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      draft: false,
      title: opts.title,
      head: { ref: opts.headRef ?? 'feat/some-work', sha: HEAD_SHA },
      base: { ref: opts.baseRef ?? 'main' },
      user: { id: 4242, type: opts.authorType ?? 'User' },
      labels: [],
    },
  };
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function link(
  s: Awaited<ReturnType<typeof makeScenario>>,
  workItemId: string,
  number: number,
  headRef = 'feat/some-work',
) {
  return githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId,
      projectId: s.project.id,
      owner: 'moooon',
      name: 'acme',
      number,
      headRef,
      baseRef: 'main',
      title: 'linked by a run',
    },
    s.ctx,
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  checkWrites = [];
  existingRunId = null;
  stubHost();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a pull request belongs to a card only by an explicit link (MOTIR-3672)', () => {
  it('1 — the MIS-LINK that started this: a title MENTIONING a card moves NOTHING', async () => {
    // The MOTIR-1465 shape. The title is informative and correct English; it names
    // a card the pull request does not deliver, which is what a title naming the
    // parent, a sibling, or the bug being fixed does every day. Under the parse
    // this closed that card.
    //
    // ⚠️ THIS IS THE SCENARIO THAT FAILS ON `origin/main` (the card's AC 2). There
    // it takes the `else` arm, resolves ACME-1 out of the title, and the merge
    // transitions it to `done`.
    const s = await makeScenario('story-mislink@example.com');
    const mentioned = await card(s, 'Captured planning-mistake bugs');

    const opened = await githubWebhookService.handleEvent(
      'pull_request',
      delivery({
        action: 'opened',
        number: 101,
        title: `docs: record the rule this bug came from (${mentioned.identifier})`,
      }),
    );
    const merged = await githubWebhookService.handleEvent(
      'pull_request',
      delivery({
        action: 'closed',
        number: 101,
        title: `docs: record the rule this bug came from (${mentioned.identifier})`,
        state: 'closed',
        merged: true,
      }),
    );

    expect(opened).toMatchObject({ outcome: 'no_work_item' });
    expect(merged).toMatchObject({ outcome: 'no_work_item' });
    // The assertion that matters is on the CARD, not on a return value: the
    // defect was never visible in one.
    expect(await statusOf(mentioned.id)).toBe('in_progress');
    const row = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 101 } });
    expect(row.workItemId).toBeNull();
    expect(await adminDb.workItemDelivery.count()).toBe(0);
  });

  it('2 — the SAME pull request, LINKED, merges and moves the card', async () => {
    const s = await makeScenario('story-linked@example.com');
    const delivered = await card(s, 'The card it really delivers');

    await githubWebhookService.handleEvent(
      'pull_request',
      delivery({ action: 'opened', number: 102, title: 'docs: a change' }),
    );
    await link(s, delivered.id, 102);

    const merged = await githubWebhookService.handleEvent(
      'pull_request',
      delivery({
        action: 'closed',
        number: 102,
        title: 'docs: a change',
        state: 'closed',
        merged: true,
      }),
    );

    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(delivered.id)).toBe('done');
  });

  it('3 — linked to a DIFFERENT card than the title names: the LINK wins', async () => {
    const s = await makeScenario('story-conflict@example.com');
    const named = await card(s, 'The card the title names');
    const delivered = await card(s, 'The card the pull request delivers');

    // The title names `named`; the link says `delivered`. Under the parse the two
    // would have raced on which arm ran; there is only one arm now.
    const title = `fix: follow-up to ${named.identifier}`;
    await githubWebhookService.handleEvent(
      'pull_request',
      delivery({ action: 'opened', number: 103, title }),
    );
    await link(s, delivered.id, 103);

    await githubWebhookService.handleEvent(
      'pull_request',
      delivery({ action: 'closed', number: 103, title, state: 'closed', merged: true }),
    );

    expect(await statusOf(delivered.id)).toBe('done');
    expect(await statusOf(named.id)).toBe('in_progress');
  });

  it('4 — UNLINKED → red → linked → clear, in the order a person lives through it', async () => {
    const s = await makeScenario('story-red-green@example.com');
    const delivered = await card(s, 'A card whose run forgot to link');

    // (a) The pull request opens with no link. The card does not move, AND the
    //     absence is loud rather than silent — which is the half MOTIR-3675 adds.
    await githubWebhookService.handleEvent(
      'pull_request',
      delivery({ action: 'opened', number: 104, title: 'feat: something' }),
    );
    expect(await statusOf(delivered.id)).toBe('in_progress');
    expect(checkWrites).toEqual([{ method: 'POST', conclusion: 'failure' }]);

    // (b) The person reads the check and does what it says. No new push.
    await link(s, delivered.id, 104);
    expect(checkWrites).toEqual([
      { method: 'POST', conclusion: 'failure' },
      { method: 'PATCH', conclusion: 'success' },
    ]);

    // (c) And the merge now moves the card, which is what the red check was
    //     protecting all along.
    await githubWebhookService.handleEvent(
      'pull_request',
      delivery({
        action: 'closed',
        number: 104,
        title: 'feat: something',
        state: 'closed',
        merged: true,
      }),
    );
    expect(await statusOf(delivered.id)).toBe('done');
  });

  it('5 — an EXEMPT pull request (a bot) is left alone: no failing check, no card moved', async () => {
    const s = await makeScenario('story-bot@example.com');
    const untouched = await card(s, 'A card the bump does not deliver');

    await githubWebhookService.handleEvent(
      'pull_request',
      delivery({
        action: 'opened',
        number: 105,
        title: `chore(deps): bump acme from 1 to 2 (${untouched.identifier})`,
        authorType: 'Bot',
      }),
    );

    // No check at all — a red on every dependency bump is the noise that trains
    // people to ignore the channel, which is the failure the exemption exists to
    // prevent. "Green with no link" and "no check" are the same thing to a reader
    // of the pull request; this is the one that costs nothing.
    expect(checkWrites).toEqual([]);
    expect(await statusOf(untouched.id)).toBe('in_progress');
  });

  it('6 — REGRESSION FLOOR: an ordinary run-shaped delivery behaves as it always did', async () => {
    // A branch named `subtask/<KEY>-slug`, linked the moment the pull request was
    // opened — the shape every `motir run` produces. This is the test that catches
    // a retirement which took something else with it.
    const s = await makeScenario('story-floor@example.com');
    const item = await card(s, 'An ordinary card');
    const headRef = `subtask/${item.identifier}-an-ordinary-card`;

    await link(s, item.id, 106, headRef);
    const opened = await githubWebhookService.handleEvent(
      'pull_request',
      delivery({
        action: 'opened',
        number: 106,
        title: `feat(x): a change (${item.identifier})`,
        headRef,
      }),
    );
    expect(opened).toMatchObject({ outcome: 'transitioned', toStatus: 'implemented' });
    expect(await statusOf(item.id)).toBe('implemented');

    // Its DEFERRALS are unchanged too — a merge onto a base that is not the
    // repository's trunk still holds it, with the same outcome name.
    const stranded = await githubWebhookService.handleEvent(
      'pull_request',
      delivery({
        action: 'closed',
        number: 106,
        title: `feat(x): a change (${item.identifier})`,
        headRef,
        baseRef: 'subtask/ACME-9-sibling',
        state: 'closed',
        merged: true,
      }),
    );
    expect(stranded).toMatchObject({ outcome: 'deferred_non_default_base' });
    expect(await statusOf(item.id)).toBe('implemented');
  });

  // ⚠️ THE ORDERING A RUN ACTUALLY PRODUCES, and the one the parse used to hide.
  // `gh pr create` fires the `opened` delivery within a second; the agent's
  // `link_pull_request` call lands several seconds later. So the delivery is
  // ALWAYS the unlinked one, and before `resyncLinkedPullRequest` the card sat in
  // In Progress until the merge closed it — silently skipping Implemented, the
  // state MOTIR-2999 added to say the code is pushed and no build has spoken.
  it('7 — OPENED first, LINKED second: the link applies the sync the delivery could not', async () => {
    const s = await makeScenario('order@example.com');
    const item = await card(s, 'Opened before it was linked');

    // The delivery arrives with nothing to attribute to — correct, and the
    // story's first acceptance criterion.
    const opened = await githubWebhookService.handleEvent(
      'pull_request',
      delivery({ action: 'opened', number: 7301, title: `feat: ${item.identifier} the work` }),
    );
    expect(opened).toMatchObject({ outcome: 'no_work_item' });
    expect(await statusOf(item.id)).toBe('in_progress');

    // The link catches the card up — through the SHIPPED sync, so the status it
    // lands at is the one the delivery would have produced, not a second
    // status writer's opinion.
    await link(s, item.id, 7301);
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('7b — a linked pull request that is already MERGED is not re-derived from the link', async () => {
    const s = await makeScenario('merged-link@example.com');
    const item = await card(s, 'Attached after the fact');

    // A pull request that opened AND merged with no link — the historical shape.
    await githubWebhookService.handleEvent(
      'pull_request',
      delivery({ action: 'opened', number: 7302, title: 'feat: some other work' }),
    );
    await githubWebhookService.handleEvent(
      'pull_request',
      delivery({
        action: 'closed',
        number: 7302,
        title: 'feat: some other work',
        state: 'closed',
        merged: true,
      }),
    );

    // Linking it records the association and NOTHING else: completing a card by
    // attaching an old merged pull request is a different feature, and the
    // completion gate reads merge facts a `closed` delivery carries.
    await link(s, item.id, 7302);
    expect(await statusOf(item.id)).toBe('in_progress');
  });

  it('the check is named the way a person reads it in the GitHub UI', async () => {
    // Documented in `docs/mcp.md` by this exact string, and it is the name a
    // branch-protection rule would have to match.
    expect(LINK_CHECK_NAME).toBe('Motir / work item link');
  });
});
