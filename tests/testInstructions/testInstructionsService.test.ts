import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import {
  normalizeTestInstructionsContent,
  testInstructionsService,
  translateTestInstructionsConflict,
  type PublishTestInstructionsInput,
  type PublishTestInstructionsRepoInput,
} from '@/lib/services/testInstructionsService';
import { testInstructionsRepository } from '@/lib/repositories/testInstructionsRepository';
import {
  TEST_INSTRUCTIONS_MAX_COMMAND_CHARS,
  TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES,
  TEST_INSTRUCTIONS_MAX_REPOS,
  TEST_INSTRUCTIONS_MAX_SETUP_COMMANDS,
  TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS,
  TEST_INSTRUCTIONS_MAX_STEP_CHARS,
  TEST_INSTRUCTIONS_MAX_STEPS,
} from '@/lib/testInstructions/caps';
import {
  TestInstructionsCapExceededError,
  TestInstructionsClickPathError,
  TestInstructionsConflictError,
  TestInstructionsInvalidFieldError,
  TestInstructionsRepoNotInProjectError,
  TestInstructionsWorkItemNotFoundError,
} from '@/lib/testInstructions/errors';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { toTestInstructionsDto } from '@/lib/mappers/testInstructionsMappers';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { Prisma as PrismaNs } from '@/generated/prisma/client';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { organizationIdOf } from '../helpers/organizationOf';
import { randomToken } from '../helpers/random';

// testInstructionsService (Story MOTIR-4906 · Subtask MOTIR-5328 — HOW TO TEST
// per RUN on the run target) against a REAL Postgres. The cases are chosen so a
// plausible broken implementation fails:
//
//   - the concurrency case races the target's FIRST publish, where there is no
//     current row to lock — a `design_evidence`-style lock on the current row
//     lets both inserts through and one dies on the partial unique index;
//   - the two-repository case asserts ONE record with TWO sections, so a
//     per-repository key (the superseded shape) fails it;
//   - the idempotency case asserts the ROW COUNT, not only the returned id;
//   - the permission case uses a CUSTOM role that can browse but not edit, so a
//     browse-only gate would pass it and fail the test.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectRepo(fx: WorkItemFixture, name: string, link = true): Promise<string> {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}` },
    create: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
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
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  if (link) {
    await linkProjectRepo({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      githubRepoId: repo.id,
      name,
    });
  }
  return repo.id;
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function input(
  workItemId: string,
  repoId: string,
  over: Partial<PublishTestInstructionsInput> = {},
): PublishTestInstructionsInput {
  return {
    workItemId,
    clickPathSteps: ['Open /items/ACME-7', 'Scroll to How to test'],
    previewPath: '/items/ACME-7',
    preconditionMd: 'Sign in as a project **member**.',
    repos: [section(repoId)],
    ...over,
  };
}

function section(
  repoId: string,
  over: Partial<PublishTestInstructionsRepoInput> = {},
): PublishTestInstructionsRepoInput {
  return {
    repoId,
    commitSha: SHA_A,
    setupCommands: [
      { label: 'Install', command: 'pnpm install --frozen-lockfile' },
      { label: 'Run', command: 'pnpm dev' },
    ],
    ...over,
  };
}

async function runningRunFor(fx: WorkItemFixture, workItemId: string): Promise<string> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run',
      status: 'running',
      cards: { create: { workspaceId: fx.workspaceId, workItemId, position: 0 } },
    },
  });
  return run.id;
}

async function finish(runId: string): Promise<void> {
  await adminDb.dispatchRun.update({ where: { id: runId }, data: { status: 'succeeded' } });
}

async function rowsFor(workItemId: string) {
  return adminDb.testInstructions.findMany({
    where: { workItemId },
    include: { repos: { orderBy: { position: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
}

describe('testInstructionsService.publish', () => {
  it('writes ONE record for a two-repository run — one current row, two sections in order', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'A story run' });
    const web = await connectRepo(fx, 'web');
    const api = await connectRepo(fx, 'api');

    const { record, created } = await testInstructionsService.publish(
      input(story.id, web, {
        repos: [section(web), section(api, { commitSha: SHA_B, setupCommands: [] })],
      }),
      fx.ctx,
    );
    expect(created).toBe(true);
    expect(record).toMatchObject({
      workItemId: story.id,
      clickPathSteps: ['Open /items/ACME-7', 'Scroll to How to test'],
      clickPathNotApplicable: false,
      previewPath: '/items/ACME-7',
      publishedById: fx.ctx.userId,
      dispatchRunId: null,
      isCurrent: true,
    });
    expect(record.repos).toEqual([
      {
        repoId: web,
        commitSha: SHA_A,
        setupCommands: [
          { label: 'Install', command: 'pnpm install --frozen-lockfile' },
          { label: 'Run', command: 'pnpm dev' },
        ],
      },
      { repoId: api, commitSha: SHA_B, setupCommands: [] },
    ]);

    const rows = await rowsFor(story.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repos.map((r) => r.repoId)).toEqual([web, api]);
  });

  it('a LATER RUN supersedes: exactly one current record, and the earlier run stays as history', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Two runs' });
    const repoId = await connectRepo(fx, 'web');

    const run1 = await runningRunFor(fx, card.id);
    const first = await testInstructionsService.publish(
      input(card.id, repoId, { attributeToRunningDispatch: true }),
      fx.ctx,
    );
    expect(first.record.dispatchRunId).toBe(run1);
    await finish(run1);

    const run2 = await runningRunFor(fx, card.id);
    // Identical content — but a DIFFERENT run, so it is a new version, not a retry.
    const second = await testInstructionsService.publish(
      input(card.id, repoId, { attributeToRunningDispatch: true }),
      fx.ctx,
    );
    expect(second.created).toBe(true);
    expect(second.record.dispatchRunId).toBe(run2);

    const rows = await rowsFor(card.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isCurrent).map((r) => r.dispatchRunId)).toEqual([run2]);

    const history = await withWorkspaceContext(fx.ctx, (tx) =>
      testInstructionsRepository.listHistoryForWorkItem(card.id, tx),
    );
    expect(history.map((r) => r.dispatchRunId)).toEqual([run2, run1]);
  });

  it('is idempotent PER RUN: identical content twice from the same run stores ONE row', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Retry' });
    const repoId = await connectRepo(fx, 'web');
    await runningRunFor(fx, card.id);

    const a = await testInstructionsService.publish(
      input(card.id, repoId, { attributeToRunningDispatch: true }),
      fx.ctx,
    );
    // Whitespace and case differences normalise to the same content.
    const b = await testInstructionsService.publish(
      input(card.id, repoId, {
        attributeToRunningDispatch: true,
        clickPathSteps: ['  Open /items/ACME-7 ', 'Scroll to How to test'],
        repos: [section(repoId, { commitSha: SHA_A.toUpperCase() })],
      }),
      fx.ctx,
    );

    expect(b.created).toBe(false);
    expect(b.record.id).toBe(a.record.id);
    expect(await rowsFor(card.id)).toHaveLength(1);
  });

  it('different content from the SAME run becomes the new current record', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Amend' });
    const repoId = await connectRepo(fx, 'web');

    await testInstructionsService.publish(input(card.id, repoId), fx.ctx);
    const amended = await testInstructionsService.publish(
      input(card.id, repoId, { repos: [section(repoId, { commitSha: SHA_B })] }),
      fx.ctx,
    );

    expect(amended.created).toBe(true);
    const rows = await rowsFor(card.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isCurrent).map((r) => r.id)).toEqual([amended.record.id]);
  });

  it('stores a not-applicable click-path with its reason', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Backend only' });
    const repoId = await connectRepo(fx, 'api');

    const { record } = await testInstructionsService.publish(
      input(card.id, repoId, {
        clickPathSteps: [],
        clickPathNotApplicable: true,
        clickPathNotApplicableReason: 'no rendered surface changed: a service and its tests',
        previewPath: null,
      }),
      fx.ctx,
    );
    expect(record.clickPathSteps).toEqual([]);
    expect(record.clickPathNotApplicable).toBe(true);
    expect(record.clickPathNotApplicableReason).toBe(
      'no rendered surface changed: a service and its tests',
    );
  });

  it('resolves a section named by `name` or `owner/name`', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'By name' });
    const web = await connectRepo(fx, 'web');
    const api = await connectRepo(fx, 'api');

    const { record } = await testInstructionsService.publish(
      input(card.id, web, {
        repos: [
          { repoRef: 'WEB', commitSha: SHA_A },
          { repoRef: 'moooon/api', commitSha: SHA_B },
        ],
      }),
      fx.ctx,
    );
    expect(record.repos.map((r) => r.repoId)).toEqual([web, api]);
  });

  it('refuses a repository that is not one of the project repositories, naming the valid set', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Wrong repo' });
    await connectRepo(fx, 'web');
    const stray = await connectRepo(fx, 'not-in-project', false);

    const err = await testInstructionsService
      .publish(input(card.id, stray), fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TestInstructionsRepoNotInProjectError);
    expect((err as TestInstructionsRepoNotInProjectError).code).toBe(
      'TEST_INSTRUCTIONS_REPO_NOT_IN_PROJECT',
    );
    expect((err as TestInstructionsRepoNotInProjectError).validRepos).toEqual(['moooon/web']);
    expect(await rowsFor(card.id)).toHaveLength(0);
  });

  it('refuses the same repository named twice — by id and by name', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Duplicate' });
    const web = await connectRepo(fx, 'web');

    const err = await testInstructionsService
      .publish(
        input(card.id, web, { repos: [section(web), { repoRef: 'web', commitSha: SHA_B }] }),
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TestInstructionsInvalidFieldError);
    expect((err as TestInstructionsInvalidFieldError).field).toBe('repos[1].repo');
    expect(await rowsFor(card.id)).toHaveLength(0);
  });

  it('refuses an unknown work item', async () => {
    const fx = await makeWorkItemFixture();
    const repoId = await connectRepo(fx, 'web');
    await expect(
      testInstructionsService.publish(input('does-not-exist', repoId), fx.ctx),
    ).rejects.toBeInstanceOf(TestInstructionsWorkItemNotFoundError);
  });

  it('refuses an actor whose CUSTOM role can browse but lacks work_item:edit', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Guarded' });
    const repoId = await connectRepo(fx, 'web');

    const viewer = await usersService.createUser({
      email: 'viewer@ex.com',
      password: 'hunter2hunter2',
      name: 'Viewer',
    });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    const browseOnly = await projectRoleDefinitionService.create({
      projectId: fx.projectId,
      ctx: fx.ctx,
      name: 'Browse only',
      permissions: ['project:browse', 'comment:add'],
    });
    await projectMembersService.addMember({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: viewer.id,
      role: 'member',
    });
    await projectMembersService.setRole({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: viewer.id,
      role: browseOnly.id,
    });
    const viewerCtx = { userId: viewer.id, workspaceId: fx.workspaceId };

    // The control: the same actor CAN read, so the refusal below is about edit.
    await expect(
      testInstructionsService.getCurrentForWorkItem(card.id, viewerCtx),
    ).resolves.toBeNull();

    const err = await testInstructionsService
      .publish(input(card.id, repoId), viewerCtx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permission).toBe('work_item:edit');
    expect(await rowsFor(card.id)).toHaveLength(0);
  });

  it('two concurrent FIRST publishes for one target both resolve, and exactly one record ends current with all its sections', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'story', title: 'Race' });
    const web = await connectRepo(fx, 'web');
    const api = await connectRepo(fx, 'api');

    const left = input(card.id, web, {
      clickPathSteps: ['Left step'],
      repos: [section(web), section(api)],
    });
    const right = input(card.id, web, { clickPathSteps: ['Right step'] });

    // Separate pooled connections — each publish opens its own transaction.
    const results = await Promise.all([
      testInstructionsService.publish(left, fx.ctx),
      testInstructionsService.publish(right, fx.ctx),
    ]);
    expect(results.every((r) => r.created)).toBe(true);

    const current = (await rowsFor(card.id)).filter((r) => r.isCurrent);
    expect(current).toHaveLength(1);
    const winner = current[0]!;
    if (JSON.stringify(winner.clickPathSteps) === JSON.stringify(['Left step'])) {
      expect(winner.repos.map((r) => r.repoId)).toEqual([web, api]);
    } else {
      expect(winner.clickPathSteps).toEqual(['Right step']);
      expect(winner.repos.map((r) => r.repoId)).toEqual([web]);
    }
  });
});

describe('normalizeTestInstructionsContent — every cap is a typed refusal naming the field', () => {
  const base = input('wi', 'repo');
  const long = (n: number) => 'x'.repeat(n);
  const withSection = (over: Partial<PublishTestInstructionsRepoInput>) => ({
    repos: [section('repo', over)],
  });

  const cases: Array<[string, Partial<PublishTestInstructionsInput>, string]> = [
    [
      'too many steps',
      { clickPathSteps: Array.from({ length: TEST_INSTRUCTIONS_MAX_STEPS + 1 }, () => 'step') },
      'clickPathSteps',
    ],
    [
      'a step too long',
      { clickPathSteps: [long(TEST_INSTRUCTIONS_MAX_STEP_CHARS + 1)] },
      'clickPathSteps[0]',
    ],
    [
      'too many repository sections',
      {
        repos: Array.from({ length: TEST_INSTRUCTIONS_MAX_REPOS + 1 }, (_, i) =>
          section(`repo-${i}`),
        ),
      },
      'repos',
    ],
    [
      'too many setup commands',
      withSection({
        setupCommands: Array.from({ length: TEST_INSTRUCTIONS_MAX_SETUP_COMMANDS + 1 }, () => ({
          label: 'l',
          command: 'c',
        })),
      }),
      'repos[0].setupCommands',
    ],
    [
      'a label too long',
      withSection({
        setupCommands: [{ label: long(TEST_INSTRUCTIONS_MAX_STEP_CHARS + 1), command: 'c' }],
      }),
      'repos[0].setupCommands[0].label',
    ],
    [
      'a command too long',
      withSection({
        setupCommands: [{ label: 'l', command: long(TEST_INSTRUCTIONS_MAX_COMMAND_CHARS + 1) }],
      }),
      'repos[0].setupCommands[0].command',
    ],
    [
      'a precondition over 8 KiB',
      { preconditionMd: long(TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES + 1) },
      'preconditionMd',
    ],
    [
      'a not-applicable reason too long',
      {
        clickPathSteps: [],
        clickPathNotApplicable: true,
        clickPathNotApplicableReason: long(TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS + 1),
      },
      'clickPathNotApplicableReason',
    ],
    [
      'a preview path too long',
      { previewPath: `/${long(TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS)}` },
      'previewPath',
    ],
  ];

  it.each(cases)('%s', (_label, over, field) => {
    let err: unknown;
    try {
      normalizeTestInstructionsContent({ ...base, ...over });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TestInstructionsCapExceededError);
    expect((err as TestInstructionsCapExceededError).field).toBe(field);
    expect((err as TestInstructionsCapExceededError).code).toBe('TEST_INSTRUCTIONS_CAP_EXCEEDED');
  });

  it('counts the precondition cap in UTF-8 bytes, not characters', () => {
    // 3 bytes per character: under the cap in characters, over it in bytes.
    const multibyte = '界'.repeat(Math.floor(TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES / 3) + 1);
    expect(multibyte.length).toBeLessThan(TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES);
    expect(() => normalizeTestInstructionsContent({ ...base, preconditionMd: multibyte })).toThrow(
      TestInstructionsCapExceededError,
    );
  });

  it('accepts every field exactly AT its cap', () => {
    expect(() =>
      normalizeTestInstructionsContent({
        ...base,
        clickPathSteps: Array.from({ length: TEST_INSTRUCTIONS_MAX_STEPS }, () =>
          long(TEST_INSTRUCTIONS_MAX_STEP_CHARS),
        ),
        repos: Array.from({ length: TEST_INSTRUCTIONS_MAX_REPOS }, (_, i) =>
          section(`repo-${i}`, {
            setupCommands: Array.from({ length: TEST_INSTRUCTIONS_MAX_SETUP_COMMANDS }, () => ({
              label: long(TEST_INSTRUCTIONS_MAX_STEP_CHARS),
              command: long(TEST_INSTRUCTIONS_MAX_COMMAND_CHARS),
            })),
          }),
        ),
        preconditionMd: long(TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES),
        previewPath: `/${long(TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS - 1)}`,
      }),
    ).not.toThrow();
  });

  it.each([
    ['both steps and not-applicable', { clickPathNotApplicable: true }, 'both'],
    ['neither', { clickPathSteps: [], clickPathNotApplicable: false }, 'neither'],
    [
      'not-applicable without a reason',
      { clickPathSteps: [], clickPathNotApplicable: true, clickPathNotApplicableReason: '  ' },
      'reason_missing',
    ],
  ] as const)('refuses a click-path with %s', (_label, over, reason) => {
    let err: unknown;
    try {
      normalizeTestInstructionsContent({ ...base, ...over });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TestInstructionsClickPathError);
    expect((err as TestInstructionsClickPathError).reason).toBe(reason);
  });

  it.each([
    ['no repository sections', { repos: [] }, 'repos'],
    ['a non-hex commit sha', withSection({ commitSha: 'not-a-sha' }), 'repos[0].commitSha'],
    ['an empty step', { clickPathSteps: ['ok', '   '] }, 'clickPathSteps[1]'],
    [
      'a setup command with no label',
      withSection({ setupCommands: [{ label: '', command: 'x' }] }),
      'repos[0].setupCommands[0]',
    ],
    ['a section naming no repository', { repos: [{ commitSha: SHA_A }] }, 'repos[0].repo'],
    [
      'a section naming a repository twice over',
      { repos: [{ repoId: 'r', repoRef: 'web', commitSha: SHA_A }] },
      'repos[0].repo',
    ],
    ['a preview URL instead of a path', { previewPath: 'https://evil.example/' }, 'previewPath'],
    ['a protocol-relative preview path', { previewPath: '//evil.example/x' }, 'previewPath'],
  ] as const)('refuses %s', (_label, over, field) => {
    let err: unknown;
    try {
      normalizeTestInstructionsContent({
        ...base,
        ...(over as Partial<PublishTestInstructionsInput>),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TestInstructionsInvalidFieldError);
    expect((err as TestInstructionsInvalidFieldError).field).toBe(field);
  });
});

describe('translateTestInstructionsConflict', () => {
  it('maps a P2002 to the typed conflict and passes anything else through', () => {
    const p2002 = new PrismaNs.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    expect(translateTestInstructionsConflict(p2002, 'wi')).toBeInstanceOf(
      TestInstructionsConflictError,
    );
    const other = new Error('boom');
    expect(translateTestInstructionsConflict(other, 'wi')).toBe(other);
  });
});

describe('testInstructionsRepository.listCurrentByWorkItems', () => {
  function countingTx(tx: Prisma.TransactionClient, onCall: () => void): Prisma.TransactionClient {
    return new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'testInstructions') return value;
        return new Proxy(value as object, {
          get(delegate, method, r) {
            const fn = Reflect.get(delegate, method, r);
            if (typeof fn !== 'function') return fn;
            return (...args: unknown[]) => {
              onCall();
              return (fn as (...a: unknown[]) => unknown).apply(delegate, args);
            };
          },
        });
      },
    }) as Prisma.TransactionClient;
  }

  it('returns every current record WITH its sections for a batch, in one repository call independent of batch size', async () => {
    const fx = await makeWorkItemFixture();
    const web = await connectRepo(fx, 'web');
    const api = await connectRepo(fx, 'api');
    const cards = await Promise.all(
      [1, 2, 3].map((n) => createTestWorkItem(fx, { kind: 'task', title: `Card ${n}` })),
    );
    for (const card of cards) {
      await testInstructionsService.publish(
        input(card.id, web, { repos: [section(web), section(api)] }),
        fx.ctx,
      );
      // A superseded version per card, which the batch must NOT return.
      await testInstructionsService.publish(
        input(card.id, web, { repos: [section(web, { commitSha: SHA_B })] }),
        fx.ctx,
      );
    }

    const queryCount = async (ids: string[]) =>
      withWorkspaceContext(fx.ctx, async (tx) => {
        let calls = 0;
        const out = await testInstructionsRepository.listCurrentByWorkItems(
          ids,
          countingTx(tx, () => (calls += 1)),
        );
        return { calls, out };
      });

    const one = await queryCount([cards[0]!.id]);
    const three = await queryCount(cards.map((c) => c.id));
    expect(one.calls).toBe(1);
    expect(three.calls).toBe(one.calls);

    expect(three.out).toHaveLength(3);
    expect(three.out.every((r) => r.isCurrent)).toBe(true);
    expect(three.out.every((r) => r.repos.length === 1 && r.repos[0]!.commitSha === SHA_B)).toBe(
      true,
    );
  });

  it('short-circuits an empty batch without a round trip', async () => {
    const fx = await makeWorkItemFixture();
    const rows = await withWorkspaceContext(fx.ctx, (tx) =>
      testInstructionsRepository.listCurrentByWorkItems([], tx),
    );
    expect(rows).toEqual([]);
  });
});

describe('toTestInstructionsDto', () => {
  it('drops malformed JSON entries rather than handing a component a non-string, and orders sections by position', () => {
    const now = new Date('2026-09-13T00:00:00Z');
    const repo = (repoId: string, position: number, setupCommands: unknown) => ({
      id: `s-${repoId}`,
      workspaceId: 'ws',
      projectId: 'p',
      testInstructionsId: 'id',
      repoId,
      commitSha: SHA_A,
      setupCommands: setupCommands as PrismaNs.JsonValue,
      position,
    });
    const row = {
      id: 'id',
      workspaceId: 'ws',
      projectId: 'p',
      workItemId: 'wi',
      clickPathSteps: ['ok', 7, null] as unknown as PrismaNs.JsonValue,
      clickPathNotApplicable: false,
      clickPathNotApplicableReason: null,
      previewPath: null,
      preconditionMd: null,
      dispatchRunId: null,
      publishedById: null,
      isCurrent: true,
      createdAt: now,
      repos: [
        repo('second', 1, null),
        repo('first', 0, [{ label: 'Install', command: 'pnpm i' }, { label: 'broken' }, 'nope']),
      ],
    };
    const dto = toTestInstructionsDto(row);
    expect(dto.clickPathSteps).toEqual(['ok']);
    expect(dto.repos.map((r) => r.repoId)).toEqual(['first', 'second']);
    expect(dto.repos[0]!.setupCommands).toEqual([{ label: 'Install', command: 'pnpm i' }]);
    expect(dto.repos[1]!.setupCommands).toEqual([]);
    expect(dto.createdAt).toBe(now.toISOString());
  });
});
