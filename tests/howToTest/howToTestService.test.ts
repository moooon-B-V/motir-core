import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import { howToTestService, dispatchRunLabel } from '@/lib/services/howToTestService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { repoDeploymentRepository } from '@/lib/repositories/repoDeploymentRepository';
import { testInstructionsRepository } from '@/lib/repositories/testInstructionsRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { ERASED_USER_NAME } from '@/lib/users/accountErasure';
import { derivePrCiState } from '@/lib/github/prCiState';
import {
  assembleHowToTestRepo,
  fetchCommandFor,
  joinPreviewUrl,
  pickDeployment,
  pickPullRequest,
  shellQuote,
  toCheckConclusion,
  toDeploymentState,
} from '@/lib/howToTest/assemble';
import type { TestInstructionsRepoDTO } from '@/lib/dto/testInstructions';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { organizationIdOf } from '../helpers/organizationOf';
import { randomToken } from '../helpers/random';

// The HOW TO TEST read (Story MOTIR-4906 · MOTIR-5333 — per RUN TARGET). Two halves:
//
//   - the PURE assembly, where every "why a path is missing" arm is enumerated;
//   - the SERVICE on real Postgres, where a story's sections must bind to the
//     story's own session pull requests before a child's, a child with no record
//     must point at its run target, the head must be the one `prCiState` names,
//     and the query count must not grow with the number of repositories.

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

function section(over: Partial<TestInstructionsRepoDTO> = {}): TestInstructionsRepoDTO {
  return {
    repoId: 'repo-1',
    commitSha: HEAD,
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

function pr(over: Partial<NonNullable<Parameters<typeof assembleHowToTestRepo>[2]>> = {}) {
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

const assemble = (
  prInput: ReturnType<typeof pr> | null,
  deployments: ReturnType<typeof deployment>[] = [],
  over: Partial<TestInstructionsRepoDTO> = {},
  previewPath: string | null = '/items/ACME-1',
) => assembleHowToTestRepo(section(over), 'acme/web', prInput, deployments, previewPath);

describe('assembleHowToTestRepo — the pure arms', () => {
  it('fills all three paths when the section, its pull request, a success deployment and checks exist', () => {
    const dto = assemble(pr(), [deployment()]);
    expect(dto).toMatchObject({
      repoId: 'repo-1',
      repoName: 'acme/web',
      commitSha: HEAD,
      pullRequest: {
        id: 'pr-1',
        headRef: 'feat/MOTIR-7-change',
        headSha: HEAD,
        state: 'open',
        merged: false,
      },
      stale: false,
      fetchCommand: 'git fetch origin feat/MOTIR-7-change && git checkout feat/MOTIR-7-change',
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
    });
    expect(JSON.stringify(dto)).not.toContain('github.com');
  });

  it.each(['queued', 'pending', 'in_progress', 'failure', 'error', 'inactive', 'canceled'])(
    'a %s deployment is deployment_not_ready with its state',
    (state) => {
      const dto = assemble(pr(), [deployment({ state, environmentUrl: null })]);
      expect(dto.preview).toEqual({
        status: 'deployment_not_ready',
        state,
        rawState: null,
        environment: 'Preview',
      });
    },
  );

  it('an unknown stored state maps to the unknown arm, raw value kept', () => {
    const dto = assemble(pr(), [deployment({ state: 'exploded' })]);
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
    const dto = assemble(pr(), [deployment({ commitSha: OLD })]);
    expect(dto.preview).toEqual({ status: 'no_deployment_reported' });
  });

  it('with NO head sha, a deployment matched by headRef is used, and the section cannot be stale', () => {
    const dto = assemble(pr({ checkRuns: [] }), [deployment({ commitSha: OLD })], {
      commitSha: OLD,
    });
    expect(dto.pullRequest?.headSha).toBeNull();
    expect(dto.preview).toMatchObject({ status: 'available', deployedSha: OLD });
    expect(dto.ci).toEqual({ status: 'no_checks_reported' });
    expect(dto.stale).toBe(false);
  });

  it('a deployment in ANOTHER repository never matches', () => {
    const dto = assemble(pr({ checkRuns: [] }), [deployment({ repoId: 'repo-2' })]);
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

  it('a section with NO pull request says so on every path', () => {
    const dto = assemble(null, [deployment()]);
    expect(dto).toMatchObject({
      pullRequest: null,
      stale: false,
      fetchCommand: null,
      preview: { status: 'no_deployment_reported' },
      ci: { status: 'no_checks_reported' },
    });
  });

  it('a section for an older commit is stale; an abbreviated head sha is not', () => {
    expect(assemble(pr(), [], { commitSha: OLD }).stale).toBe(true);
    expect(assemble(pr(), [], { commitSha: HEAD.slice(0, 7) }).stale).toBe(false);
  });

  it('with no previewPath the preview is the bare deployment URL', () => {
    const dto = assemble(pr(), [deployment()], {}, null);
    expect(dto.preview).toMatchObject({ url: 'https://acme-preview.vercel.app/' });
  });

  it('a merged pull request reports closed + merged, for the collapsed state', () => {
    const dto = assemble(pr({ state: 'closed', merged: true }));
    expect(dto.pullRequest).toMatchObject({ state: 'closed', merged: true });
  });

  it('ci.checks are the live rows at the head — the rows prCiState judges — across a re-run and an older sha', () => {
    const rows = [
      check('Vitest', 'failure', OLD, '2026-09-13T09:00:00Z', 'old'),
      // The head has two runs; the later run supersedes the cancelled one.
      check('Vitest', 'failure', HEAD, '2026-09-13T10:00:00Z', 'run-1'),
      check('Vitest', 'success', HEAD, '2026-09-13T10:05:00Z', 'run-2'),
      check('Lint', 'success', HEAD, '2026-09-13T10:05:30Z', 'run-2'),
    ];
    const dto = assemble(pr({ checkRuns: rows }));
    expect(dto.pullRequest?.headSha).toBe(HEAD);
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

describe('pickPullRequest — the run target first, then its descendants', () => {
  const row = (id: string, repoId: string, state = 'open') => ({ id, repoId, state });

  it("prefers the target's own pull request in the repository over a descendant's", () => {
    expect(pickPullRequest('web', [row('own', 'web', 'closed')], [row('child', 'web')])?.id).toBe(
      'own',
    );
  });

  it('falls back to a descendant, preferring an open one, else the most recently linked', () => {
    expect(
      pickPullRequest(
        'web',
        [row('own-api', 'api')],
        [row('c1', 'web', 'closed'), row('c2', 'web')],
      )?.id,
    ).toBe('c2');
    expect(
      pickPullRequest('web', [], [row('c1', 'web', 'closed'), row('c2', 'web', 'closed')])?.id,
    ).toBe('c2');
  });

  it('returns null when no pull request anywhere is in the repository', () => {
    expect(pickPullRequest('web', [row('a', 'api')], [row('b', 'api')])).toBeNull();
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

const BODY = '## Precondition\n\nSign in.\n\n## Locally\n\n```sh\npnpm dev\n```';

describe('howToTestService.getForWorkItem', () => {
  it('an item with no record, no ancestor record and no run is record_missing with nobody owed', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Nothing' });
    await expect(howToTestService.getForWorkItem(card.id, fx.ctx)).resolves.toEqual({
      state: 'record_missing',
      runTarget: null,
      owedBy: null,
      record: null,
      repos: [],
      history: [],
    });
  });

  it("a STORY run: two repository sections bound to the story's own session pull requests, with preview and checks", async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story run' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'A child',
      parentId: story.id,
    });
    const web = await connectRepo(fx, 'web');
    const api = await connectRepo(fx, 'api');
    // A child's own per-card pull request in web, which must NOT win over the story's.
    await linkedPr(fx, child.id, web.id, 'subtask/child-web', [
      { name: 'Vitest', conclusion: 'failure', sha: OLD },
    ]);
    const storyWeb = await linkedPr(fx, story.id, web.id, 'parent/story-web', [
      { name: 'Vitest', conclusion: 'success', sha: HEAD },
    ]);
    // api has no pull request on the story — the child's is the fallback.
    const childApi = await linkedPr(fx, child.id, api.id, 'subtask/child-api');
    await testInstructionsService.publish(
      {
        workItemId: story.id,
        bodyMd: BODY,
        previewPath: '/items/ACME-1',
        repos: [
          { repoId: web.id, commitSha: HEAD },
          { repoId: api.id, commitSha: OLD },
        ],
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
        ref: 'parent/story-web',
        environment: 'Preview',
        state: 'success',
        environmentUrl: 'https://web-preview.example',
        occurredAt: new Date(),
      },
    });

    const dto = await howToTestService.getForWorkItem(story.id, fx.ctx);
    expect(dto.state).toBe('record');
    expect(dto.record).toMatchObject({
      run: null,
      bodyMd: BODY,
      previewPath: '/items/ACME-1',
    });
    expect(dto.repos.map((r) => r.repoId)).toEqual([web.id, api.id]);
    const [webSection, apiSection] = dto.repos;
    expect(webSection).toMatchObject({
      repoName: 'acme/web',
      pullRequest: { id: storyWeb.id, headRef: 'parent/story-web', headSha: HEAD },
      stale: false,
      fetchCommand: 'git fetch origin parent/story-web && git checkout parent/story-web',
      preview: { status: 'available', url: 'https://web-preview.example/items/ACME-1' },
      ci: { status: 'available' },
    });
    expect(apiSection).toMatchObject({
      repoName: 'acme/api',
      pullRequest: { id: childApi.id, headRef: 'subtask/child-api', headSha: null },
      fetchCommand: 'git fetch origin subtask/child-api && git checkout subtask/child-api',
      preview: { status: 'no_deployment_reported' },
      ci: { status: 'no_checks_reported' },
    });
  });

  it('a section whose repository has no pull request anywhere reads no_pull_request', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'No PR' });
    const web = await connectRepo(fx, 'web');
    await testInstructionsService.publish(
      {
        workItemId: card.id,
        bodyMd: 'A service only — no rendered surface.',
        repos: [{ repoId: web.id, commitSha: HEAD }],
      },
      fx.ctx,
    );
    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(dto.record).toMatchObject({
      bodyMd: 'A service only — no rendered surface.',
    });
    expect(dto.repos[0]).toMatchObject({ pullRequest: null, fetchCommand: null });
  });

  it('a CHILD with no record of its own answers tested_via_ancestor, naming the nearest ancestor that has one', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    const task = await createTestWorkItem(fx, { kind: 'task', title: 'Task', parentId: story.id });
    const leaf = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Leaf',
      parentId: task.id,
    });
    const web = await connectRepo(fx, 'web');
    const publish = (workItemId: string) =>
      testInstructionsService.publish(
        { workItemId, bodyMd: '## Open', repos: [{ repoId: web.id, commitSha: HEAD }] },
        fx.ctx,
      );
    await publish(story.id);
    expect(await howToTestService.getForWorkItem(leaf.id, fx.ctx)).toMatchObject({
      state: 'tested_via_ancestor',
      runTarget: { key: story.identifier },
      record: null,
      repos: [],
    });
    await publish(task.id);
    expect((await howToTestService.getForWorkItem(leaf.id, fx.ctx)).runTarget).toEqual({
      key: task.identifier,
    });
  });

  it('record_missing names the latest run that targeted OR carried the item as owedBy', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Owed' });
    await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run',
        startedAt: new Date('2026-09-01T08:00:00Z'),
        cards: { create: { workspaceId: fx.workspaceId, workItemId: story.id, position: 0 } },
      },
    });
    const scoped = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run_scope',
        scopeWorkItemId: story.id,
        startedAt: new Date('2026-09-13T12:04:00Z'),
      },
    });
    const dto = await howToTestService.getForWorkItem(story.id, fx.ctx);
    expect(dto.state).toBe('record_missing');
    expect(dto.owedBy).toEqual({ runId: scoped.id, label: 'motir run · 2026-09-13 12:04 UTC' });
  });

  it('record_missing never names a `fix` repair as owing the record — the delivering run behind it does (MOTIR-5460)', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Repaired' });
    const delivering = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run',
        startedAt: new Date('2026-09-01T08:00:00Z'),
        cards: { create: { workspaceId: fx.workspaceId, workItemId: card.id, position: 0 } },
      },
    });
    await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'fix',
        startedAt: new Date('2026-09-13T12:04:00Z'),
        cards: { create: { workspaceId: fx.workspaceId, workItemId: card.id, position: 0 } },
      },
    });
    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(dto.owedBy).toEqual({
      runId: delivering.id,
      label: 'motir run · 2026-09-01 08:00 UTC',
    });

    // A card only ever repaired owes nothing to name.
    const onlyFixed = await createTestWorkItem(fx, { kind: 'task', title: 'Only repaired' });
    await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'fix',
        cards: { create: { workspaceId: fx.workspaceId, workItemId: onlyFixed.id, position: 0 } },
      },
    });
    expect((await howToTestService.getForWorkItem(onlyFixed.id, fx.ctx)).owedBy).toBeNull();
  });

  it('names the run that wrote the current record, and lists earlier runs newest first', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Runs' });
    const web = await connectRepo(fx, 'web');
    const runs: string[] = [];
    for (const [n, at] of [
      [1, '2026-09-10T08:00:00Z'],
      [2, '2026-09-11T08:00:00Z'],
      [3, '2026-09-12T08:00:00Z'],
    ] as const) {
      const run = await adminDb.dispatchRun.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          command: 'run',
          status: 'running',
          startedAt: new Date(at),
          cards: { create: { workspaceId: fx.workspaceId, workItemId: card.id, position: 0 } },
        },
      });
      runs.push(run.id);
      await testInstructionsService.publish(
        {
          workItemId: card.id,
          bodyMd: `## Run ${n}`,
          repos: [{ repoId: web.id, commitSha: HEAD }],
          attributeToRunningDispatch: true,
        },
        fx.ctx,
      );
      await adminDb.dispatchRun.update({ where: { id: run.id }, data: { status: 'succeeded' } });
    }
    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(dto.record?.run).toEqual({ runId: runs[2], label: 'motir run · 2026-09-12 08:00 UTC' });
    expect(dto.record?.bodyMd).toBe('## Run 3');
    expect(dto.history.map((h) => h.run?.runId)).toEqual([runs[1], runs[0]]);
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

  it('issues the SAME number of reads for a 1-repository and a 3-repository record', async () => {
    const fx = await makeWorkItemFixture();
    // SEQUENTIAL, not `Promise.all`: every `connectRepo` upserts the SAME installation
    // row, and three concurrent upserts race on its unique `installationId` (P2002).
    const repos = [];
    for (const name of ['web', 'api', 'docs']) repos.push(await connectRepo(fx, name));
    const one = await createTestWorkItem(fx, { kind: 'story', title: 'One' });
    const three = await createTestWorkItem(fx, { kind: 'story', title: 'Three' });
    await linkedPr(fx, one.id, repos[0]!.id, 'feat/one', [
      { name: 'A', conclusion: 'success', sha: HEAD },
    ]);
    for (const [n, repo] of repos.entries()) {
      await linkedPr(fx, three.id, repo.id, `feat/three-${n}`, [
        { name: 'A', conclusion: 'success', sha: `${n + 1}`.repeat(40) },
      ]);
    }
    await testInstructionsService.publish(
      {
        workItemId: one.id,
        bodyMd: '## Go',
        repos: [{ repoId: repos[0]!.id, commitSha: HEAD }],
      },
      fx.ctx,
    );
    await testInstructionsService.publish(
      {
        workItemId: three.id,
        bodyMd: '## Go',
        repos: repos.map((r) => ({ repoId: r.id, commitSha: HEAD })),
      },
      fx.ctx,
    );

    const spies = [
      vi.spyOn(workItemDeliveryRepository, 'listByWorkItemsWithChecks'),
      vi.spyOn(testInstructionsRepository, 'listHistoryForWorkItem'),
      vi.spyOn(testInstructionsRepository, 'listCurrentByWorkItems'),
      vi.spyOn(repoDeploymentRepository, 'listLatestByCommits'),
      vi.spyOn(repoDeploymentRepository, 'listLatestByRefs'),
      vi.spyOn(dispatchRunRepository, 'listByWorkItem'),
      vi.spyOn(dispatchRunRepository, 'listByScope'),
    ];
    const count = () => spies.reduce((sum, s) => sum + s.mock.calls.length, 0);

    await howToTestService.getForWorkItem(one.id, fx.ctx);
    const forOne = count();
    spies.forEach((s) => s.mockClear());
    const dto = await howToTestService.getForWorkItem(three.id, fx.ctx);
    const forThree = count();

    expect(dto.repos).toHaveLength(3);
    expect(forThree).toBe(forOne);
  });
});

// ── WHO wrote it (Story MOTIR-5450 · Subtask MOTIR-5454) ──────────────────────
//
// `approval-gates.md` §9's 2026-09-17 amendment, point 1: TWO AUTHOR KINDS, ONE
// RECORD, ONE WRITER. The cases are chosen so a plausible broken implementation
// fails:
//
//   - the person case asserts `record.run` is STILL null beside a filled
//     `author`, so an implementation that quietly repurposed `run` fails;
//   - the history case carries one row of EACH kind, so a mapper that reads the
//     current record's author and reuses it fails;
//   - the deleted-publisher case asserts a non-empty label with a null userId,
//     so returning the raw (null) name — or an empty string — fails.

describe('howToTestService — the record carries its AUTHOR', () => {
  it("a PERSON's record: kind person, their id and display name, with `run` still null", async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'By a person' });
    const web = await connectRepo(fx, 'web');
    await testInstructionsService.publish(
      { workItemId: card.id, bodyMd: BODY, repos: [{ repoId: web.id, commitSha: HEAD }] },
      fx.ctx,
    );
    const actor = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ctx.userId } });

    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(dto.record?.author).toEqual({
      kind: 'person',
      userId: fx.ctx.userId,
      label: actor.name,
    });
    // The superseded field is untouched — the DOORS card removes it, not this one.
    expect(dto.record?.run).toBeNull();
  });

  it("a RUN's record: kind run, the run id, and the label `run` already carried", async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'By a run' });
    const web = await connectRepo(fx, 'web');
    const startedAt = new Date('2026-09-17T12:04:00Z');
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run',
        status: 'running',
        startedAt,
        cards: { create: { workspaceId: fx.workspaceId, workItemId: card.id, position: 0 } },
      },
    });
    await testInstructionsService.publish(
      {
        workItemId: card.id,
        bodyMd: BODY,
        repos: [{ repoId: web.id, commitSha: HEAD }],
        attributeToRunningDispatch: true,
      },
      fx.ctx,
    );

    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    const label = dispatchRunLabel('run', startedAt);
    expect(dto.record?.author).toEqual({ kind: 'run', runId: run.id, label });
    expect(dto.record?.run).toEqual({ runId: run.id, label });
  });

  it('HISTORY carries an author per row — one of each kind, newest first', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Both kinds' });
    const web = await connectRepo(fx, 'web');
    const startedAt = new Date('2026-09-17T12:04:00Z');
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run',
        status: 'running',
        startedAt,
        cards: { create: { workspaceId: fx.workspaceId, workItemId: card.id, position: 0 } },
      },
    });
    // The run wrote it first; a person then corrected it.
    await testInstructionsService.publish(
      {
        workItemId: card.id,
        bodyMd: BODY,
        repos: [{ repoId: web.id, commitSha: HEAD }],
        attributeToRunningDispatch: true,
      },
      fx.ctx,
    );
    await testInstructionsService.publish(
      {
        workItemId: card.id,
        bodyMd: `${BODY}\n\nCorrected.`,
        repos: [{ repoId: web.id, commitSha: HEAD }],
      },
      fx.ctx,
    );
    const actor = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ctx.userId } });

    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(dto.record?.author).toEqual({
      kind: 'person',
      userId: fx.ctx.userId,
      label: actor.name,
    });
    expect(dto.history).toHaveLength(1);
    expect(dto.history[0]!.author).toEqual({
      kind: 'run',
      runId: run.id,
      label: dispatchRunLabel('run', startedAt),
    });
  });

  it('a DELETED publisher is named, never left blank — userId null, the former-member label', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Author gone' });
    const web = await connectRepo(fx, 'web');

    const author = await usersService.createUser({
      email: 'gone@ex.com',
      password: 'hunter2hunter2',
      name: 'Gone',
    });
    await workspacesService.addMember({ userId: author.id, workspaceId: fx.workspaceId });
    await projectMembersService.addMember({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: author.id,
      role: 'member',
    });
    await testInstructionsService.publish(
      { workItemId: card.id, bodyMd: BODY, repos: [{ repoId: web.id, commitSha: HEAD }] },
      { userId: author.id, workspaceId: fx.workspaceId },
    );

    // `published_by_id` is SetNull, so deleting the account leaves the record
    // with no id to look a name up by — which is the case the label must cover.
    await adminDb.user.delete({ where: { id: author.id } });

    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(dto.record?.author).toEqual({
      kind: 'person',
      userId: null,
      label: ERASED_USER_NAME,
    });
    expect(dto.record?.author.label).not.toBe('');
  });

  it('resolves every publisher in ONE query, whatever the number of versions', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Many versions' });
    const web = await connectRepo(fx, 'web');
    for (let i = 0; i < 5; i++) {
      await testInstructionsService.publish(
        {
          workItemId: card.id,
          bodyMd: `${BODY}\n\nv${i}`,
          repos: [{ repoId: web.id, commitSha: HEAD }],
        },
        fx.ctx,
      );
    }
    const spy = vi.spyOn(userRepository, 'findByIds');
    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(dto.history).toHaveLength(4);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
