import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { truncateAuthTables } from '../helpers/db';

// Story 7.10 · MOTIR-1579 — the Development surface's READ PATH, as an
// integration SEAM test: what the webhook ingestion WRITES (PR rows + title +
// check rows, MOTIR-892/894 + this card's captures) is read BACK through the
// next consumers' DTOs — `getQuickView().pullRequests` (the peek) and
// `listLinkedPullRequests` (the detail page) — so a key/shape drift between
// writer and reader fails here, not in the browser. Real Postgres.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-dev-surface';
const REPO_PROVIDER_ID = '888';

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
      { providerRepoId: REPO_PROVIDER_ID, owner: 'moooon', name: 'acme', defaultBranch: 'main' },
    ],
  });
  return { user, workspace, project, ctx };
}

function prEvent(opts: {
  number: number;
  headBranch: string;
  title: string;
  state?: string;
  merged?: boolean;
  action?: string;
}) {
  return {
    action: opts.action ?? 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: opts.title,
      head: { ref: opts.headBranch },
      user: { id: 4242 },
    },
  };
}

function checkRunEvent(opts: {
  conclusion: string | null;
  status?: string;
  name: string;
  headSha: string;
  prNumber: number;
}) {
  return {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: opts.headSha,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      name: opts.name,
      check_suite: { head_branch: null },
      pull_requests: [{ number: opts.prNumber }],
    },
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('getQuickView().pullRequests — the Development surface read path (MOTIR-1579)', () => {
  it('an item with no linked PR reads back an empty list (the EmptyState case)', async () => {
    const s = await makeScenario('dev-empty@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Nothing linked' },
      s.ctx,
    );
    const peek = await workItemsService.getQuickView(
      s.project.id,
      item.identifier,
      s.project.accessLevel,
      s.ctx,
      'en',
    );
    expect(peek.pullRequests).toEqual([]);
  });

  it('reads back the ingested PR display-ready: captured title, repo meta, state, per-PR CI, URL', async () => {
    const s = await makeScenario('dev-populated@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A tracked change' },
      s.ctx,
    );
    // Ingest an OPEN PR whose branch names the item (the auto-resolver link),
    // then a pending + a success check at the same head sha → 'running' wins.
    await githubWebhookService.handleEvent(
      'pull_request',
      prEvent({
        number: 41,
        headBranch: `feat/${item.identifier}-work`,
        title: 'Throttle burst traffic',
      }),
    );
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunEvent({ conclusion: 'success', name: 'lint', headSha: 'sha1', prNumber: 41 }),
    );
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunEvent({
        conclusion: null,
        status: 'in_progress',
        name: 'build',
        headSha: 'sha1',
        prNumber: 41,
      }),
    );

    const peek = await workItemsService.getQuickView(
      s.project.id,
      item.identifier,
      s.project.accessLevel,
      s.ctx,
      'en',
    );
    expect(peek.pullRequests).toEqual([
      {
        title: 'Throttle burst traffic',
        repo: 'moooon/acme',
        number: 41,
        state: 'open',
        ci: 'running',
        url: 'https://github.com/moooon/acme/pull/41',
      },
    ]);

    // The detail page's read (same service method) returns the identical shape.
    const itemRow = await db.workItem.findFirst({ where: { title: 'A tracked change' } });
    const detailPrs = await workItemsService.listLinkedPullRequests(itemRow!.id);
    expect(detailPrs).toEqual(peek.pullRequests);
  });

  it('a merged PR reads back state "merged", and a pre-capture row (null title) falls back to its head branch', async () => {
    const s = await makeScenario('dev-merged@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A merged change' },
      s.ctx,
    );
    await githubWebhookService.handleEvent(
      'pull_request',
      prEvent({
        number: 7,
        headBranch: `feat/${item.identifier}-done`,
        title: 'Ship it',
        action: 'closed',
        state: 'closed',
        merged: true,
      }),
    );
    // Simulate a row ingested BEFORE title capture (MOTIR-892-era data).
    await db.githubPullRequest.updateMany({ where: { number: 7 }, data: { title: null } });

    const peek = await workItemsService.getQuickView(
      s.project.id,
      item.identifier,
      s.project.accessLevel,
      s.ctx,
      'en',
    );
    expect(peek.pullRequests).toEqual([
      {
        title: `feat/${item.identifier}-done`, // headRef fallback
        repo: 'moooon/acme',
        number: 7,
        state: 'merged',
        ci: null, // no check rows → no CI pill
        url: 'https://github.com/moooon/acme/pull/7',
      },
    ]);
  });
});
