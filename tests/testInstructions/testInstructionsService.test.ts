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
import { testInstructionsRepoRepository } from '@/lib/repositories/testInstructionsRepoRepository';
import {
  TEST_INSTRUCTIONS_MAX_BODY_BYTES,
  TEST_INSTRUCTIONS_MAX_REPOS,
  TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS,
} from '@/lib/testInstructions/caps';
import {
  TestInstructionsCapExceededError,
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
//   - the body case asserts the rich text is stored BYTE-FOR-BYTE — sections and
//     fenced code blocks untouched, because the one Markdown pipeline renders it;
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

const BODY = [
  '## Precondition',
  '',
  'Sign in as a project **member**.',
  '',
  '## Locally',
  '',
  '```sh',
  'pnpm install --frozen-lockfile',
  'pnpm dev',
  '```',
  '',
  '## Click-path',
  '',
  '1. Open `/items/ACME-7`',
  '2. Scroll to How to test',
].join('\n');

function input(
  workItemId: string,
  repoId: string,
  over: Partial<PublishTestInstructionsInput> = {},
): PublishTestInstructionsInput {
  return {
    workItemId,
    bodyMd: BODY,
    previewPath: '/items/ACME-7',
    repos: [section(repoId)],
    ...over,
  };
}

function section(
  repoId: string,
  over: Partial<PublishTestInstructionsRepoInput> = {},
): PublishTestInstructionsRepoInput {
  return { repoId, commitSha: SHA_A, ...over };
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

let prNumber = 1;
/**
 * A pull request in `repoId`, LINKED to `workItemId` by a delivery row, with one
 * check row per entry in `checks` — the shape the draft read binds a suggested
 * section to. No check rows means no head has been reported, which is the case
 * that must suggest a NULL commit rather than inventing one.
 */
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

async function rowsFor(workItemId: string) {
  return adminDb.testInstructions.findMany({
    where: { workItemId },
    include: { repos: { orderBy: { position: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
}

describe('testInstructionsService.publish', () => {
  it('writes ONE record for a two-repository run — the rich-text body BYTE-FOR-BYTE, two sections in order', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'A story run' });
    const web = await connectRepo(fx, 'web');
    const api = await connectRepo(fx, 'api');

    const { record, created } = await testInstructionsService.publish(
      input(story.id, web, {
        bodyMd: `\n\n${BODY}\n  `,
        repos: [section(web), section(api, { commitSha: SHA_B })],
      }),
      fx.ctx,
    );
    expect(created).toBe(true);
    expect(record).toMatchObject({
      workItemId: story.id,
      bodyMd: BODY,
      previewPath: '/items/ACME-7',
      publishedById: fx.ctx.userId,
      dispatchRunId: null,
      isCurrent: true,
    });
    expect(record.repos).toEqual([
      { repoId: web, commitSha: SHA_A },
      { repoId: api, commitSha: SHA_B },
    ]);

    const rows = await rowsFor(story.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bodyMd).toBe(BODY);
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
        bodyMd: `  ${BODY}\n`,
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

  it('stores a body with no click-path section as written — the agent says why in prose', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Backend only' });
    const repoId = await connectRepo(fx, 'api');
    const body =
      'No rendered surface changed: a service and its tests.\n\n```sh\npnpm vitest run tests/foo\n```';

    const { record } = await testInstructionsService.publish(
      input(card.id, repoId, { bodyMd: body, previewPath: null }),
      fx.ctx,
    );
    expect(record.bodyMd).toBe(body);
    expect(record.previewPath).toBeNull();
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
      bodyMd: '## Left',
      repos: [section(web), section(api)],
    });
    const right = input(card.id, web, { bodyMd: '## Right' });

    // Separate pooled connections — each publish opens its own transaction.
    const results = await Promise.all([
      testInstructionsService.publish(left, fx.ctx),
      testInstructionsService.publish(right, fx.ctx),
    ]);
    expect(results.every((r) => r.created)).toBe(true);

    const current = (await rowsFor(card.id)).filter((r) => r.isCurrent);
    expect(current).toHaveLength(1);
    const winner = current[0]!;
    if (winner.bodyMd === '## Left') {
      expect(winner.repos.map((r) => r.repoId)).toEqual([web, api]);
    } else {
      expect(winner.bodyMd).toBe('## Right');
      expect(winner.repos.map((r) => r.repoId)).toEqual([web]);
    }
  });
});

// ── A BODY-ONLY record (Subtask MOTIR-5689) ────────────────────────────────
//
// `approval-gates.md` §9's 2026-09-17 amendment, point 3: Motir does not decide
// how a team works. A team that keeps its pull requests on the host and its work
// items here links nothing, so a person's How to test has no repository to name —
// and until this card `publish` refused the save outright.
//
// The cases are chosen so the refusal cannot come back unnoticed: the card is
// given a CONNECTED repository and a LINKED pull request, so an implementation
// that quietly filled `repos` from what it could find would answer with a
// section and fail, rather than passing for the wrong reason.

describe('publish accepts a BODY-ONLY record (MOTIR-5689)', () => {
  it('writes the record with zero repository rows, and reads back `repos: []`', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Body only' });
    const web = await connectRepo(fx, 'web');
    await linkedPr(fx, card.id, web, 'subtask/MOTIR-5689-web', [
      { name: 'Vitest', conclusion: 'success', sha: SHA_B },
    ]);

    const { record, created } = await testInstructionsService.publish(
      input(card.id, web, { repos: [] }),
      fx.ctx,
    );
    expect(created).toBe(true);
    expect(record.bodyMd).toBe(BODY);
    expect(record.repos).toEqual([]);

    const rows = await rowsFor(card.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repos).toEqual([]);
  });

  it('an identical re-save is still idempotent — two empty lists compare equal', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Saved twice' });
    await connectRepo(fx, 'web');

    const first = await testInstructionsService.publish(
      input(card.id, 'unused', { repos: [] }),
      fx.ctx,
    );
    const second = await testInstructionsService.publish(
      input(card.id, 'unused', { repos: [] }),
      fx.ctx,
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(await rowsFor(card.id)).toHaveLength(1);
  });

  it('the BODY is still required — a record with neither a body nor a section is nothing at all', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Empty' });
    await expect(
      testInstructionsService.publish(
        input(card.id, 'unused', { bodyMd: '   ', repos: [] }),
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(TestInstructionsInvalidFieldError);
  });
});

describe('normalizeTestInstructionsContent — every cap is a typed refusal naming the field', () => {
  const base = input('wi', 'repo');
  const long = (n: number) => 'x'.repeat(n);

  const cases: Array<[string, Partial<PublishTestInstructionsInput>, string]> = [
    ['a body over 32 KiB', { bodyMd: long(TEST_INSTRUCTIONS_MAX_BODY_BYTES + 1) }, 'bodyMd'],
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

  it('counts the body cap in UTF-8 bytes, not characters', () => {
    // 3 bytes per character: under the cap in characters, over it in bytes.
    const multibyte = '界'.repeat(Math.floor(TEST_INSTRUCTIONS_MAX_BODY_BYTES / 3) + 1);
    expect(multibyte.length).toBeLessThan(TEST_INSTRUCTIONS_MAX_BODY_BYTES);
    expect(() => normalizeTestInstructionsContent({ ...base, bodyMd: multibyte })).toThrow(
      TestInstructionsCapExceededError,
    );
  });

  it('accepts every field exactly AT its cap, and keeps the body untouched but trimmed', () => {
    const body = long(TEST_INSTRUCTIONS_MAX_BODY_BYTES);
    const out = normalizeTestInstructionsContent({
      ...base,
      bodyMd: `  ${body}  `,
      repos: Array.from({ length: TEST_INSTRUCTIONS_MAX_REPOS }, (_, i) => section(`repo-${i}`)),
      previewPath: `/${long(TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS - 1)}`,
    });
    expect(out.bodyMd).toBe(body);
  });

  // ⚠️ AN EMPTY SECTION LIST IS LEGAL (MOTIR-5689). It was a refusal — *at least
  // one* — which was right while an agent was the only author. A person's form
  // has no repository control, so on a card with nothing linked there is nothing
  // to give, and the refusal made the form unsaveable. Both spellings of absent
  // are covered: the list omitted, and the list present and empty.
  it.each([
    ['omitted', undefined],
    ['present and empty', [] as const],
  ])('accepts a body-only record — `repos` %s', (_name, repos) => {
    const out = normalizeTestInstructionsContent({ ...base, repos });
    expect(out.repos).toEqual([]);
    expect(out.bodyMd).toBe(base.bodyMd.trim());
  });

  it.each([
    ['a blank body', { bodyMd: '  \n ' }, 'bodyMd'],
    [
      'a non-hex commit sha',
      { repos: [section('repo', { commitSha: 'not-a-sha' })] },
      'repos[0].commitSha',
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
  it('passes the body through untouched and orders sections by position', () => {
    const now = new Date('2026-09-13T00:00:00Z');
    const repo = (repoId: string, position: number) => ({
      id: `s-${repoId}`,
      workspaceId: 'ws',
      projectId: 'p',
      testInstructionsId: 'id',
      repoId,
      commitSha: SHA_A,
      position,
    });
    const dto = toTestInstructionsDto({
      id: 'id',
      workspaceId: 'ws',
      projectId: 'p',
      workItemId: 'wi',
      bodyMd: BODY,
      previewPath: null,
      dispatchRunId: null,
      publishedById: null,
      isCurrent: true,
      createdAt: now,
      repos: [repo('second', 1), repo('first', 0)],
    });
    expect(dto.bodyMd).toBe(BODY);
    expect(dto.repos.map((r) => r.repoId)).toEqual(['first', 'second']);
    expect(dto.createdAt).toBe(now.toISOString());
  });
});

describe('the defensive arms the story gate measured (MOTIR-5337)', () => {
  // ⚠️ The repos half of this arm CHANGED VERDICT in MOTIR-5689, and the
  // guarantee it was measuring did not. What MOTIR-5337 pinned is that an absent
  // list is HANDLED — never a `Cannot read properties of undefined` escaping as a
  // 500. It was handled by a typed refusal while a section was mandatory; it is
  // handled by normalising to `[]` now that one is not. The body half is
  // untouched: a record with no body is still nothing at all.
  it('an ABSENT body is the typed refusal naming the field, and an absent repos list is [] — never a TypeError', () => {
    const base = input('wi', 'repo');
    let bodyErr: unknown;
    try {
      normalizeTestInstructionsContent({ ...base, bodyMd: undefined as unknown as string });
    } catch (e) {
      bodyErr = e;
    }
    expect(bodyErr).toBeInstanceOf(TestInstructionsInvalidFieldError);
    expect((bodyErr as TestInstructionsInvalidFieldError).field).toBe('bodyMd');

    const out = normalizeTestInstructionsContent({
      ...base,
      repos: undefined as unknown as PublishTestInstructionsRepoInput[],
    });
    expect(out.repos).toEqual([]);
  });

  it('the current-record read of an item that does not exist is the typed not-found', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      testInstructionsService.getCurrentForWorkItem('no-such-item', fx.ctx),
    ).rejects.toBeInstanceOf(TestInstructionsWorkItemNotFoundError);
  });

  it('inserting NO sections writes nothing and answers 0', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => testInstructionsRepoRepository.createMany([], tx)),
    ).resolves.toBe(0);
  });

  it('a project with NO connected repositories says so, rather than listing an empty set', () => {
    const err = new TestInstructionsRepoNotInProjectError('acme/web', []);
    expect(err.message).toContain('the project has no connected repositories');
    expect(err.message).not.toContain('Use one of');
  });
});

// ── the DRAFT a person's form opens on (Story MOTIR-5450 · Subtask MOTIR-5453) ──
//
// `approval-gates.md` §9's 2026-09-17 amendment, point 2: what a person writes
// is the INSTRUCTIONS, and the repository sections are DERIVED from the card's
// linked pull requests — a person never sets them. So the draft is the two
// fields the form has, and the cases are chosen so a draft that still reaches
// for repository data fails rather than merely carrying a spare key:
//
//   - both cases assert the draft's KEY SET exactly, so a `sections` or
//     `projectRepos` left on it is a failure and not an unnoticed extra;
//   - the ADDING case is given a linked pull request WITH a green check AND two
//     connected project repositories — every input the retired picker read — so
//     an implementation still walking them has something to find and still must
//     return nothing but `''` and `null`;
//   - the EDITING case's record is published over a repository whose live head
//     DIFFERS from the stored commit, so nothing about the record's body or
//     preview can come from the pull request;
//   - the permission case uses a CUSTOM role that can browse but not edit, and
//     asserts the same actor CAN read — so a `project:browse` gate would pass it.

describe('testInstructionsService.getDraftForWorkItem', () => {
  it('EDITING: the current record fills the form — the body and the preview path, and NOTHING else', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'A story run' });
    const web = await connectRepo(fx, 'web');
    const api = await connectRepo(fx, 'api');
    // A live pull request whose head DIFFERS from the record's stored commit.
    await linkedPr(fx, story.id, web, 'parent/MOTIR-1-web', [
      { name: 'Vitest', conclusion: 'success', sha: SHA_B },
    ]);
    await testInstructionsService.publish(
      input(story.id, web, { repos: [section(web), section(api, { commitSha: SHA_B })] }),
      fx.ctx,
    );

    const draft = await testInstructionsService.getDraftForWorkItem(story.id, fx.ctx);
    expect(draft.bodyMd).toBe(BODY);
    expect(draft.previewPath).toBe('/items/ACME-7');
    expect(Object.keys(draft).sort()).toEqual(['bodyMd', 'previewPath']);
  });

  it('ADDING: no record — an EMPTY form, even with a linked pull request and connected repositories to walk', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'No record yet' });
    const web = await connectRepo(fx, 'web');
    await connectRepo(fx, 'api');
    await linkedPr(fx, card.id, web, 'subtask/MOTIR-2-web', [
      { name: 'Vitest', conclusion: 'success', sha: SHA_B },
    ]);

    const draft = await testInstructionsService.getDraftForWorkItem(card.id, fx.ctx);
    expect(draft.bodyMd).toBe('');
    expect(draft.previewPath).toBeNull();
    expect(Object.keys(draft).sort()).toEqual(['bodyMd', 'previewPath']);
  });

  it('refuses an actor whose CUSTOM role can browse but lacks work_item:edit — the draft exists only for someone who may SAVE it', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Guarded' });
    await connectRepo(fx, 'web');

    const viewer = await usersService.createUser({
      email: 'draft-viewer@ex.com',
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
      .getDraftForWorkItem(card.id, viewerCtx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permission).toBe('work_item:edit');
  });

  it('refuses an unknown work item', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      testInstructionsService.getDraftForWorkItem('does-not-exist', fx.ctx),
    ).rejects.toBeInstanceOf(TestInstructionsWorkItemNotFoundError);
  });
});

describe('the PARITY path — one writer, two author kinds (MOTIR-5450)', () => {
  it('a PERSON saving through `publish` writes `dispatchRunId: null` and `publishedById` that person, while a RUN in flight is attributed to the run', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Both authors' });
    const web = await connectRepo(fx, 'web');
    // A dispatch run IS running against this card — so `dispatchRunId: null`
    // below is the flag's doing, not the absence of a run to attribute to.
    const runId = await runningRunFor(fx, card.id);

    const person = await testInstructionsService.publish(
      input(card.id, web, { attributeToRunningDispatch: false }),
      fx.ctx,
    );
    expect(person.created).toBe(true);
    expect(person.record).toMatchObject({
      dispatchRunId: null,
      publishedById: fx.ctx.userId,
      isCurrent: true,
    });

    const agent = await testInstructionsService.publish(
      input(card.id, web, {
        attributeToRunningDispatch: true,
        bodyMd: `${BODY}\n\nWritten by the run.`,
      }),
      fx.ctx,
    );
    expect(agent.record).toMatchObject({ dispatchRunId: runId, isCurrent: true });

    // ONE record table, one writer: the person's row is history, not a parallel
    // shape, and the two differ only in who is recorded as the author.
    const rows = await rowsFor(card.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(rows.map((r) => r.dispatchRunId)).toEqual([null, runId]);
    await finish(runId);
  });

  it("a person's identical re-save writes nothing — the same idempotency an agent's retry gets", async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Re-save' });
    const web = await connectRepo(fx, 'web');

    const first = await testInstructionsService.publish(
      input(card.id, web, { attributeToRunningDispatch: false }),
      fx.ctx,
    );
    const second = await testInstructionsService.publish(
      input(card.id, web, { attributeToRunningDispatch: false }),
      fx.ctx,
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(await rowsFor(card.id)).toHaveLength(1);
  });
});
