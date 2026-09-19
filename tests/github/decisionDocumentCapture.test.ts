import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { PullRequestFiles } from '@/lib/github/pullRequestFiles';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { captureDecisionDocument } from '@/lib/services/decisionDocumentCaptureService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPr } from '../helpers/prLink';

// THE DECISION-DOCUMENT CAPTURE (Story MOTIR-4907 · Subtask MOTIR-5674; ADR
// `approval-gates.md` §8's FIFTH AMENDMENT, clause 7). Real Postgres; the host is
// stubbed at the two seams the capture calls — the installation-token mint and
// `listPullRequestFiles` — so what these tests assert is the ROW the capture
// writes, never the fetch.
//
// ⚠️ THE ASSERTION THAT MATTERS MOST is the one about who gets NOTHING: a code
// card's pull request, and a `human` decision card's, must never gain these
// columns or cost a host call.

const listFiles = vi.hoisted(() => vi.fn<() => Promise<PullRequestFiles>>());
vi.mock('@/lib/github/pullRequestFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/pullRequestFiles')>()),
  listPullRequestFiles: listFiles,
}));

const INSTALLATION_ID = 'inst-decision-capture';
const REPO_PROVIDER_ID = '5674';
const HEAD = '7a9e0c1d2b3f4a5e6d7c8b9a0f1e2d3c4b5a6978';

function files(rows: { path: string; sha?: string; status?: string }[], truncated = false) {
  return {
    paths: rows.map((row) => row.path),
    truncated,
    files: rows.map((row) => ({
      path: row.path,
      sha: row.sha ?? null,
      status: row.status ?? 'added',
    })),
    headSha: HEAD,
  };
}

let seq = 0;

async function makeScenario(card: {
  type: 'decision' | 'code';
  executor: 'coding_agent' | 'human';
}) {
  seq += 1;
  const user = await usersService.createUser({
    email: `capture-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
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
  const item = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'task',
      title: 'Decide the page model',
      type: card.type,
      executor: card.executor,
    },
    ctx,
  );
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon-B-V',
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { project, item, ctx };
}

/** Link pull request #`number` to the scenario's card, the way a run does. */
async function link(s: Awaited<ReturnType<typeof makeScenario>>, number = 21) {
  await linkPr(
    {
      workItemId: s.item.id,
      projectId: s.project.id,
      owner: 'moooon-B-V',
      name: 'motir-core',
      number,
      headRef: 'docs/MOTIR-1-page-model',
    },
    s.ctx,
  );
  return adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
}

const captured = (id: string) =>
  adminDb.githubPullRequest.findUniqueOrThrow({
    where: { id },
    select: {
      decisionDocOutcome: true,
      decisionDocPath: true,
      decisionDocBlobSha: true,
      decisionDocHeadSha: true,
      changedPaths: true,
      changedPathsTruncated: true,
    },
  });

function prPayload(action: string, number = 21) {
  return {
    action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon-B-V', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      merged_at: null,
      title: 'Decide the page model',
      head: { ref: 'docs/MOTIR-1-page-model', sha: HEAD },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  listFiles.mockReset();
  vi.spyOn(getGitProvider('github'), 'mintInstallationToken').mockResolvedValue({
    token: 'ghs_decision',
    expiresAt: new Date(Date.now() + 3_600_000),
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a decision card’s head — the four outcomes', () => {
  it('ONE document: the outcome, its path, its blob sha and the head are written together', async () => {
    const s = await makeScenario({ type: 'decision', executor: 'coding_agent' });
    listFiles.mockResolvedValue(
      files([
        { path: 'docs/decisions/pages.md', sha: 'blob-pages' },
        { path: 'lib/pages/model.ts', sha: 'blob-code', status: 'modified' },
      ]),
    );
    const pr = await link(s);

    expect(await captured(pr.id)).toMatchObject({
      decisionDocOutcome: 'one',
      decisionDocPath: 'docs/decisions/pages.md',
      decisionDocBlobSha: 'blob-pages',
      decisionDocHeadSha: HEAD,
    });
  });

  it('NONE: a pull request with no decision document says so, with no path or sha', async () => {
    const s = await makeScenario({ type: 'decision', executor: 'coding_agent' });
    listFiles.mockResolvedValue(files([{ path: 'README.md', sha: 'blob-readme' }]));
    const pr = await link(s);

    expect(await captured(pr.id)).toMatchObject({
      decisionDocOutcome: 'none',
      decisionDocPath: null,
      decisionDocBlobSha: null,
      decisionDocHeadSha: HEAD,
    });
  });

  it('SEVERAL: two documents are not one, and neither is written as THE document', async () => {
    const s = await makeScenario({ type: 'decision', executor: 'coding_agent' });
    listFiles.mockResolvedValue(
      files([
        { path: 'docs/decisions/pages.md', sha: 'blob-1' },
        { path: 'docs/decisions/pages-storage.md', sha: 'blob-2', status: 'modified' },
      ]),
    );
    const pr = await link(s);

    expect(await captured(pr.id)).toMatchObject({
      decisionDocOutcome: 'several',
      decisionDocPath: null,
      decisionDocBlobSha: null,
    });
  });

  it('UNREADABLE: a host error writes `unreadable` — never `none` — and the link still stands', async () => {
    const s = await makeScenario({ type: 'decision', executor: 'coding_agent' });
    listFiles.mockRejectedValue(new Error('GitHub is down'));
    const pr = await link(s);

    expect(await captured(pr.id)).toMatchObject({
      decisionDocOutcome: 'unreadable',
      decisionDocPath: null,
      decisionDocHeadSha: null,
    });
    expect(await adminDb.workItemDelivery.count({ where: { githubPullRequestId: pr.id } })).toBe(1);
  });
});

describe('who gets NOTHING', () => {
  it('a CODE card’s pull request gains no capture and costs no host call', async () => {
    const s = await makeScenario({ type: 'code', executor: 'coding_agent' });
    const pr = await link(s);

    expect((await captured(pr.id)).decisionDocOutcome).toBeNull();
    expect(listFiles).not.toHaveBeenCalled();
    expect(await captureDecisionDocument(pr.id)).toEqual({ outcome: 'not_a_decision' });
  });

  it('a HUMAN decision card is a choice, not this gate — nothing is captured', async () => {
    const s = await makeScenario({ type: 'decision', executor: 'human' });
    const pr = await link(s);

    expect((await captured(pr.id)).decisionDocOutcome).toBeNull();
    expect(listFiles).not.toHaveBeenCalled();
  });

  it('a pull request that no longer exists is `gone`, and nothing throws', async () => {
    expect(await captureDecisionDocument('no-such-pull-request')).toEqual({ outcome: 'gone' });
  });
});

describe('the moments that capture', () => {
  it('a SYNCHRONIZE re-reads the head: a changed document replaces the capture', async () => {
    const s = await makeScenario({ type: 'decision', executor: 'coding_agent' });
    listFiles.mockResolvedValue(files([{ path: 'docs/decisions/pages.md', sha: 'blob-v1' }]));
    const pr = await link(s);
    expect((await captured(pr.id)).decisionDocBlobSha).toBe('blob-v1');

    listFiles.mockResolvedValue(files([{ path: 'docs/decisions/pages.md', sha: 'blob-v2' }]));
    const result = await githubWebhookService.handlePullRequest(prPayload('synchronize'));

    // `synchronize` stays out of the status machine; the capture rides above it.
    expect(result).toEqual({ event: 'pull_request', outcome: 'ignored_action' });
    expect((await captured(pr.id)).decisionDocBlobSha).toBe('blob-v2');
  });

  it('a SYNCHRONIZE whose read fails still answers the delivery, and records `unreadable`', async () => {
    const s = await makeScenario({ type: 'decision', executor: 'coding_agent' });
    listFiles.mockResolvedValue(files([{ path: 'docs/decisions/pages.md', sha: 'blob-v1' }]));
    const pr = await link(s);

    listFiles.mockRejectedValue(new Error('rate limited'));
    await expect(githubWebhookService.handlePullRequest(prPayload('synchronize'))).resolves.toEqual(
      {
        event: 'pull_request',
        outcome: 'ignored_action',
      },
    );
    expect((await captured(pr.id)).decisionDocOutcome).toBe('unreadable');
  });

  it('a REOPENED delivery captures, and the merge-time `changedPaths` are left as they were', async () => {
    const s = await makeScenario({ type: 'decision', executor: 'coding_agent' });
    listFiles.mockResolvedValue(files([{ path: 'docs/decisions/pages.md', sha: 'blob-v1' }]));
    const pr = await link(s);
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { decisionDocOutcome: null, decisionDocPath: null, decisionDocBlobSha: null },
    });

    await githubWebhookService.handlePullRequest(prPayload('reopened'));

    const row = await captured(pr.id);
    expect(row.decisionDocOutcome).toBe('one');
    // The open-time path capture (MOTIR-3230) writes `changedPaths` from the same
    // list, exactly as it always has — the decision columns are a separate fact.
    expect(row.changedPaths).toEqual(['docs/decisions/pages.md']);
    expect(row.changedPathsTruncated).toBe(false);
  });

  it('a pull request OPENED before its link is captured by the LINK', async () => {
    const s = await makeScenario({ type: 'decision', executor: 'coding_agent' });
    listFiles.mockResolvedValue(files([{ path: 'docs/decisions/pages.md', sha: 'blob-v1' }]));

    // The delivery arrives first and finds no decision card to capture for.
    await githubWebhookService.handlePullRequest(prPayload('opened'));
    const before = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 21 } });
    expect((await captured(before.id)).decisionDocOutcome).toBeNull();

    // The run links it seconds later — and that is the capture.
    const pr = await link(s);
    expect((await captured(pr.id)).decisionDocOutcome).toBe('one');
  });
});

describe('the arms a webhook cannot stage', () => {
  it('a pull request on a provider this build cannot list is `unreadable`, with no host call', async () => {
    const s = await makeScenario({ type: 'decision', executor: 'coding_agent' });
    listFiles.mockResolvedValue(files([{ path: 'docs/decisions/pages.md', sha: 'blob-v1' }]));
    const pr = await link(s);
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { provider: 'gitlab' } });
    listFiles.mockClear();

    expect(await captureDecisionDocument(pr.id)).toEqual({ outcome: 'unreadable' });
    expect(listFiles).not.toHaveBeenCalled();
    expect((await captured(pr.id)).decisionDocOutcome).toBe('unreadable');
  });

  it('a failure of the capture itself is swallowed and reported as `failed`', async () => {
    const s = await makeScenario({ type: 'decision', executor: 'coding_agent' });
    listFiles.mockResolvedValue(files([{ path: 'docs/decisions/pages.md', sha: 'blob-v1' }]));
    const pr = await link(s);
    const { githubPullRequestRepository } =
      await import('@/lib/repositories/githubPullRequestRepository');
    vi.spyOn(githubPullRequestRepository, 'recordDecisionDocCapture').mockRejectedValue(
      new Error('the row lock timed out'),
    );

    expect(await captureDecisionDocument(pr.id)).toEqual({ outcome: 'failed' });
  });
});
