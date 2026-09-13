import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import { workItemsService } from '@/lib/services/workItemsService';
import { howToTestService, dispatchRunLabel } from '@/lib/services/howToTestService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { repoDeploymentRepository } from '@/lib/repositories/repoDeploymentRepository';
import { testInstructionsRepository } from '@/lib/repositories/testInstructionsRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { derivePrCiState } from '@/lib/github/prCiState';
import {
  assembleHowToTest,
  fetchCommandFor,
  joinPreviewUrl,
  pickDeployment,
  shellQuote,
  toCheckConclusion,
  toDeploymentState,
} from '@/lib/howToTest/assemble';
import type { TestInstructionsDTO } from '@/lib/dto/testInstructions';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { organizationIdOf } from '../helpers/organizationOf';
import { randomToken } from '../helpers/random';

// The HOW TO TEST read (Story MOTIR-4906 · MOTIR-5333). Two halves:
//
//   - the PURE assembly, where every "why a path is missing" arm is enumerated;
//   - the SERVICE on real Postgres, where the keys must be the ids the item
//     page's rows carry, the head must be the one `prCiState` names, and the
//     query count must not grow with the number of pull requests.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

function record(over: Partial<TestInstructionsDTO> = {}): TestInstructionsDTO {
  return {
    id: 'rec',
    workItemId: 'wi',
    repoId: 'repo-1',
    commitSha: HEAD,
    clickPathSteps: ['Open the item'],
    clickPathNotApplicable: false,
    clickPathNotApplicableReason: null,
    previewPath: '/items/ACME-1',
    setupCommands: [{ label: 'Install', command: 'pnpm install' }],
    preconditionMd: 'Sign in.',
    dispatchRunId: null,
    publishedById: null,
    isCurrent: true,
    createdAt: '2026-09-13T00:00:00.000Z',
    ...over,
  };
}

function check(
  name: string,
  conclusion: string,
  commitSha = HEAD,
  at = '2026-09-13T10:00:00Z',
  suite = 's1',
) {
  return { checkName: name, conclusion, commitSha, createdAt: new Date(at), checkSuiteId: suite };
}

function pr(over: Partial<Parameters<typeof assembleHowToTest>[0]> = {}) {
  return {
    id: 'pr-1',
    repoId: 'repo-1',
    headRef: 'feat/MOTIR-7-change',
    state: 'open',
    merged: false,
    checkRuns: [check('Vitest', 'success'), check('Lint', 'failure')],
    ...over,
  };
}

function deployment(over: Record<string, unknown> = {}) {
  return {
    repoId: 'repo-1',
    commitSha: HEAD,
    ref: 'feat/MOTIR-7-change',
    environment: 'Preview',
    state: 'success',
    environmentUrl: 'https://acme-preview.vercel.app/',
    occurredAt: new Date('2026-09-13T10:01:00Z'),
    ...over,
  };
}

describe('assembleHowToTest — the pure arms', () => {
  it('fills all three paths when a record, a success deployment and checks exist', () => {
    const dto = assembleHowToTest(pr(), record(), [deployment()]);
    expect(dto).toMatchObject({
      pullRequestId: 'pr-1',
      headRef: 'feat/MOTIR-7-change',
      headSha: HEAD,
      state: 'open',
      merged: false,
      clickPathSteps: ['Open the item'],
      local: {
        status: 'available',
        fetchCommand: 'git fetch origin feat/MOTIR-7-change && git checkout feat/MOTIR-7-change',
        setupCommands: [{ label: 'Install', command: 'pnpm install' }],
        preconditionMd: 'Sign in.',
      },
      preview: {
        status: 'available',
        url: 'https://acme-preview.vercel.app/items/ACME-1',
        environment: 'Preview',
        state: 'success',
        deployedSha: HEAD,
      },
      ci: {
        status: 'available',
        checks: [
          { name: 'Lint', conclusion: 'failure', rawConclusion: null },
          { name: 'Vitest', conclusion: 'success', rawConclusion: null },
        ],
      },
      record: { commitSha: HEAD, stale: false, clickPathNotApplicable: false },
    });
    expect(JSON.stringify(dto)).not.toContain('github.com');
  });

  it.each(['queued', 'pending', 'in_progress', 'failure', 'error', 'inactive', 'canceled'])(
    'a %s deployment is deployment_not_ready with its state',
    (state) => {
      const dto = assembleHowToTest(pr(), record(), [deployment({ state, environmentUrl: null })]);
      expect(dto.preview).toEqual({
        status: 'deployment_not_ready',
        state,
        rawState: null,
        environment: 'Preview',
      });
    },
  );

  it('an unknown stored state maps to the unknown arm, raw value kept', () => {
    const dto = assembleHowToTest(pr(), record(), [deployment({ state: 'exploded' })]);
    expect(dto.preview).toEqual({
      status: 'deployment_not_ready',
      state: 'unknown',
      rawState: 'exploded',
      environment: 'Preview',
    });
    expect(toDeploymentState('exploded')).toEqual({ state: 'unknown', rawState: 'exploded' });
    expect(toCheckConclusion('cancelled')).toEqual({
      conclusion: 'unknown',
      rawConclusion: 'cancelled',
    });
  });

  it('no deployment for the head commit is no_deployment_reported', () => {
    const dto = assembleHowToTest(pr(), record(), [deployment({ commitSha: OLD })]);
    expect(dto.preview).toEqual({ status: 'no_deployment_reported' });
  });

  it('with NO head sha, a deployment matched by headRef is used', () => {
    const dto = assembleHowToTest(pr({ checkRuns: [] }), record(), [
      deployment({ commitSha: OLD }),
    ]);
    expect(dto.headSha).toBeNull();
    expect(dto.preview).toMatchObject({ status: 'available', deployedSha: OLD });
    expect(dto.ci).toEqual({ status: 'no_checks_reported' });
    // No head known → the record cannot be called stale.
    expect(dto.record?.stale).toBe(false);
  });

  it('a deployment in ANOTHER repository never matches', () => {
    const dto = assembleHowToTest(pr({ checkRuns: [] }), record(), [
      deployment({ repoId: 'repo-2' }),
    ]);
    expect(dto.preview).toEqual({ status: 'no_deployment_reported' });
  });

  it('prefers a success WITH a URL over a newer failure in another environment', () => {
    const chosen = pickDeployment([
      deployment({ environment: 'Storybook', state: 'failure', occurredAt: new Date(2e12) }),
      deployment({ occurredAt: new Date(1e12) }),
    ]);
    expect(chosen?.environment).toBe('Preview');
    expect(pickDeployment([])).toBeNull();
  });

  it('no record is record_missing, with the other paths still reported', () => {
    const dto = assembleHowToTest(pr(), null, [deployment()]);
    expect(dto.local).toEqual({ status: 'record_missing' });
    expect(dto.record).toBeNull();
    expect(dto.clickPathSteps).toEqual([]);
    expect(dto.preview).toMatchObject({
      status: 'available',
      url: 'https://acme-preview.vercel.app/',
    });
  });

  it('a record for an older commit is stale; an abbreviated head sha is not', () => {
    expect(assembleHowToTest(pr(), record({ commitSha: OLD }), []).record?.stale).toBe(true);
    expect(assembleHowToTest(pr(), record({ commitSha: HEAD.slice(0, 7) }), []).record?.stale).toBe(
      false,
    );
  });

  it('a not-applicable click-path carries its reason and no steps', () => {
    const dto = assembleHowToTest(
      pr(),
      record({
        clickPathSteps: [],
        clickPathNotApplicable: true,
        clickPathNotApplicableReason: 'no rendered surface changed',
      }),
      [],
    );
    expect(dto.clickPathSteps).toEqual([]);
    expect(dto.record).toMatchObject({
      clickPathNotApplicable: true,
      clickPathNotApplicableReason: 'no rendered surface changed',
    });
  });

  it('a merged pull request reports closed + merged, for the collapsed state', () => {
    const dto = assembleHowToTest(pr({ state: 'closed', merged: true }), record(), []);
    expect(dto).toMatchObject({ state: 'closed', merged: true });
  });

  it('ci.checks are the live rows at the head — the rows prCiState judges — across a re-run and an older sha', () => {
    const rows = [
      check('Vitest', 'failure', OLD, '2026-09-13T09:00:00Z', 'old'),
      // The head has two runs; the later run supersedes the cancelled one.
      check('Vitest', 'failure', HEAD, '2026-09-13T10:00:00Z', 'run-1'),
      check('Vitest', 'success', HEAD, '2026-09-13T10:05:00Z', 'run-2'),
      check('Lint', 'success', HEAD, '2026-09-13T10:05:30Z', 'run-2'),
    ];
    const dto = assembleHowToTest(pr({ checkRuns: rows }), null, []);
    expect(dto.headSha).toBe(HEAD);
    expect(dto.ci).toEqual({
      status: 'available',
      checks: [
        { name: 'Lint', conclusion: 'success', rawConclusion: null },
        { name: 'Vitest', conclusion: 'success', rawConclusion: null },
      ],
    });
    // The pill over the same rows agrees: everything live at the head passed.
    expect(derivePrCiState(rows)).toBe('passing');
  });
});

describe('the fetch line and the preview URL', () => {
  it.each([
    'feat/MOTIR-7-change',
    "it's-a-branch",
    'has space',
    'semi;rm -rf ~',
    '$(whoami)',
    'back`tick`',
  ])('shell-quotes %s so it round-trips through sh', (ref) => {
    const quoted = shellQuote(ref);
    const echoed = execFileSync('sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' });
    expect(echoed).toBe(ref);
    expect(fetchCommandFor(ref)).toBe(`git fetch origin ${quoted} && git checkout ${quoted}`);
  });

  it('joins a URL and a path without doubling the slash', () => {
    expect(joinPreviewUrl('https://x.app/', '/items/A-1')).toBe('https://x.app/items/A-1');
    expect(joinPreviewUrl('https://x.app', '/items/A-1')).toBe('https://x.app/items/A-1');
    expect(joinPreviewUrl('https://x.app', null)).toBe('https://x.app');
  });

  it('labels a run as its operator typed it', () => {
    const at = new Date('2026-09-13T12:04:33Z');
    expect(dispatchRunLabel('run', at)).toBe('motir run · 2026-09-13 12:04 UTC');
    expect(dispatchRunLabel('run_scope', at)).toBe('motir run · 2026-09-13 12:04 UTC');
    expect(dispatchRunLabel('auto', at)).toBe('motir auto · 2026-09-13 12:04 UTC');
  });
});

// ── the service, on real Postgres ─────────────────────────────────────────────

async function connectRepo(fx: WorkItemFixture, name: string) {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}` },
    create: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: await organizationIdOf(fx.workspaceId),
      repoId: `repo-${randomToken(8)}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: repo.id,
    name,
  });
  return repo;
}

let prNumber = 1;
async function linkedPr(
  fx: WorkItemFixture,
  workItemId: string,
  repoId: string,
  headRef: string,
  checks: Array<{ name: string; conclusion: string; sha: string }> = [],
) {
  const row = await adminDb.githubPullRequest.create({
    data: {
      repoId,
      number: prNumber++,
      state: 'open',
      merged: false,
      headRef,
      baseRef: 'main',
      title: 'A change',
    },
  });
  await adminDb.workItemDelivery.create({
    data: { workspaceId: fx.workspaceId, workItemId, githubPullRequestId: row.id, repoId },
  });
  for (const c of checks) {
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: row.id,
        commitSha: c.sha,
        checkName: c.name,
        conclusion: c.conclusion,
      },
    });
  }
  return row;
}

describe('howToTestService.getForWorkItem', () => {
  it('returns an empty map for an item with no linked pull request', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Nothing linked' });
    await expect(howToTestService.getForWorkItem(card.id, fx.ctx)).resolves.toEqual({
      byPullRequestId: {},
      owedBy: null,
    });
  });

  it('keys one entry per linked pull request by the id the Development rows carry — two repositories, two blocks', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Two repos' });
    const web = await connectRepo(fx, 'web');
    const api = await connectRepo(fx, 'api');
    await linkedPr(fx, card.id, web.id, 'feat/web-side', [
      { name: 'Vitest', conclusion: 'success', sha: HEAD },
    ]);
    await linkedPr(fx, card.id, api.id, 'feat/api-side');
    await testInstructionsService.publish(
      {
        workItemId: card.id,
        repoId: web.id,
        commitSha: HEAD,
        clickPathSteps: ['Open the board'],
        setupCommands: [{ label: 'Run', command: 'pnpm dev' }],
      },
      fx.ctx,
    );
    await adminDb.repoDeployment.create({
      data: {
        workspaceId: fx.workspaceId,
        repoId: web.id,
        provider: 'github',
        providerDeploymentId: '1',
        commitSha: HEAD,
        ref: 'feat/web-side',
        environment: 'Preview',
        state: 'success',
        environmentUrl: 'https://web-preview.example',
        occurredAt: new Date(),
      },
    });

    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    const rows = await workItemsService.listLinkedPullRequests(card.id, fx.ctx);
    expect(Object.keys(dto.byPullRequestId).sort()).toEqual(rows.map((r) => r.id).sort());

    const webBlock = Object.values(dto.byPullRequestId).find((b) => b.repoId === web.id)!;
    const apiBlock = Object.values(dto.byPullRequestId).find((b) => b.repoId === api.id)!;
    expect(webBlock.local).toMatchObject({
      status: 'available',
      fetchCommand: 'git fetch origin feat/web-side && git checkout feat/web-side',
    });
    expect(webBlock.preview).toMatchObject({
      status: 'available',
      url: 'https://web-preview.example',
    });
    expect(webBlock.ci).toMatchObject({ status: 'available' });
    expect(apiBlock.local).toEqual({ status: 'record_missing' });
    expect(apiBlock.preview).toEqual({ status: 'no_deployment_reported' });
    expect(apiBlock.ci).toEqual({ status: 'no_checks_reported' });
  });

  it('names the latest dispatch run that claimed the item as owedBy', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Owed' });
    await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run',
        startedAt: new Date('2026-09-01T08:00:00Z'),
        cards: { create: { workspaceId: fx.workspaceId, workItemId: card.id, position: 0 } },
      },
    });
    const latest = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'auto',
        startedAt: new Date('2026-09-13T12:04:00Z'),
        cards: { create: { workspaceId: fx.workspaceId, workItemId: card.id, position: 0 } },
      },
    });
    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(dto.owedBy).toEqual({ runId: latest.id, label: 'motir auto · 2026-09-13 12:04 UTC' });
  });

  it('refuses a reader who cannot browse the project, with the not-found the item page raises', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Private' });
    const stranger = await usersService.createUser({
      email: 'stranger@ex.com',
      password: 'hunter2hunter2',
      name: 'Stranger',
    });
    const other = await workspacesService.createWorkspace({
      name: 'Elsewhere',
      ownerUserId: stranger.id,
    });
    await expect(
      howToTestService.getForWorkItem(card.id, {
        userId: stranger.id,
        workspaceId: other.workspace.id,
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND/) });

    // And a CUSTOM role on the card's own project that holds no browse key.
    const member = await usersService.createUser({
      email: 'member@ex.com',
      password: 'hunter2hunter2',
      name: 'Member',
    });
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    const role = await projectRoleDefinitionService
      .create({
        projectId: fx.projectId,
        ctx: fx.ctx,
        name: 'No browse',
        permissions: ['comment:add'],
      })
      .catch(() => null);
    if (role) {
      await projectMembersService.addMember({
        key: fx.projectIdentifier,
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        targetUserId: member.id,
        role: 'member',
      });
      await projectMembersService.setRole({
        key: fx.projectIdentifier,
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        targetUserId: member.id,
        role: role.id,
      });
      await expect(
        howToTestService.getForWorkItem(card.id, {
          userId: member.id,
          workspaceId: fx.workspaceId,
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|DENIED/) });
    }
    expect(role, 'a custom role without project:browse could not be created').not.toBeNull();
  });

  it('issues the SAME number of reads for 1 and for 3 linked pull requests', async () => {
    const fx = await makeWorkItemFixture();
    const web = await connectRepo(fx, 'web');
    const one = await createTestWorkItem(fx, { kind: 'task', title: 'One' });
    const three = await createTestWorkItem(fx, { kind: 'task', title: 'Three' });
    await linkedPr(fx, one.id, web.id, 'feat/one', [
      { name: 'A', conclusion: 'success', sha: HEAD },
    ]);
    for (const n of [1, 2, 3]) {
      await linkedPr(fx, three.id, web.id, `feat/three-${n}`, [
        { name: 'A', conclusion: 'success', sha: `${n}`.repeat(40) },
      ]);
    }

    const spies = [
      vi.spyOn(workItemDeliveryRepository, 'listByWorkItemWithChecks'),
      vi.spyOn(testInstructionsRepository, 'listCurrentByWorkItem'),
      vi.spyOn(repoDeploymentRepository, 'listLatestByCommits'),
      vi.spyOn(repoDeploymentRepository, 'listLatestByRefs'),
      vi.spyOn(dispatchRunRepository, 'listByWorkItem'),
    ];
    const count = () => spies.reduce((sum, s) => sum + s.mock.calls.length, 0);

    await howToTestService.getForWorkItem(one.id, fx.ctx);
    const forOne = count();
    spies.forEach((s) => s.mockClear());
    const dto = await howToTestService.getForWorkItem(three.id, fx.ctx);
    const forThree = count();

    expect(Object.keys(dto.byPullRequestId)).toHaveLength(3);
    expect(forThree).toBe(forOne);
  });
});
