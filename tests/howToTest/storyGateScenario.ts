import type { WorkItem } from '@/generated/prisma/client';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { organizationIdOf } from '../helpers/organizationOf';

// THE STORY GATE'S SCENARIO (Story MOTIR-4906 · Subtask MOTIR-5337) — a scoped
// story run as the server records it, shared by the Node half of the gate
// (`storyGate.test.ts`) and its render half (`storyGateRender.test.tsx`), so the
// DTO the render seam draws is produced by the SAME rows the write seams wrote.
//
// Two repositories, one per host, created exactly as each host's ingestion path
// resolves them — a GitHub repository behind an installation id, a GitLab project
// behind its provider id — so a delivered `deployment_status` or `deployment` hook
// lands on these rows with no extra wiring. Nothing here calls a service that
// fakes a producer: the run, its legs and its session pull requests are the rows
// the CLI and the webhooks would have left.

export const GITHUB_INSTALLATION_ID = 'inst-gate-4906';
export const WEB_PROVIDER_REPO_ID = '4906001';
export const API_GITLAB_PROJECT_ID = '4906002';

export const WEB_BRANCH = 'motir/run-20260913-120000';
export const API_BRANCH = 'motir/run-20260913-120000';
export const WEB_HEAD = 'a1'.repeat(20);
export const API_HEAD = 'b2'.repeat(20);

/**
 * The two fenced commands the render seam copies, BYTE FOR BYTE. Chosen to break
 * a copy that reads rendered text instead of the source: quotes, `$`, `&&`, `<`,
 * `&`, a tab, a non-ASCII arrow, an indented continuation line, and a line that
 * a highlighter tokenises into several spans.
 */
export const COMMAND_SETUP =
  "pnpm install --frozen-lockfile && DATABASE_URL='postgres://u:p@localhost:5433/motir' pnpm db:seed";
export const COMMAND_RUN = [
  'for f in "a b" c; do',
  '  echo "$f → <ok> & done"\t| tee -a out.txt',
  'done',
].join('\n');

/** The run's rich-text How to test: three sections, two fenced commands. */
export const RUN_BODY = [
  '## Precondition',
  '',
  'Sign in as the **workspace owner**; the story needs one project.',
  '',
  '## Locally',
  '',
  '```bash',
  COMMAND_SETUP,
  '```',
  '',
  '```sh',
  COMMAND_RUN,
  '```',
  '',
  '## Click-path',
  '',
  '1. Open the story.',
  '2. Scroll to **Development** — How to test sits under the pull requests.',
].join('\n');

export interface StoryRunScenario {
  fx: WorkItemFixture;
  story: WorkItem;
  web: WorkItem;
  api: WorkItem;
  failed: WorkItem;
  webRepo: { id: string; owner: string; name: string };
  apiRepo: { id: string; owner: string; name: string };
  runId: string;
  webPr: { id: string };
  apiPr: { id: string };
  /** A token minted with EXACTLY the grant a dispatched agent carries. */
  cliToken: string;
}

let prNumber = 100;

async function sessionPr(
  fx: WorkItemFixture,
  story: WorkItem,
  repoId: string,
  headRef: string,
  headSha: string,
  provider: 'github' | 'gitlab',
) {
  const pr = await adminDb.githubPullRequest.create({
    data: {
      provider,
      repoId,
      number: prNumber++,
      state: 'open',
      merged: false,
      headRef,
      baseRef: 'main',
      title: `Session PR ${headRef}`,
    },
  });
  await adminDb.workItemDelivery.create({
    data: { workspaceId: fx.workspaceId, workItemId: story.id, githubPullRequestId: pr.id, repoId },
  });
  await adminDb.githubCheckRun.create({
    data: { pullRequestId: pr.id, commitSha: headSha, checkName: 'Vitest', conclusion: 'success' },
  });
  return pr;
}

/** A RUNNING scoped run on `scope`, with the given legs. */
export async function openScopedRun(
  fx: WorkItemFixture,
  scope: WorkItem,
  legs: Array<{ item: WorkItem; disposition?: 'integrated' | 'failed'; branch?: string | null }>,
  startedAt = new Date('2026-09-13T12:00:00Z'),
): Promise<string> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run_scope',
      status: 'running',
      scopeWorkItemId: scope.id,
      startedAt,
      cards: {
        create: legs.map((leg, position) => ({
          workspaceId: fx.workspaceId,
          workItemId: leg.item.id,
          workItemKey: leg.item.identifier,
          position,
          ...(leg.disposition ? { disposition: leg.disposition } : {}),
          ...(leg.branch ? { sessionBranch: leg.branch } : {}),
        })),
      },
    },
  });
  return run.id;
}

export async function finishRun(runId: string): Promise<void> {
  await adminDb.dispatchRun.update({ where: { id: runId }, data: { status: 'succeeded' } });
}

export async function buildStoryRun(): Promise<StoryRunScenario> {
  const fx = await makeWorkItemFixture();
  const organizationId = await organizationIdOf(fx.workspaceId);
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Rate-limit the public API' });
  const child = (title: string) =>
    createTestWorkItem(fx, { kind: 'subtask', type: 'code', title, parentId: story.id });
  const web = await child('Web half');
  const api = await child('API half');
  const failed = await child('A leg that failed');

  // GitHub — resolved by the webhook through (installation id, provider repo id).
  const githubInstallation = await adminDb.githubInstallation.create({
    data: {
      installationId: GITHUB_INSTALLATION_ID,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const webRepo = await adminDb.githubRepo.create({
    data: {
      installationId: githubInstallation.id,
      workspaceId: fx.workspaceId,
      organizationId,
      repoId: WEB_PROVIDER_REPO_ID,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  // GitLab — resolved by the hook through (provider repo id, 'gitlab').
  const gitlabConnection = await adminDb.githubInstallation.create({
    data: {
      installationId: `gitlab-gate-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: 'acme-gl',
      accountType: 'User',
      provider: 'gitlab',
    },
  });
  const apiRepo = await adminDb.githubRepo.create({
    data: {
      installationId: gitlabConnection.id,
      workspaceId: fx.workspaceId,
      organizationId,
      repoId: API_GITLAB_PROJECT_ID,
      owner: 'acme-gl',
      name: 'api',
      defaultBranch: 'main',
      provider: 'gitlab',
    },
  });
  // Sequentially — concurrent project-repo appends race on the position key.
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: webRepo.id,
    name: 'web',
    role: 'web',
  });
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: apiRepo.id,
    name: 'api',
    role: 'api',
  });

  const runId = await openScopedRun(fx, story, [
    { item: web, disposition: 'integrated', branch: WEB_BRANCH },
    { item: failed, disposition: 'failed' },
    { item: api, disposition: 'integrated', branch: API_BRANCH },
  ]);
  const webPr = await sessionPr(fx, story, webRepo.id, WEB_BRANCH, WEB_HEAD, 'github');
  const apiPr = await sessionPr(fx, story, apiRepo.id, API_BRANCH, API_HEAD, 'gitlab');

  const { token: cliToken } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'motir run (story gate)',
    fixedGrant: [...CLI_TOKEN_GRANT],
  });

  return { fx, story, web, api, failed, webRepo, apiRepo, runId, webPr, apiPr, cliToken };
}

/** The `publish_test_instructions` arguments the close-out agent sends for this story. */
export function storyPublishArgs(s: StoryRunScenario, bodyMd = RUN_BODY) {
  return {
    key: s.story.identifier,
    bodyMd,
    previewPath: '/items/' + s.story.identifier,
    repos: [
      { repo: `${s.webRepo.owner}/${s.webRepo.name}`, commitSha: WEB_HEAD },
      { repo: `${s.apiRepo.owner}/${s.apiRepo.name}`, commitSha: API_HEAD },
    ],
  };
}
