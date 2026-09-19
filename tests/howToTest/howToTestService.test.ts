import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import { howToTestService, dispatchRunLabel } from '@/lib/services/howToTestService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { testInstructionsRepository } from '@/lib/repositories/testInstructionsRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { ERASED_USER_NAME } from '@/lib/users/accountErasure';
import { derivePrCiState } from '@/lib/github/prCiState';
import {
  liveHeadSha,
  pickPullRequest,
  staleSections,
  type HowToTestPullRequestInput,
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
//   - the PURE assembly — since MOTIR-5691 only STALE is derived (design/github
//     § 25), so this is the binding and the head rule it rests on;
//   - the SERVICE on real Postgres, where a story's sections must bind to the
//     story's own session pull requests before a child's, a child with no record
//     must point at its run target, the head must be the one `prCiState` names,
//     and the query count must not grow with the number of repositories.
//
// ⚠️ THE PREVIEW, THE FETCH LINE AND THE CHECKS ARE GONE, with the sub-block that
// drew them. So is `repoDeploymentRepository`'s read pair: a read of How to test
// touches no deployment row, and the query-count case below would catch one that
// came back.

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

function pr(over: Partial<HowToTestPullRequestInput> = {}): HowToTestPullRequestInput {
  return {
    id: 'pr-1',
    repoId: 'repo-1',
    state: 'open',
    checkRuns: [check('Vitest', 'success'), check('Lint', 'failure')],
    ...over,
  };
}

const nameOf = (id: string) => (id === 'repo-1' ? 'acme/web' : `name-of-${id}`);

describe('staleSections — the one derived fact (design/github § 25, Panel 12g)', () => {
  it('a section written for the head is not stale', () => {
    expect(staleSections([section()], [pr()], [], nameOf)).toEqual([]);
  });

  it('a section written for an older commit is stale, named by repository and both commits', () => {
    expect(staleSections([section({ commitSha: OLD })], [pr()], [], nameOf)).toEqual([
      { repoName: 'acme/web', recordSha: OLD, headSha: HEAD },
    ]);
  });

  it('a section written against an ABBREVIATED sha of the head is not stale', () => {
    expect(staleSections([section({ commitSha: HEAD.slice(0, 7) })], [pr()], [], nameOf)).toEqual(
      [],
    );
  });

  it('a section with no bound pull request, or one with no reported head, cannot be stale', () => {
    expect(staleSections([section({ commitSha: OLD })], [], [], nameOf)).toEqual([]);
    expect(
      staleSections([section({ commitSha: OLD })], [pr({ checkRuns: [] })], [], nameOf),
    ).toEqual([]);
  });

  it("binds the run target's OWN pull request before a descendant's, per repository, in the record's order", () => {
    const sections = [section({ repoId: 'repo-2', commitSha: OLD }), section({ commitSha: OLD })];
    const own = [pr({ id: 'own-web', checkRuns: [check('A', 'success', OLD)] })];
    const descendants = [
      pr({ id: 'child-web', checkRuns: [check('A', 'success', HEAD)] }),
      pr({ id: 'child-api', repoId: 'repo-2', checkRuns: [check('A', 'success', HEAD)] }),
    ];
    // web binds to the target's own pull request, which is AT the section's commit —
    // so it is not stale although a descendant's pull request in web moved on. api
    // falls back to the child's, which did move.
    expect(staleSections(sections, own, descendants, nameOf)).toEqual([
      { repoName: 'name-of-repo-2', recordSha: OLD, headSha: HEAD },
    ]);
  });

  it('the head is the one prCiState judges — across a re-run and an older sha', () => {
    const rows = [
      check('Vitest', 'failure', OLD, '2026-09-13T09:00:00Z', 'old'),
      check('Vitest', 'failure', HEAD, '2026-09-13T10:00:00Z', 'run-1'),
      check('Vitest', 'success', HEAD, '2026-09-13T10:05:00Z', 'run-2'),
    ];
    expect(liveHeadSha(rows)).toBe(HEAD);
    expect(derivePrCiState(rows)).toBe('passing');
    expect(liveHeadSha([])).toBeNull();
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

describe('dispatchRunLabel', () => {
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
      stale: [],
      history: [],
    });
  });

  // ⚠️ A BODY-ONLY RECORD IS A RECORD (MOTIR-5689), not a missing one. The read
  // branches on whether a row EXISTS, never on how many sections it carries, and
  // this pins that: the card is given a CONNECTED repository and a LINKED pull
  // request, so an implementation that answered `record_missing` on an empty
  // section list — or that filled the list from the deliveries — fails here.
  it('a record with NO repository sections is `record`, with an empty `stale` — not `record_missing`', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Body only' });
    const web = await connectRepo(fx, 'web');
    await linkedPr(fx, card.id, web.id, 'subtask/body-only', [
      { name: 'Vitest', conclusion: 'success', sha: HEAD },
    ]);
    await testInstructionsService.publish(
      { workItemId: card.id, bodyMd: BODY, previewPath: '/items/ACME-1', repos: [] },
      fx.ctx,
    );

    // A record with no sections can never be stale, so the three reads that only
    // exist to answer that are not made (MOTIR-5691).
    const deliveries = vi.spyOn(workItemDeliveryRepository, 'listByWorkItemsWithChecks');
    const projectRepos = vi.spyOn(projectRepoRepository, 'listByProject');
    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(dto.state).toBe('record');
    expect(dto.stale).toEqual([]);
    expect(dto.record?.bodyMd).toBe(BODY);
    expect(dto.record?.previewPath).toBe('/items/ACME-1');
    expect(deliveries).not.toHaveBeenCalled();
    expect(projectRepos).not.toHaveBeenCalled();
  });

  it("a STORY run: sections bind to the story's own session pull requests first, and only a MOVED one is stale", async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story run' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'A child',
      parentId: story.id,
    });
    const web = await connectRepo(fx, 'web');
    const api = await connectRepo(fx, 'api');
    // A child's own per-card pull request in web, at an OLDER head — it must NOT win
    // over the story's, or web would read stale.
    await linkedPr(fx, child.id, web.id, 'subtask/child-web', [
      { name: 'Vitest', conclusion: 'failure', sha: OLD },
    ]);
    await linkedPr(fx, story.id, web.id, 'parent/story-web', [
      { name: 'Vitest', conclusion: 'success', sha: HEAD },
    ]);
    // api has no pull request on the story — the child's is the fallback, and it has
    // moved past the commit the api section was written for.
    await linkedPr(fx, child.id, api.id, 'subtask/child-api', [
      { name: 'Vitest', conclusion: 'success', sha: HEAD },
    ]);
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

    const dto = await howToTestService.getForWorkItem(story.id, fx.ctx);
    expect(dto.state).toBe('record');
    expect(dto.record).toMatchObject({
      // No dispatch run published it, so the author is the PERSON who did — the
      // case the deleted `run: null` could not tell apart from a pruned run.
      author: { kind: 'person' },
      bodyMd: BODY,
      previewPath: '/items/ACME-1',
    });
    expect(dto.stale).toEqual([{ repoName: 'acme/api', recordSha: OLD, headSha: HEAD }]);
    // The retired per-repository shape is not on the wire in any form.
    expect(Object.keys(dto).sort()).toEqual(
      ['history', 'owedBy', 'record', 'runTarget', 'stale', 'state'].sort(),
    );
    expect(JSON.stringify(dto)).not.toMatch(/fetchCommand|preview"|"ci"|git fetch/);
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
    // A section no pull request carries has no head to have moved past.
    expect(dto.stale).toEqual([]);
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
      stale: [],
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
    expect(dto.record?.author).toEqual({
      kind: 'run',
      runId: runs[2],
      label: 'motir run · 2026-09-12 08:00 UTC',
    });
    expect(dto.record?.bodyMd).toBe('## Run 3');
    expect(dto.history.map((h) => (h.author.kind === 'run' ? h.author.runId : null))).toEqual([
      runs[1],
      runs[0],
    ]);
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
      vi.spyOn(projectRepoRepository, 'listByProject'),
      vi.spyOn(dispatchRunRepository, 'listByWorkItem'),
      vi.spyOn(dispatchRunRepository, 'listByScope'),
    ];
    const count = () => spies.reduce((sum, s) => sum + s.mock.calls.length, 0);

    await howToTestService.getForWorkItem(one.id, fx.ctx);
    const forOne = count();
    spies.forEach((s) => s.mockClear());
    const dto = await howToTestService.getForWorkItem(three.id, fx.ctx);
    const forThree = count();

    // Every one of the three moved past HEAD — and still no extra read.
    expect(dto.stale).toHaveLength(3);
    expect(forThree).toBe(forOne);
  });
});

// ── WHO wrote it (Story MOTIR-5450 · Subtask MOTIR-5454) ──────────────────────
//
// `approval-gates.md` §9's 2026-09-17 amendment, point 1: TWO AUTHOR KINDS, ONE
// RECORD, ONE WRITER. The cases are chosen so a plausible broken implementation
// fails:
//
//   - the person case asserts the record carries NO `run` property at all
//     beside a filled `author` — MOTIR-5455 deleted the superseded field, so an
//     implementation that reintroduced it, or repurposed it, fails;
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
    // ⚠️ `author` is the ONLY thing that names the writer now: MOTIR-5455 deleted
    // the superseded `run` field, whose null was indistinguishable between a
    // person's record and an agent record whose run was pruned.
    expect(dto.record).not.toHaveProperty('run');
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
    expect(dto.record).not.toHaveProperty('run');
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
