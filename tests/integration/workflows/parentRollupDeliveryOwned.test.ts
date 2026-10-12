import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { promoteDeliveredCardsOnGreen } from '@/lib/services/ciPromotion';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkPrByIdentifier } from '../../helpers/prLink';

// A STORY RUN's review rungs belong to its OWN pull request, not to its children
// (Bug MOTIR-8327; `docs/decisions/status-derivation.md` §3, the 2026-10-12
// amendment) — against a REAL Postgres, through the real CI promotion.
//
// The defect: green CI promotes a self-delivering story Implemented → In Review and
// raises its `pull_request_approval` gate. A CHILD the same pull request delivers is
// promoted in the same pass, and that child's transition recomputes the story. The
// rest of the children are still at `implemented`, so the ladder says `implemented`,
// the BACKWARD arm system-sets the story there, and leaving In Review supersedes the
// gate `pulled_back` — seconds after it was raised, with nobody asked. Measured three
// times on MOTIR-8216 / motir-core#3538 on 2026-10-12.
//
// Lives beside the rollup's own suites so the approved-status coverage lane
// (`vitest.coverage.approved-status.config.ts`), which measures
// `parentStatusRollupService.ts`, sees it.

const DB_TEST_TIMEOUT_MS = 30_000;
const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-delivery-owned';
const REPO_PROVIDER_ID = '8327';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const PR_NUMBER = 41;

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  // A `manual` project (the default merge mode), so green CI raises the
  // approve-to-merge question the defect withdraws.
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

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function mergeGates(workItemId: string) {
  return adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'pull_request_approval' },
    orderBy: { createdAt: 'asc' },
  });
}

async function prId(): Promise<string> {
  return (await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: PR_NUMBER } })).id;
}

/**
 * The card's reproduction, verbatim in shape: story S with children C1
 * (`implemented`, NOT delivered by the pull request) and C2 (`implemented`,
 * delivered by it), S itself delivered by the same open pull request P. Green
 * check rows at P's head, then `promoteDeliveredCardsOnGreen(P)`.
 */
async function promotedStoryRun(s: Scenario) {
  const story = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'story', title: 'The story' },
    s.ctx,
  );
  const c1 = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'Built on the branch', parentId: story.id },
    s.ctx,
  );
  const c2 = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'The story E2E', parentId: story.id },
    s.ctx,
  );
  // The story run published its How to test on the run target.
  await adminDb.testInstructions.create({
    data: {
      workspaceId: s.workspace.id,
      projectId: s.project.id,
      workItemId: story.id,
      bodyMd: '## Open the page',
    },
  });
  const headRef = `parent/${story.identifier}-work`;
  for (const identifier of [story.identifier, c2.identifier]) {
    await linkPrByIdentifier({
      identifier,
      owner: 'moooon',
      name: 'acme',
      number: PR_NUMBER,
      headRef,
    });
  }
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: PR_NUMBER,
      state: 'open',
      merged: false,
      title: `${story.identifier} The story`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
  // The run settled every card at Implemented before CI spoke.
  await adminDb.workItem.updateMany({
    where: { id: { in: [story.id, c1.id, c2.id] } },
    data: { status: 'implemented' },
  });
  await adminDb.githubCheckRun.create({
    data: {
      pullRequestId: await prId(),
      commitSha: 'sha-story',
      checkName: 'ci / vitest',
      conclusion: 'success',
    },
  });

  await promoteDeliveredCardsOnGreen({
    changeRequestId: await prId(),
    workspaceId: s.workspace.id,
    actorUserId: s.user.id,
  });

  expect(await statusOf(story.id)).toBe('in_review');
  expect(await statusOf(c2.id)).toBe('in_review');
  expect(await statusOf(c1.id)).toBe('implemented');
  const gates = await mergeGates(story.id);
  expect(gates.map((g) => g.state)).toEqual(['awaiting']);
  return { story, c1, c2 };
}

/** The child's `work-item/transitioned` recompute, as the derivation job runs it.
 *  `occurredAt` is "now": on MOTIR-8216 the child's promotion landed 1–2 s AFTER
 *  the story's, so the child set is the younger edit and `stale_backward` (the
 *  MOTIR-2965 guard) does not stand the arm down. */
const recomputeFromChild = (s: Scenario, childId: string) =>
  parentStatusRollupService.rollUpForChild(childId, s.workspace.id, { occurredAt: new Date() });

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a self-delivering story keeps the review rung its own CI gave it', () => {
  it(
    'the child recompute stands down `delivery_owned`: the story stays In Review and its gate stays awaiting',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const s = await makeScenario('delivery-owned@example.com');
      const { story, c2 } = await promotedStoryRun(s);

      const out = await recomputeFromChild(s, c2.id);

      expect(out).toEqual({
        outcome: 'delivery_owned',
        parentId: story.id,
        toStatus: 'implemented',
      });
      expect(await statusOf(story.id)).toBe('in_review');
      expect((await mergeGates(story.id)).map((g) => [g.state, g.supersededCause])).toEqual([
        ['awaiting', null],
      ]);
    },
  );

  it(
    'holds at APPROVED too — the merge-queue re-ask shape the card measured at 15:11',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const s = await makeScenario('delivery-owned-approved@example.com');
      const { story, c2 } = await promotedStoryRun(s);
      await adminDb.workItem.update({ where: { id: story.id }, data: { status: 'approved' } });

      const out = await recomputeFromChild(s, c2.id);

      expect(out).toMatchObject({ outcome: 'delivery_owned', parentId: story.id });
      expect(await statusOf(story.id)).toBe('approved');
    },
  );

  it(
    'a recompute addressed to the PARENT, with no trigger instant, stands down the same way',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const s = await makeScenario('delivery-owned-parent@example.com');
      const { story } = await promotedStoryRun(s);

      // The parent-keyed entry point the re-parent / delete / pin triggers use.
      // Before the fix this rolled the story back too: the promotion writes C2
      // in the same pass as the story, so the child set is never older than the
      // story's status and `stale_backward` cannot be what protects it.
      const out = await parentStatusRollupService.recomputeParent(story.id, s.workspace.id);

      expect(out).toEqual({
        outcome: 'delivery_owned',
        parentId: story.id,
        toStatus: 'implemented',
      });
      expect(await statusOf(story.id)).toBe('in_review');
      expect((await mergeGates(story.id)).map((g) => g.state)).toEqual(['awaiting']);
    },
  );
});

describe('what the stand-down does NOT cover', () => {
  it(
    'a child reopened BELOW implemented still pulls the story back, and the merge question with it',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const s = await makeScenario('delivery-owned-reopen@example.com');
      const { story, c1 } = await promotedStoryRun(s);
      // Unbuilt work under the story is a claim about the children the story's own
      // CI verdict cannot answer for.
      await adminDb.workItem.update({ where: { id: c1.id }, data: { status: 'in_progress' } });

      const out = await recomputeFromChild(s, c1.id);

      expect(out).toEqual({ outcome: 'rolled_back', parentId: story.id, toStatus: 'in_progress' });
      expect(await statusOf(story.id)).toBe('in_progress');
      expect((await mergeGates(story.id)).map((g) => [g.state, g.supersededCause])).toEqual([
        ['superseded', 'pulled_back'],
      ]);
    },
  );

  it(
    'a story whose pull request is no longer OPEN is the children’s again, and rolls back',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const s = await makeScenario('delivery-owned-closed@example.com');
      const { story, c2 } = await promotedStoryRun(s);
      await adminDb.githubPullRequest.update({
        where: { id: await prId() },
        data: { state: 'closed' },
      });

      const out = await recomputeFromChild(s, c2.id);

      expect(out).toEqual({ outcome: 'rolled_back', parentId: story.id, toStatus: 'implemented' });
      expect(await statusOf(story.id)).toBe('implemented');
    },
  );
});
