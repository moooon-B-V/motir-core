import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// NO BACKGROUND MOVER REOPENS A MARKED CARD (Story MOTIR-6575 · MOTIR-6681).
// ═══════════════════════════════════════════════════════════════════════════
//
// MOTIR-6672 made `applyStatusTransition` refuse a marked card's move out of the
// done category — `opts.system` included. This pins that the SYSTEM callers which
// can meet that refusal RECORD an outcome and throw nothing, against a real
// Postgres, one case per disposition class:
//
//   · the parent rollup's backward arm records `held_by_mark`; its JOB completes;
//   · the PR-status sync records `marked_held` and answers success;
//   · an automation rule's transition records `held_by_mark`, never a failure;
//   · the merge-queue settle declines a marked card;
//   · the bare ready claim passes over a marked card to the next one;
//   · a plan's park leaves a marked card's status where it is.
//
// (The CI promotion's skip is `tests/github/ciGreenPromotion.test.ts`; the
// importer's is `tests/import/importPersistService.test.ts`.)
//
// Only the session / active-project resolvers are stubbed (the project rule).
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

import { db } from '@/lib/db';
import { automationEngineService } from '@/lib/services/automationEngineService';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { settleUnlandedOutcome } from '@/lib/services/mergeQueueExitService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { statusDerivationOnRequested } from '@/lib/jobs/definitions/statusDerivation';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { JobTestEngine, dispatchedEvents, spyOnJobDispatch } from '../../helpers/jobs';
import { linkWorkspaceReposToProject } from '../../helpers/projectRepoLink';

const T = { timeout: 60_000 };

let fx: WorkItemFixture;
let jobSpy: ReturnType<typeof spyOnJobDispatch>;

beforeEach(async () => {
  jobSpy = spyOnJobDispatch();
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: fx.owner.email, name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Card = { id: string; identifier: string };

async function seedCard(
  title = 'The card',
  over: { kind?: 'task' | 'story' | 'subtask'; parentId?: string } = {},
): Promise<Card> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: over.kind ?? 'task', title, parentId: over.parentId },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

/** Finish a card and mark it, the way a person does it today. */
async function finishAndMark(card: Card, mark: 'outdated' | 'deprecated' = 'outdated') {
  await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });
  await workItemsService.updateWorkItem(card.id, { obsolescence: mark }, fx.ctx);
}

/** A LEGACY mark: set on an OPEN card behind the service's back, the shape a card
 *  marked before MOTIR-6672 has. No door can make one now; the rows were not
 *  migrated, so the movers must still behave on them. */
async function legacyMark(card: Card) {
  await adminDb.workItem.update({ where: { id: card.id }, data: { obsolescence: 'deprecated' } });
}

describe('the parent rollup — the story’s named case', () => {
  it(
    'a marked `done` parent whose child reopened stays done: `held_by_mark`, the job completes, nothing emitted',
    T,
    async () => {
      await truncateJobRuns();
      const story = await seedCard('Story', { kind: 'story' });
      const child = await seedCard('Child', { kind: 'subtask', parentId: story.id });
      await adminDb.workItem.update({ where: { id: child.id }, data: { status: 'done' } });
      await finishAndMark(story);
      // The child is reopened — the backward derivation would set the parent to To Do.
      await adminDb.workItem.update({ where: { id: child.id }, data: { status: 'todo' } });
      jobSpy.mockClear();

      const { result, error } = await new JobTestEngine({
        function: statusDerivationOnRequested,
        events: [
          {
            name: 'work-item/derivation.requested',
            data: {
              workspaceId: fx.workspaceId,
              parentId: story.id,
              workItemId: child.id,
              reason: 'imported-status-pinned',
            },
          },
        ],
      }).execute();

      expect(error).toBeUndefined();
      expect(result).toMatchObject({ outcome: 'held_by_mark', parentId: story.id });
      const runs = await adminDb.jobRun.findMany({
        where: { functionId: statusDerivationOnRequested.id },
      });
      expect(runs.map((r) => r.status)).toEqual(['succeeded']);
      expect(await statusOf(story.id)).toBe('done');
      expect(
        dispatchedEvents(jobSpy).filter(
          (e) =>
            e.name === 'work-item/transitioned' &&
            (e.data as { workItemId?: string }).workItemId === story.id,
        ),
      ).toEqual([]);
    },
  );
});

describe('an automation rule', () => {
  it(
    'whose transition targets a marked card records `held_by_mark` — never a failure',
    T,
    async () => {
      const card = await seedCard();
      await finishAndMark(card, 'deprecated');
      const rule = await automationRulesService.create(
        fx.project.identifier,
        {
          name: 'reopen it',
          triggerType: 'created',
          triggerConfig: {},
          conditionFilterParam: null,
          actions: [{ type: 'transition', toStatusId: 'in_progress' }],
        },
        fx.ctx,
      );

      const summary = await automationEngineService.runForEvent({
        trigger: 'created',
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        eventId: 'evt-held-by-mark',
      });

      expect(summary).toMatchObject({ matched: 1, failed: 0, succeeded: 0, heldByMark: 1 });
      const rows = await adminDb.automationRuleExecution.findMany({ where: { ruleId: rule.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('held_by_mark');
      expect(rows[0]!.error).toMatch(/MARKED_CARD_CANNOT_REOPEN/);
      const after = await adminDb.automationRule.findUniqueOrThrow({ where: { id: rule.id } });
      expect(after).toMatchObject({ consecutiveFailureCount: 0, enabled: true });
      expect(await statusOf(card.id)).toBe('done');
    },
  );
});

describe('the merge queue, the ready claim and the plan park — a LEGACY mark on an open card', () => {
  it('the queue-exit settle declines a marked card — no move, nothing re-asked', T, async () => {
    const card = await seedCard();
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'in_review' } });
    await legacyMark(card);

    for (const landingClass of ['retryable', 'setting', 'cant_land'] as const) {
      const out = await withWorkspaceContext(fx.ctx, async (tx) => {
        const item = await tx.workItem.findUniqueOrThrow({ where: { id: card.id } });
        return settleUnlandedOutcome(item, landingClass, fx.ctx, tx);
      });
      expect(out, landingClass).toEqual({ transition: null, raised: false });
    }
    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('the bare ready claim passes over a marked card and takes the next ready one', T, async () => {
    const marked = await seedCard('Marked while open');
    const next = await seedCard('Still current');
    await legacyMark(marked);
    // Rank the marked card FIRST, so a claim that tried it would fail rather than skip.
    await adminDb.workItem.update({ where: { id: marked.id }, data: { priority: 'highest' } });

    const claimed = await workItemsService.claimNextReady(fx.projectId, null, fx.ctx);

    expect(claimed?.id).toBe(next.id);
    expect(await statusOf(marked.id)).toBe('todo');
    expect(await statusOf(next.id)).toBe('in_progress');
  });

  it('a plan’s park takes the lock but leaves a marked card’s status where it is', T, async () => {
    const card = await seedCard();
    await legacyMark(card);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: card.id, patch: { descriptionMd: 'Re-scoped.' } }],
      fx.ctx,
    );

    expect(await statusOf(card.id)).toBe('todo');
    const lock = await adminDb.planTargetLock.findUnique({ where: { workItemId: card.id } });
    expect(lock).toMatchObject({ statusHeld: false, priorStatus: 'todo' });
  });
});

describe('the PR-status sync', () => {
  const INSTALLATION_ID = 'inst-marked-sync';
  const REPO_PROVIDER_ID = '9681';
  const BRANCH = 'subtask/marked-sync';

  async function scenario() {
    _resetInstallationTokenCache();
    const user = await usersService.createUser({
      email: 'marked-sync@example.com',
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
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    await linkWorkspaceReposToProject({
      workspaceId: workspace.id,
      projectId: project.id,
      names: ['motir-core'],
    });
    const card = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Ship it', targetRepos: ['motir-core'] },
      ctx,
    );
    return { project, ctx, card };
  }

  const pr = (action: string, merged = false) =>
    githubWebhookService.handleEvent('pull_request', {
      action,
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number: 881,
        state: merged ? 'closed' : 'open',
        merged,
        merged_at: merged ? '2026-09-28T10:00:00.000Z' : null,
        title: 'Ship it',
        head: { ref: BRANCH },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });

  it(
    'a pull request REOPENED on a marked `done` card leaves it done and records `marked_held`',
    T,
    async () => {
      const s = await scenario();
      await githubPullRequestService.linkPullRequestByCoordinates(
        {
          workItemId: s.card.id,
          projectId: s.project.id,
          owner: 'moooon',
          name: 'motir-core',
          number: 881,
          headRef: BRANCH,
          baseRef: 'main',
          title: null,
        },
        s.ctx,
      );
      await adminDb.workItem.update({ where: { id: s.card.id }, data: { status: 'done' } });
      await workItemsService.updateWorkItem(s.card.id, { obsolescence: 'deprecated' }, s.ctx);

      const reopened = await pr('reopened');

      expect(reopened).toMatchObject({
        event: 'pull_request',
        outcome: 'marked_held',
        workItemId: s.card.id,
      });
      expect(await statusOf(s.card.id)).toBe('done');
    },
  );
});
