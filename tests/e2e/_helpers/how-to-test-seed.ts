import { adminDb } from '@/tests/helpers/adminDb';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { repoDeploymentService } from '@/lib/services/repoDeploymentService';
import { dispatchRunLabel } from '@/lib/services/howToTestService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { createTestPerson } from './testPerson';

// THE STORY GATE'S E2E SEED (Story MOTIR-4906 · Subtask MOTIR-5338) — a scoped
// story run as the server records it, for the acceptance receipt
// `how-to-test.spec.ts` walks (promoted from the acceptance lane by MOTIR-5487).
//
// It mirrors `tests/howToTest/storyGateScenario.ts` (the real-Postgres scenario
// the Vitest gate uses) rather than importing it: that builder stands on the
// Vitest fixtures, and this one must sign a person in through the shipped
// sign-in, so the owner is a real account with a password and the workspace and
// project come from their services.
//
// WHAT GOES THROUGH A SERVICE, AND WHAT IS A ROW:
//   * the person, workspace, project and cards — their services;
//   * the How-to-test record — `testInstructionsService.publish`, attributed to
//     the running dispatch run, exactly the call `publish_test_instructions` lands on;
//   * the deployment — `repoDeploymentService.record`, the call both hosts'
//     deployment hooks land on;
//   * the gate — `approvalGateRepository.create`. It was seeded as a row while
//     `pull_request_approval` was unregistered; MOTIR-4909 registered it and now
//     raises it from green webhooks, but this walk asserts the FRAME, not the
//     raise, so the row stays the cheapest honest way to put one on the card.
//   * the connection, repositories, session pull requests, their deliveries and
//     check rows, and the dispatch run itself — ROWS, the ones the webhooks and
//     the CLI leave behind (the same trade `storyGateScenario.ts` states). Nothing
//     here fakes a producer the page reads through.

export const HOW_TO_TEST_PASSWORD = 'how-to-test-e2e-pass-7';

/** The two fenced commands the spec copies — compared as EXACT strings. The
 *  second carries a tab, quotes, `$`, `<`, `&` and a non-ASCII arrow, so a copy
 *  that reads the rendered text instead of the source cannot pass. */
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

export const BRANCH = 'motir/run-20260913-120000';
export const WEB_HEAD = 'a1'.repeat(20);
export const API_HEAD = 'b2'.repeat(20);
export const PREVIEW_URL = 'https://web-pr-7.preview.acme.dev';
export const RUN_STARTED = new Date('2026-09-13T12:00:00Z');
export const OWED_RUN_STARTED = new Date('2026-09-13T14:30:00Z');

export interface SeededPr {
  id: string;
  number: number;
  /** `owner/name` — the row's meta line and the sub-block's heading. */
  repo: string;
  url: string;
}

export interface HowToTestSeed {
  email: string;
  password: string;
  story: { id: string; identifier: string; title: string };
  child: { id: string; identifier: string; title: string };
  /** The second story: a session pull request and NO record. */
  owing: { id: string; identifier: string; title: string };
  webPr: SeededPr;
  apiPr: SeededPr;
  runLabel: string;
  owedRunLabel: string;
  workspaceId: string;
  projectId: string;
  ownerId: string;
}

const STORY_TITLE = 'Rate-limit the public API';
const OWING_TITLE = 'Export usage as CSV';

export async function seedHowToTest(slug: string): Promise<HowToTestSeed> {
  const email = `htt-owner-${slug}@example.com`;
  const owner = await createTestPerson({
    email,
    password: HOW_TO_TEST_PASSWORD,
    name: 'Olive Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'How to test E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Public API',
    identifier: 'PAPI',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspace.id },
    select: { organizationId: true },
  });

  const card = async (title: string, over: { kind: 'story' | 'subtask'; parentId?: string }) => {
    const item = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: over.kind,
        title,
        ...(over.parentId ? { parentId: over.parentId, type: 'code' as const } : {}),
      },
      ctx,
    );
    return { id: item.id, identifier: item.identifier, title };
  };
  const story = await card(STORY_TITLE, { kind: 'story' });
  const child = await card('Web half', { kind: 'subtask', parentId: story.id });
  const api = await card('API half', { kind: 'subtask', parentId: story.id });
  const owing = await card(OWING_TITLE, { kind: 'story' });
  const owingChild = await card('CSV writer', { kind: 'subtask', parentId: owing.id });

  // The connection and its two repositories, as the installation webhook leaves them.
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-htt-${slug}`,
      workspaceId: workspace.id,
      organizationId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = async (name: string, providerRepoId: string) => {
    const row = await adminDb.githubRepo.create({
      data: {
        installationId: installation.id,
        workspaceId: workspace.id,
        organizationId,
        repoId: providerRepoId,
        owner: 'acme',
        name,
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    // Sequentially — concurrent project-repo appends race on the position key.
    await linkProjectRepo({
      workspaceId: workspace.id,
      projectId: project.id,
      githubRepoId: row.id,
      name,
      role: name === 'web' ? 'web' : 'api',
    });
    return row;
  };
  const webRepo = await repo('web', '4906101');
  const apiRepo = await repo('api', '4906102');

  const openRun = async (
    scopeId: string,
    legs: Array<{ id: string; identifier: string }>,
    at: Date,
  ) =>
    adminDb.dispatchRun.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        command: 'run_scope',
        status: 'running',
        scopeWorkItemId: scopeId,
        startedAt: at,
        cards: {
          create: legs.map((leg, position) => ({
            workspaceId: workspace.id,
            workItemId: leg.id,
            workItemKey: leg.identifier,
            position,
            disposition: 'integrated' as const,
            sessionBranch: BRANCH,
          })),
        },
      },
    });

  let prNumber = 41;
  const sessionPr = async (
    to: { id: string },
    repoRow: { id: string; owner: string; name: string },
    headSha: string,
    title: string,
  ): Promise<SeededPr> => {
    const number = prNumber++;
    const pr = await adminDb.githubPullRequest.create({
      data: {
        provider: 'github',
        repoId: repoRow.id,
        number,
        state: 'open',
        merged: false,
        headRef: BRANCH,
        baseRef: 'main',
        title,
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: workspace.id,
        workItemId: to.id,
        githubPullRequestId: pr.id,
        repoId: repoRow.id,
      },
    });
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: headSha,
        checkName: 'Vitest',
        conclusion: 'success',
      },
    });
    const full = `${repoRow.owner}/${repoRow.name}`;
    return { id: pr.id, number, repo: full, url: `https://github.com/${full}/pull/${number}` };
  };

  await openRun(story.id, [child, api], RUN_STARTED);
  const webPr = await sessionPr(story, webRepo, WEB_HEAD, 'Rate-limit the public API — web');
  const apiPr = await sessionPr(story, apiRepo, API_HEAD, 'Rate-limit the public API — api');

  // The record, through the call `publish_test_instructions` lands on.
  await testInstructionsService.publish(
    {
      workItemId: story.id,
      bodyMd: RUN_BODY,
      previewPath: `/items/${story.identifier}`,
      repos: [
        { repoId: webRepo.id, commitSha: WEB_HEAD },
        { repoId: apiRepo.id, commitSha: API_HEAD },
      ],
      attributeToRunningDispatch: true,
    },
    ctx,
  );

  // ONE repository's CI reported a successful preview; the other reported none.
  const outcome = await repoDeploymentService.record(
    'github',
    {
      providerRepoId: webRepo.repoId,
      providerDeploymentId: '4906700',
      commitSha: WEB_HEAD,
      ref: BRANCH,
      environment: 'preview',
      state: 'success',
      environmentUrl: PREVIEW_URL,
      occurredAt: new Date('2026-09-13T12:20:00Z'),
    },
    (tx) => tx.githubRepo.findUnique({ where: { id: webRepo.id } }),
  );
  if (outcome !== 'recorded') throw new Error(`deployment seed was ${outcome}, not recorded`);

  // The second story: its run opened a session pull request and wrote nothing.
  await openRun(owing.id, [owingChild], OWED_RUN_STARTED);
  await sessionPr(owing, webRepo, 'c3'.repeat(20), 'Export usage as CSV — web');

  return {
    email,
    password: HOW_TO_TEST_PASSWORD,
    story,
    child,
    owing,
    webPr,
    apiPr,
    runLabel: dispatchRunLabel('run_scope', RUN_STARTED),
    owedRunLabel: dispatchRunLabel('run_scope', OWED_RUN_STARTED),
    workspaceId: workspace.id,
    projectId: project.id,
    ownerId: owner.id,
  };
}

/**
 * Open the story's approve-to-merge question: one AWAITING `pull_request_approval`
 * gate, routed to the owner. Through the repository — see the header for why
 * there is no service to call yet.
 */
export async function openMergeGate(seed: HowToTestSeed): Promise<void> {
  await adminDb.$transaction((tx) =>
    approvalGateRepository.create(
      {
        workspaceId: seed.workspaceId,
        projectId: seed.projectId,
        workItemId: seed.story.id,
        kind: 'pull_request_approval',
        subjectId: seed.webPr.id,
        routedToId: seed.ownerId,
      },
      tx,
    ),
  );
}
