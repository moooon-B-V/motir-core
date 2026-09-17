import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { makeWorkWaitOn } from '@/tests/helpers/designWaits';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// TWO GATES ON ONE CARD, THE DESIGN ONE PRIMARY (Story MOTIR-5652 · Subtask
// MOTIR-5662; `docs/decisions/design-result.md` AMENDMENT 6 Q1), against a REAL
// Postgres through the real webhook and publish doors.
//
// ⚠️ THIS IS THE DEFECT ITSELF, DRIVEN. Before this card a design card with a
// published result and an open pull request held NO question at all: CI green,
// card In Review, pull request clean, mock rendered, and nothing to press. Two
// independently-reasoned suppressions produced it and neither author could see
// the hole from their own card — the design gate was suppressed because the merge
// gate would carry the decision (AMENDMENT 4 Q8 / MOTIR-5534), and the merge gate
// then refused because the card was not the run target.
//
// Both refusals come out together, and they had to: each was safe only while the
// other fired.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-two-gates';
const REPO_PROVIDER_ID = '881';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

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
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

const ci = (opts: {
  conclusion: string | null;
  headSha: string;
  number: number;
  status?: string;
}) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: opts.headSha,
      head_branch: null,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      app: { slug: 'github-actions' },
      pull_requests: [{ number: opts.number }],
    },
  });

async function openLinked(identifier: string, number: number) {
  const headRef = `design/${identifier}-${number}`;
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A design (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

/** A design card with an open delivering pull request, mid-run. */
async function designCard(s: Scenario, title = 'Draw the frame') {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  await makeWorkWaitOn(item.id, { projectId: s.project.id, ctx: s.ctx });
  return item;
}

async function publish(s: Scenario, itemId: string, label: string) {
  const prefix = designPrefix(s.workspace.id, itemId);
  store.set(`${prefix}${label}.mock.html`, { contentType: 'text/html', size: 2048 });
  store.set(`${prefix}${label}.design-notes.md`, { contentType: 'text/markdown', size: 512 });
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: itemId,
      assets: [
        {
          kind: 'mock',
          sourcePath: `design/work-items/${label}.mock.html`,
          pathname: `${prefix}${label}.mock.html`,
        },
        {
          kind: 'note_file',
          sourcePath: 'design/work-items/design-notes.md',
          pathname: `${prefix}${label}.design-notes.md`,
        },
      ],
      commitSha: shaFor(label),
    },
    s.ctx,
  );
}

const gatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

const awaitingKinds = async (workItemId: string) =>
  (await gatesOf(workItemId)).filter((g) => g.state === 'awaiting').map((g) => g.kind);

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  _resetInstallationTokenCache();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('MOTIR-5652 — a design result AND an open pull request is TWO questions', () => {
  it('publishing onto a card with an OPEN pull request raises the design gate', async () => {
    const s = await makeScenario('tg-publish@example.com');
    const item = await designCard(s);
    await openLinked(item.identifier, 21);

    const evidence = await publish(s, item.id, 'v1');

    // The assertion that was FALSE before this card: the suppression returned the
    // evidence and raised nothing at all.
    expect(await awaitingKinds(item.id)).toEqual(['design_result']);
    expect((await gatesOf(item.id))[0]).toMatchObject({
      subjectId: evidence.id,
      subjectVersion: shaFor('v1'),
    });
  });

  it('and once the set goes green the card holds BOTH — design first, merge beside it', async () => {
    const s = await makeScenario('tg-both@example.com');
    const item = await designCard(s);
    await openLinked(item.identifier, 22);
    await publish(s, item.id, 'v1');

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 22 });

    // TWO gates, of two kinds, with two different subjects: the design gate names
    // the evidence row, the merge gate names the card and its commits.
    expect(await awaitingKinds(item.id)).toEqual(['design_result', 'pull_request_approval']);
    const [design, merge] = await gatesOf(item.id);
    expect(design!.subjectId).not.toBe(item.id);
    expect(merge!.subjectId).toBe(item.id);
    expect(merge!.subjectVersion).toBe('moooon/acme#22@sha-a');
  });

  it('LINKING a pull request to a card that already holds a design gate leaves it standing', async () => {
    // The retired `retireDesignGateForOpenPullRequest`, driven from the other side:
    // publish first, link second. A link is evidence the design gate is ABOUT.
    const s = await makeScenario('tg-link@example.com');
    const item = await designCard(s);
    await publish(s, item.id, 'v1');
    expect(await awaitingKinds(item.id)).toEqual(['design_result']);

    await openLinked(item.identifier, 23);

    expect(await awaitingKinds(item.id)).toEqual(['design_result']);
  });
});

describe('MOTIR-5603 — at most ONE merge gate, across the whole sequence', () => {
  it('publish → link → green → push → green leaves one merge gate at every point', async () => {
    const s = await makeScenario('tg-sequence@example.com');
    const item = await designCard(s);
    const mergeGates = async () =>
      (await gatesOf(item.id)).filter((g) => g.kind === 'pull_request_approval');
    const awaitingMerge = async () => (await mergeGates()).filter((g) => g.state === 'awaiting');

    await publish(s, item.id, 'v1');
    expect(await mergeGates()).toHaveLength(0);

    await openLinked(item.identifier, 24);
    expect(await mergeGates()).toHaveLength(0);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 24 });
    expect(await awaitingMerge()).toHaveLength(1);

    // A PUSH withdraws it — the commits asked about are not the commits any more.
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-b', number: 24 });
    expect(await awaitingMerge()).toHaveLength(0);

    // …and the NEXT green raises exactly one fresh gate over the new head
    // (MOTIR-5604: the withdrawal used to have no matching raiser).
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 24 });
    const live = await awaitingMerge();
    expect(live).toHaveLength(1);
    expect(live[0]!.subjectVersion).toBe('moooon/acme#24@sha-b');

    // Two rows in total across the sequence, and never two live at once — the
    // whole content of MOTIR-5603's invariant, asserted as a sequence.
    expect((await mergeGates()).map((g) => g.state)).toEqual(['superseded', 'awaiting']);

    // The design question rode through all of it untouched. It has a different
    // lifetime, which is why collapsing the two was the original error.
    const design = (await gatesOf(item.id)).filter((g) => g.kind === 'design_result');
    expect(design.map((g) => g.state)).toEqual(['awaiting']);
  });
});
