import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { howToTestService } from '@/lib/services/howToTestService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { runPublishTestInstructions } from '@/lib/mcp/tools/publishTestInstructions';
import {
  TEST_INSTRUCTIONS_MAX_BODY_BYTES,
  TEST_INSTRUCTIONS_MAX_REPOS,
} from '@/lib/testInstructions/caps';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { organizationIdOf } from '../helpers/organizationOf';
import { randomToken } from '../helpers/random';

// ── THE STORY GATE (Story MOTIR-5450 · Subtask MOTIR-5456) ────────────────────
//
// `docs/decisions/approval-gates.md` §9's 2026-09-17 amendment: ONE RECORD, ONE
// WRITER, TWO AUTHOR KINDS. Each subtask has its own units; this file is the
// seam between them, on real Postgres, through the doors a person and an agent
// actually use — the route's Server Action and `publish_test_instructions`.
//
// ⚠️ WHAT PARITY MEANS HERE IS NARROWER THAN THE STORY WAS PLANNED WITH, and
// the narrowing is the design's (§24, decisions 8 and 8b). It is no longer
// *a person can set everything an agent can*: a person has no repository
// control, because Motir derives the repositories from the card's linked pull
// requests. It is *over the fields a person SETS, the two authors are
// indistinguishable in the store*. The assertion that carries the removed half
// is number 3 below — linking a pull request changes what a record COVERS with
// nobody editing it — and it is the one that fails the day a repository field
// comes back.
//
// The two context resolvers are stubbed because the test environment has no
// cookies; everything else runs the real path.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
// `revalidatePath` needs Next's per-request store, which a vitest process has
// no way to enter. It is the SERVER half of the page-state contract and the E2E
// card is where it is exercised for real; here it is recorded so the assertion
// below can say the action asked for the page to be re-read.
const revalidated: string[] = [];
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidated.push(path) }));
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});

const { loadHowToTestDraftAction, saveHowToTestAction } =
  await import('@/app/(authed)/items/[key]/actions');

const HEAD = 'a'.repeat(40);

/** The body a person and an agent both write — a fence WITH a language. */
const BODY = [
  '## Precondition',
  '',
  'Sign in as **ada@acme.test**.',
  '',
  '## Locally',
  '',
  '```sh',
  'pnpm install --frozen-lockfile',
  '```',
  '',
  '## Click-path',
  '',
  '1. Open the item',
].join('\n');

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeCtx.current = null;
  revalidated.length = 0;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * Sign the fixture's owner in, so the Server Action runs as a PERSON.
 *
 * ⚠️ The session's `name` is NOT what the author line reads. The read resolves
 * the display name from the `user` row by `published_by_id`, which is what makes
 * a renamed or deleted account read correctly on an old record — so a test that
 * asserted the session's name would be asserting the wrong source.
 */
function signInAs(fx: WorkItemFixture, name = 'Ada Lovelace') {
  session.current = { user: { id: fx.ownerId, email: 'ada@acme.test', name } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

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
async function linkedPr(fx: WorkItemFixture, workItemId: string, repoId: string, headRef: string) {
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
  await adminDb.githubCheckRun.create({
    data: {
      pullRequestId: row.id,
      commitSha: HEAD,
      checkName: 'Vitest',
      conclusion: 'success',
    },
  });
  return row;
}

/** A RUNNING dispatch run against this card, so the agent door has one to own. */
async function runningRunFor(fx: WorkItemFixture, workItemId: string): Promise<string> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run',
      status: 'running',
      startedAt: new Date('2026-09-14T09:30:00Z'),
      cards: { create: { workspaceId: fx.workspaceId, workItemId, position: 0 } },
    },
  });
  return run.id;
}

function rowsFor(workItemId: string) {
  return adminDb.testInstructions.findMany({
    where: { workItemId },
    include: { repos: { orderBy: { position: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
}

// ── 1 · THE PARITY PAIR ───────────────────────────────────────────────────────

describe('1 · a person and an agent write ONE record shape', () => {
  // ⚠️ THE WHOLE ROW IS COMPARED, minus three columns BY NAME. A field list
  // would be a test that quietly stops covering a column the day one is added —
  // which is the exact failure the parity rule exists to prevent.
  const AUTHOR_COLUMNS = ['id', 'dispatchRunId', 'publishedById', 'createdAt'] as const;

  it('every stored column matches except the author stamps and the ids', async () => {
    // ONE project, two cards: everything that could differ for a reason other
    // than the author is then held equal by construction, so the comparison has
    // nothing to explain away.
    const fx = await makeWorkItemFixture();
    const personCard = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Written by a person',
    });
    const agentCard = await createTestWorkItem(fx, { kind: 'task', title: 'Written by a run' });

    signInAs(fx);
    const personSave = await saveHowToTestAction({
      workItemId: personCard.id,
      identifier: personCard.identifier,
      bodyMd: BODY,
      previewPath: '/items/ACME-7',
    });
    expect(personSave.ok).toBe(true);
    // The block is server-rendered, so the save's only job after the write is to
    // ask for the page to be read again (`CLAUDE.md`'s contract, case 2).
    expect(revalidated).toContain(`/items/${personCard.identifier}`);

    await runningRunFor(fx, agentCard.id);
    const agentPublish = await runPublishTestInstructions(
      { key: agentCard.identifier, bodyMd: BODY, previewPath: '/items/ACME-7' },
      fx.ctx,
    );
    expect(agentPublish.isError).toBeFalsy();

    const [person] = await rowsFor(personCard.id);
    const [agent] = await rowsFor(agentCard.id);
    const strip = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([k]) =>
            !(AUTHOR_COLUMNS as readonly string[]).includes(k) &&
            // Keyed to its own card, necessarily.
            k !== 'workItemId' &&
            k !== 'repos',
        ),
      );
    expect(strip(person!)).toEqual(strip(agent!));

    // And the three that MUST differ, differ in the one direction that matters:
    // the flag is what separates the author kinds, not a second write path.
    expect(person!.dispatchRunId).toBeNull();
    expect(person!.publishedById).toBe(fx.ownerId);
    expect(agent!.dispatchRunId).not.toBeNull();
  });
});

// ── 2 · A BODY-ONLY RECORD ────────────────────────────────────────────────────

describe('2 · a body-only record is legal and CURRENT', () => {
  it('a save on an item with NO linked pull request reads back as `record`, not `record_missing`', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Nothing linked' });
    // A repository is CONNECTED to the project but nothing is linked to the
    // card: an implementation that filled `repos` from the project's set would
    // answer with a section here and fail.
    await connectRepo(fx, 'web');
    signInAs(fx);

    expect(
      await saveHowToTestAction({
        workItemId: card.id,
        identifier: card.identifier,
        bodyMd: BODY,
        previewPath: null,
      }),
    ).toEqual({ ok: true });

    const rows = await rowsFor(card.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repos).toEqual([]);

    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(dto.state).toBe('record');
    expect(dto.record?.bodyMd).toBe(BODY);
  });
});

// ── 3 · NO WRITE PATH ACCEPTS A REPOSITORY ───────────────────────────────────

describe('3 · a person never supplies a repository, and linking one does not change that', () => {
  // ⚠️ THIS ASSERTION WAS CARVED, 2026-09-18 (Yue): as approved it also claimed
  // *"the read now shows that repository's section"*, which is what the BLOCK
  // does with the record and is NOT this story's — the story is what a person
  // WRITES, a body and a preview path. That half is MOTIR-5691, whose remedy is
  // open between fixing the sub-block and retiring it, and which was already
  // half wrong before this story began.
  //
  // What survives is the half the sentence itself says it is for: **no write
  // path lets a person supply a repository.** That is §24 decision 8b and the
  // parity rule, and it is what fails the day somebody adds a repository field
  // back — which the parity pair above cannot catch, because both its halves go
  // through the same narrow door.
  it('a save, then a LINK, leaves the record holding zero repository rows', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Linked later' });
    const web = await connectRepo(fx, 'web');
    signInAs(fx);

    await saveHowToTestAction({
      workItemId: card.id,
      identifier: card.identifier,
      bodyMd: BODY,
      previewPath: null,
    });
    const [before] = await rowsFor(card.id);
    expect(before!.repos).toEqual([]);

    await linkedPr(fx, card.id, web.id, 'subtask/MOTIR-5456-web');

    // Linking writes nothing into the record: same row, same id, still no
    // repository. Motir learning about a pull request is not the record
    // acquiring one.
    const after = await rowsFor(card.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before!.id);
    expect(after[0]!.repos).toEqual([]);
    expect(after[0]!.bodyMd).toBe(BODY);
  });

  it('the SAVE DOOR takes no repository at all — its input is the body and the path', async () => {
    // The structural half, and the one a future field would trip. The action's
    // parameter object is the whole surface a person's save has; if a
    // repository control ever comes back, it arrives here first.
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Two fields' });
    await connectRepo(fx, 'web');
    signInAs(fx);

    const input = {
      workItemId: card.id,
      identifier: card.identifier,
      bodyMd: BODY,
      previewPath: '/items/ACME-7',
    };
    expect(Object.keys(input).sort()).toEqual([
      'bodyMd',
      'identifier',
      'previewPath',
      'workItemId',
    ]);
    expect(await saveHowToTestAction(input)).toEqual({ ok: true });
    expect((await rowsFor(card.id))[0]!.repos).toEqual([]);
  });

  it('and the DRAFT a person opens is the same two fields — nothing to name a repository with', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Draft shape' });
    const web = await connectRepo(fx, 'web');
    // A linked pull request AND a connected repository: every input a retired
    // picker would have read is present, and the draft still offers neither.
    await linkedPr(fx, card.id, web.id, 'subtask/MOTIR-5456-draft');
    signInAs(fx);

    const draft = await loadHowToTestDraftAction(card.id);
    expect(draft.ok).toBe(true);
    expect(draft.ok && Object.keys(draft.draft).sort()).toEqual(['bodyMd', 'previewPath']);
  });
});

// ── 4 · RICH TEXT ─────────────────────────────────────────────────────────────

describe('4 · rich text survives the round trip', () => {
  it('the fence and its LANGUAGE come back byte-for-byte', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Rich text' });
    signInAs(fx);

    await saveHowToTestAction({
      workItemId: card.id,
      identifier: card.identifier,
      bodyMd: BODY,
      previewPath: null,
    });

    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    // Byte-for-byte, not "contains": a serializer that normalised the fence, or
    // dropped `sh`, would still pass a `toContain`.
    expect(dto.record?.bodyMd).toBe(BODY);
    expect(dto.record?.bodyMd).toContain('```sh\n');

    // And what the FORM opens onto is the same bytes — an Edit that re-saves
    // unchanged must not be able to rewrite the body.
    const draft = await loadHowToTestDraftAction(card.id);
    expect(draft.ok && draft.draft.bodyMd).toBe(BODY);
  });
});

// ── 5 · THE AUTHOR ────────────────────────────────────────────────────────────

describe('5 · the AUTHOR, on the record and on every history row', () => {
  it('a person, then a run, then the history holding one of each newest first', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Both kinds' });
    signInAs(fx);

    await saveHowToTestAction({
      workItemId: card.id,
      identifier: card.identifier,
      bodyMd: '## By a person',
      previewPath: null,
    });
    const personRead = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(personRead.record?.author).toEqual({
      kind: 'person',
      userId: fx.ownerId,
      label: fx.owner.name,
    });

    const runId = await runningRunFor(fx, card.id);
    await runPublishTestInstructions({ key: card.identifier, bodyMd: '## By a run' }, fx.ctx);

    const runRead = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(runRead.record?.author).toMatchObject({ kind: 'run', runId });
    expect(runRead.record?.author.label).not.toBe('');
    // Newest first, and the person's is now history — one list, two kinds.
    expect(runRead.history).toHaveLength(1);
    expect(runRead.history[0]!.author).toEqual({
      kind: 'person',
      userId: fx.ownerId,
      label: fx.owner.name,
    });
  });

  it('a DELETED publisher is named, never blank', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Erased author' });
    const author = await usersService.createUser({
      email: 'leaving@ex.com',
      password: 'hunter2hunter2',
      name: 'Leaving Soon',
    });
    await workspacesService.addMember({ userId: author.id, workspaceId: fx.workspaceId });
    await testInstructionsService.publish(
      { workItemId: card.id, bodyMd: '## By someone who left', attributeToRunningDispatch: false },
      { userId: author.id, workspaceId: fx.workspaceId },
    );
    // `published_by_id` is `SetNull`, like every audit stamp on the row.
    await adminDb.user.delete({ where: { id: author.id } });

    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(dto.record?.author).toMatchObject({ kind: 'person', userId: null });
    expect(dto.record?.author.label.trim()).not.toBe('');
  });
});

// ── 6 · THE REFUSALS ──────────────────────────────────────────────────────────

describe('6 · the refusals', () => {
  // The three a person's FORM can produce come back PLACED, so the form can draw
  // each beside the control it is about (§24, panel 13d).
  it.each([
    ['an empty body', { bodyMd: '   ', previewPath: null }, 'bodyMd'],
    [
      'a body over its cap',
      { bodyMd: 'x'.repeat(TEST_INSTRUCTIONS_MAX_BODY_BYTES + 1), previewPath: null },
      'bodyMd',
    ],
    [
      'a preview URL instead of a path',
      { bodyMd: '## Body', previewPath: 'https://evil.example/' },
      'previewPath',
    ],
  ])('%s is refused, named by its field, and writes nothing', async (_name, input, field) => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Refused' });
    signInAs(fx);

    const res = await saveHowToTestAction({
      workItemId: card.id,
      identifier: card.identifier,
      ...input,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.field).toBe(field);
    expect(res.ok === false && res.error.length).toBeGreaterThan(0);
    expect(await rowsFor(card.id)).toHaveLength(0);
  });

  // ⚠️ THE TWO A PERSON CANNOT REACH ARE ASSERTED AT THE SERVICE ANYWAY. The
  // form sends no sections since §24's decision 8b, so nothing in the UI can
  // trigger these — and the MCP door still can. A refusal with no test is what a
  // later cleanup deletes as dead code.
  it('a repository outside the project is refused, naming the valid set', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Foreign repo' });
    await connectRepo(fx, 'web');
    const err = await testInstructionsService
      .publish(
        {
          workItemId: card.id,
          bodyMd: BODY,
          repos: [{ repoRef: 'not-ours', commitSha: HEAD }],
        },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain('acme/web');
  });

  it('the same repository twice is refused, naming the second entry', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Twice' });
    const web = await connectRepo(fx, 'web');
    const err = await testInstructionsService
      .publish(
        {
          workItemId: card.id,
          bodyMd: BODY,
          repos: [
            { repoId: web.id, commitSha: HEAD },
            { repoRef: 'acme/web', commitSha: HEAD },
          ],
        },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain('repos[1].repo');
  });

  it('over the section cap is refused by the cap, not silently truncated', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Too many' });
    const err = await testInstructionsService
      .publish(
        {
          workItemId: card.id,
          bodyMd: BODY,
          repos: Array.from({ length: TEST_INSTRUCTIONS_MAX_REPOS + 1 }, () => ({
            repoRef: 'web',
            commitSha: HEAD,
          })),
        },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain(String(TEST_INSTRUCTIONS_MAX_REPOS));
  });
});

// ── 7 · THE LOCK ──────────────────────────────────────────────────────────────

describe('7 · two concurrent first saves', () => {
  it('both resolve, exactly one record ends current, and no raw P2002 escapes', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Raced' });
    const web = await connectRepo(fx, 'web');
    signInAs(fx);

    // One through each door, at once — the two authors racing for one card is
    // the case the row lock exists for.
    const [personRes, agentRes] = await Promise.all([
      saveHowToTestAction({
        workItemId: card.id,
        identifier: card.identifier,
        bodyMd: '## By a person',
        previewPath: null,
      }),
      testInstructionsService.publish(
        {
          workItemId: card.id,
          bodyMd: '## By a run',
          repos: [{ repoId: web.id, commitSha: HEAD }],
        },
        fx.ctx,
      ),
    ]);
    expect(personRes.ok).toBe(true);
    expect(agentRes.created).toBe(true);

    const rows = await rowsFor(card.id);
    expect(rows).toHaveLength(2);
    const current = rows.filter((r) => r.isCurrent);
    expect(current).toHaveLength(1);
    // Whichever won, its own sections are intact — never a half-written set.
    const winner = current[0]!;
    expect(winner.repos).toHaveLength(winner.bodyMd === '## By a run' ? 1 : 0);
  });
});

// ── 8 · IDEMPOTENCY ───────────────────────────────────────────────────────────

describe('8 · an identical re-save writes nothing', () => {
  it('a person saving the same body-only record twice leaves ONE row', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Saved twice' });
    signInAs(fx);
    const input = {
      workItemId: card.id,
      identifier: card.identifier,
      bodyMd: BODY,
      previewPath: '/items/ACME-7',
    };

    expect(await saveHowToTestAction(input)).toEqual({ ok: true });
    expect(await saveHowToTestAction(input)).toEqual({ ok: true });

    // Two empty section lists compare equal — the case a `JSON.stringify`
    // comparison gets right and an identity comparison would not.
    const rows = await rowsFor(card.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isCurrent).toBe(true);
    expect(await howToTestService.getForWorkItem(card.id, fx.ctx)).toMatchObject({
      state: 'record',
      history: [],
    });
  });

  it('a CHANGED body from the same person writes a second version and keeps the first as history', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Edited' });
    signInAs(fx);
    await saveHowToTestAction({
      workItemId: card.id,
      identifier: card.identifier,
      bodyMd: '## First',
      previewPath: null,
    });
    await saveHowToTestAction({
      workItemId: card.id,
      identifier: card.identifier,
      bodyMd: '## Second',
      previewPath: null,
    });

    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);
    expect(dto.record?.bodyMd).toBe('## Second');
    expect(dto.history).toHaveLength(1);
    expect(dto.history[0]!.author.kind).toBe('person');
  });
});
