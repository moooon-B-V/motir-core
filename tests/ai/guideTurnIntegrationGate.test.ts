import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { GuideContext } from '@/lib/ai/guideWorkItem';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { AiJobsFixture, GuideJobOutcome } from '@/lib/test-ai-jobs-mock';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';

// THE GUIDE TURN'S INTEGRATION GATE (Story MOTIR-7459 · MOTIR-7468), against a
// REAL Postgres, with the motir-ai boundary crossed on the WIRE.
//
// The story's earlier files (`aiGuideService`, `guideLandingService`) mock
// `@/lib/ai/motirAiClient` as a module. This file does not: the real client
// builds and posts the envelope, and the ONE mock is `lib/test-ai-jobs-mock.ts` —
// the undici intercept the E2E lane uses — so a `guide_work_item` job counted
// here is a `POST /v1/jobs` whose body says so, and the out-of-credits error is
// the real client's mapping of motir-ai's own `402 out_of_credits` problem.
// Besides that seam, only `getSession` / `getActiveProject` are mocked.
//
// What it adds over the earlier files, and nothing else:
//   * a whole walk in one run — door → job on the wire → landing → the card read
//     back — on a card with rows (to Done) and on one without (a list saved);
//   * TWO WRITERS: a person's tick between two turns is what the next turn's
//     context carries, read off the wire body;
//   * a live edit writes the card's activity as the person, and nothing else;
//   * workspace isolation: another workspace's row id lands nothing anywhere;
//   * the refusals measured on the wire — no request reaches motir-ai;
//   * the out-of-credits submit and its retry.
// The item page's door branch is `tests/components/guide-me-through-door.test.tsx`
// (the real `LateUpperSections`, manual and code cards and the empty slot).

const ORIGIN = 'http://motir-ai.guide-gate.test';

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

let fixturePath: string;
let agent: MockAgent;
/** Every `POST /v1/jobs` body the seam received, in order. */
const wire: { jobKind: string; context: { guideContext?: GuideContext } }[] = [];

beforeAll(async () => {
  fixturePath = join(mkdtempSync(join(tmpdir(), 'motir-guide-gate-')), 'jobs.json');
  writeFileSync(fixturePath, '{}');
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', fixturePath);

  agent = new MockAgent();
  agent.enableNetConnect();
  setGlobalDispatcher(agent);
  // ⚠️ INSTALLED ONCE: `observeAiJobSubmit` keeps its subscribers in module
  // scope, so a per-test install would stack observers and double every capture.
  const { installAiJobsBoundaryMock, observeAiJobSubmit } = await import('@/lib/test-ai-jobs-mock');
  installAiJobsBoundaryMock(agent);
  observeAiJobSubmit((raw) => {
    wire.push(JSON.parse(raw) as (typeof wire)[number]);
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await agent.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

const { POST: guide } = await import('@/app/api/ai/guide/route');
const { POST: guideSettle } = await import('@/app/api/ai/guide/settle/route');

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ── The motir-ai side ─────────────────────────────────────────────────────────

/** Declare the guide queue, keeping what the seam already recorded. */
function declareGuide(guideQueue: GuideJobOutcome[]): void {
  const current = JSON.parse(readFileSync(fixturePath, 'utf8')) as AiJobsFixture;
  writeFileSync(fixturePath, JSON.stringify({ ...current, guide: guideQueue }));
}
/** The `guide_work_item` jobs that EXIST — accepted submits only. */
const guideJobs = () =>
  ((JSON.parse(readFileSync(fixturePath, 'utf8')) as AiJobsFixture).submitted ?? []).filter(
    (s) => s.kind === 'guide_work_item' && !s.refused,
  );
const guideWire = () => wire.filter((b) => b.jobKind === 'guide_work_item');
const lastContext = () => guideWire().at(-1)!.context.guideContext!;

/** The n-th guide job's turn (0-based), declared for every job up to it. */
const turnAt = (n: number, actions: unknown[], messageMd = 'Next step.'): void => {
  const current = (JSON.parse(readFileSync(fixturePath, 'utf8')) as AiJobsFixture).guide ?? [];
  const queue = [...current];
  while (queue.length < n) queue.push({});
  queue[n] = { guideTurn: { messageMd, actions } };
  declareGuide(queue);
};

// ── The core side ─────────────────────────────────────────────────────────────

interface Turned {
  jobId: string;
  session: PlanChangeSessionDto;
}
interface Settled {
  outcome: string;
  session: PlanChangeSessionDto;
  record?: { outcomes: Array<{ type: string; outcome: string; reason?: string }> };
}

async function open(itemKey: string): Promise<Turned> {
  const res = await guide(post('/api/ai/guide', { itemKey }));
  expect(res.status).toBe(200);
  return (await res.json()) as Turned;
}
async function say(sessionId: string, text: string): Promise<Turned> {
  const res = await guide(post('/api/ai/guide', { sessionId, text }));
  expect(res.status).toBe(200);
  return (await res.json()) as Turned;
}
async function settle(t: Turned): Promise<Settled> {
  const res = await guideSettle(
    post('/api/ai/guide/settle', { jobId: t.jobId, sessionId: t.session.id }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Settled;
}
const outcomesOf = (s: Settled) => s.record!.outcomes.map((o) => [o.type, o.outcome]);

let fx: WorkItemFixture;

async function manualCard(title = 'Rotate the signing key', f = fx) {
  const item = await createTestWorkItem(f, {
    kind: 'task',
    title,
    type: 'manual',
    executor: 'human',
  });
  // The fixture writes the legacy `open`; a real card sits on a workflow status.
  return adminDb.workItem.update({ where: { id: item.id }, data: { status: 'todo' } });
}
async function addRows(workItemId: string, texts: string[], f = fx) {
  const ids: string[] = [];
  for (const text of texts) {
    ids.push((await workItemTodosService.addTodo(workItemId, { text }, f.ctx)).todo.id);
  }
  return ids;
}
/** The card's rows as stored, with `done` read off `doneAt`. */
const dbRows = async (workItemId: string) =>
  (
    await adminDb.workItemTodo.findMany({ where: { workItemId }, orderBy: { position: 'asc' } })
  ).map((r) => ({ ...r, done: r.doneAt !== null }));

async function becomeMemberWith(permissions: string[]): Promise<void> {
  const user = await createTestUser({ name: 'Guided' });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const role = await createCustomRoleAs({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name: `Partial ${permissions.join(' ')}`,
    permissions,
  });
  const key = fx.projectIdentifier;
  await addToProjectAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  await setProjectRoleAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: role.id,
  });
  session.current = { user: { id: user.id, email: user.email, name: user.name } };
  activeCtx.current = { ...activeCtx.current!, userId: user.id };
}

beforeEach(async () => {
  await truncateAuthTables();
  wire.length = 0;
  writeFileSync(fixturePath, '{}');
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

describe('a walk on a card with rows, to Done', () => {
  it('ticks as the person, carries the person’s own tick, and closes once', async () => {
    const card = await manualCard();
    const [r1, r2] = await addRows(card.id, ['Open the vault', 'Rotate the key']);

    // The door: ONE guide job on the wire, the rows in list order.
    const opened = await open(card.identifier);
    expect(guideJobs()).toHaveLength(1);
    expect(lastContext().card.key).toBe(card.identifier);
    expect(lastContext().todos).toMatchObject({ temporary: false });
    expect(lastContext().todos.rows.map((r) => [r.id, r.done])).toEqual([
      [r1, false],
      [r2, false],
    ]);

    turnAt(0, [
      { type: 'tick', rowId: r1 },
      { type: 'current_step', rowId: r2 },
    ]);
    expect(outcomesOf(await settle(opened))).toEqual([
      ['tick', 'landed'],
      ['current_step', 'recorded'],
    ]);
    const [first] = await dbRows(card.id);
    expect(first).toMatchObject({ id: r1, done: true, doneById: fx.ownerId });

    // TWO WRITERS: the person ticks step 2 themselves, between turns.
    await workItemTodosService.setTodoDone(r2!, true, fx.ctx);
    const second = await say(opened.session.id, 'I did the second one too.');
    expect(lastContext().todos.rows.map((r) => r.done)).toEqual([true, true]);

    turnAt(1, [{ type: 'offer_close' }], 'Every step is done. Close the card?');
    await settle(second);
    const yes = await say(opened.session.id, 'Yes, close the card.');
    turnAt(2, [{ type: 'close' }], 'Both steps are done; closing it.');
    expect(outcomesOf(await settle(yes))).toEqual([['close', 'landed']]);

    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).status).toBe('done');
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);

    // A replayed settle lands nothing twice.
    const replay = await settle(yes);
    expect(replay.outcome).toBe('guided');
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);
    expect(guideJobs()).toHaveLength(3);
  });

  it('a step that cannot be done is ONE comment, and a re-open resumes without a job', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Log in to the console']);
    const opened = await open(card.identifier);
    turnAt(0, [
      { type: 'current_step', rowId: r1 },
      { type: 'cannot_do', reason: 'It needs an admin you do not have' },
    ]);
    await settle(opened);
    const comments = await adminDb.comment.findMany({ where: { workItemId: card.id } });
    expect(comments).toHaveLength(1);
    expect(JSON.stringify(comments[0])).toContain('It needs an admin you do not have');

    const reopened = await open(card.identifier);
    expect(reopened.session.id).toBe(opened.session.id);
    expect(guideJobs()).toHaveLength(1);
  });
});

describe('a walk on a card with NO rows', () => {
  it('walks a proposal without writing, then saves it with the ticks so far', async () => {
    const card = await manualCard('Add the DNS records');
    const opened = await open(card.identifier);
    expect(lastContext().todos.rows).toEqual([]);

    turnAt(0, [
      {
        type: 'propose_todos',
        rows: [
          { id: 'tmp-1', text: 'Open the DNS console' },
          { id: 'tmp-2', text: 'Add the SPF record' },
        ],
      },
    ]);
    await settle(opened);
    const walk = await say(opened.session.id, 'Walk it without saving.');
    turnAt(1, [{ type: 'tick', rowId: 'tmp-1' }]);
    expect(outcomesOf(await settle(walk))).toEqual([['tick', 'recorded']]);
    expect(await dbRows(card.id)).toHaveLength(0);

    // The next turn is sent the TEMPORARY list, with the walk's tick on it.
    const save = await say(opened.session.id, 'Save this list to the card.');
    expect(lastContext().todos.temporary).toBe(true);
    expect(lastContext().todos.rows.map((r) => [r.id, r.done])).toEqual([
      ['tmp-1', true],
      ['tmp-2', false],
    ]);
    turnAt(2, [
      {
        type: 'write_todos',
        rows: [
          { fromId: 'tmp-1', text: 'Open the DNS console', done: true },
          { fromId: 'tmp-2', text: 'Add the SPF record', done: false },
        ],
      },
    ]);
    expect(outcomesOf(await settle(save))).toEqual([['write_todos', 'landed']]);
    expect((await dbRows(card.id)).map((r) => [r.text, r.done])).toEqual([
      ['Open the DNS console', true],
      ['Add the SPF record', false],
    ]);

    // A second open on a card that NOW has rows resumes; with none it would start.
    const again = await open(card.identifier);
    expect(again.session.id).toBe(opened.session.id);
    expect(guideJobs()).toHaveLength(3);
  });

  it('a card with no rows always starts a NEW conversation', async () => {
    const card = await manualCard();
    const a = await open(card.identifier);
    const b = await open(card.identifier);
    expect(b.session.id).not.toBe(a.session.id);
    expect(guideJobs()).toHaveLength(2);
  });
});

describe('a live edit to the card', () => {
  it('changes only the guided card’s title, as the person, with ONE activity entry', async () => {
    const card = await manualCard('Rotate key');
    const other = await manualCard('Leave me alone');
    await addRows(card.id, ['One']);
    const revisions = () =>
      adminDb.workItemRevision.findMany({ where: { workItemId: card.id, changeKind: 'updated' } });
    const before = (await revisions()).length;
    const otherBefore = await adminDb.workItem.findUniqueOrThrow({ where: { id: other.id } });

    const opened = await open(card.identifier);
    turnAt(0, [
      {
        type: 'edit_item',
        reason: 'The title names the wrong key.',
        title: 'Rotate the webhook signing key',
        previous: { title: 'Rotate key' },
      },
    ]);
    expect(outcomesOf(await settle(opened))).toEqual([['edit_item', 'landed']]);

    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).title).toBe(
      'Rotate the webhook signing key',
    );
    const after = await revisions();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.changedById).toBe(fx.ownerId);
    expect(await adminDb.workItem.findUniqueOrThrow({ where: { id: other.id } })).toEqual(
      otherBefore,
    );
  });
});

describe('workspace isolation', () => {
  it('a row id from another workspace lands nothing, here or there', async () => {
    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const theirs = await manualCard('Theirs', elsewhere);
    const [foreign] = await addRows(theirs.id, ['Their step'], elsewhere);

    const card = await manualCard();
    const [mine] = await addRows(card.id, ['My step']);
    const opened = await open(card.identifier);
    expect(lastContext().todos.rows.map((r) => r.id)).toEqual([mine]);

    turnAt(0, [
      { type: 'tick', rowId: foreign },
      { type: 'revise_step', rowId: foreign, reason: 'x', text: 'Hijacked' },
      { type: 'tick', rowId: mine },
    ]);
    expect(outcomesOf(await settle(opened))).toEqual([
      ['tick', 'skipped'],
      ['revise_step', 'skipped'],
      ['tick', 'landed'],
    ]);
    expect(await dbRows(theirs.id)).toMatchObject([{ text: 'Their step', done: false }]);
    expect(await dbRows(card.id)).toMatchObject([{ id: mine, done: true }]);
  });
});

describe('refusals, measured on the wire', () => {
  async function refused(itemKey: string, status: number) {
    const res = await guide(post('/api/ai/guide', { itemKey }));
    expect(res.status).toBe(status);
    expect(guideWire()).toHaveLength(0);
    expect(await adminDb.planChangeSession.count({ where: { origin: 'guide' } })).toBe(0);
  }

  it('a code card, a Done card and an archived card reach no motir-ai', async () => {
    const code = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Code it',
      type: 'code',
      executor: 'coding_agent',
    });
    await refused(code.identifier, 422);
    const done = await manualCard('Finished');
    await adminDb.workItem.update({ where: { id: done.id }, data: { status: 'done' } });
    await refused(done.identifier, 409);
    const archived = await manualCard('Shelved');
    await adminDb.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    await refused(archived.identifier, 409);
  });

  it('a reader without work_item:edit, or without ai:plan, reaches no motir-ai', async () => {
    const card = await manualCard();
    await becomeMemberWith(['project:browse', 'ai:plan']);
    await refused(card.identifier, 403);
    session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
    activeCtx.current = { ...activeCtx.current!, userId: fx.ownerId };
    await becomeMemberWith(['project:browse', 'work_item:edit']);
    await refused(card.identifier, 403);
  });

  it('a card in another project is a 404', async () => {
    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const theirs = await manualCard('Theirs', elsewhere);
    await refused(theirs.identifier, 404);
  });
});

describe('out of credits', () => {
  it('motir-ai’s 402 is the typed refusal, and the retry submits once', async () => {
    const card = await manualCard();
    declareGuide([{ submit: 'out_of_credits' }, { submit: 'accepted' }]);
    const res = await guide(post('/api/ai/guide', { itemKey: card.identifier }));
    expect(res.status).toBe(402);
    expect(guideJobs()).toHaveLength(0);

    const stored = await adminDb.planChangeSession.findFirstOrThrow({
      where: { origin: 'guide' },
      include: { turns: true },
    });
    const turn = stored.turns.find((t) => t.role === 'user')!;
    const retry = await guide(post('/api/ai/guide', { sessionId: stored.id, turnId: turn.id }));
    expect(retry.status).toBe(200);
    expect(guideJobs()).toHaveLength(1);
  });
});

describe('the landing’s other arms, on the wire', () => {
  it('a temporary walk records each correction, and refuses one on a ticked or unknown step', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    turnAt(0, [
      {
        type: 'propose_todos',
        rows: [
          { id: 'tmp-1', text: 'One' },
          { id: 'tmp-2', text: 'Two' },
          { id: 'tmp-3', text: 'Three' },
        ],
      },
    ]);
    await settle(opened);
    const walk = await say(opened.session.id, 'Walk it without saving.');
    turnAt(1, [
      { type: 'tick', rowId: 'tmp-1' },
      { type: 'tick', rowId: 'tmp-1' },
      { type: 'tick', rowId: 'tmp-9' },
      { type: 'add_step', afterRowId: 'tmp-1', reason: 'missing', text: 'One and a half' },
      { type: 'revise_step', rowId: 'tmp-2', reason: 'clearer', text: 'Two, clearly' },
      { type: 'revise_step', rowId: 'tmp-1', reason: 'x', text: 'No' },
      { type: 'revise_step', rowId: 'tmp-9', reason: 'x', text: 'No' },
      { type: 'move_step', rowId: 'tmp-3', afterRowId: null, reason: 'first' },
      { type: 'move_step', rowId: 'tmp-1', afterRowId: null, reason: 'x' },
      { type: 'move_step', rowId: 'tmp-9', afterRowId: null, reason: 'x' },
      { type: 'remove_step', rowId: 'tmp-2', reason: 'not needed' },
      { type: 'remove_step', rowId: 'tmp-1', reason: 'x' },
      { type: 'remove_step', rowId: 'tmp-9', reason: 'x' },
      { type: 'propose_todos', rows: [{ id: 'tmp-x', text: 'Again' }] },
    ]);
    const settled = await settle(walk);
    expect(outcomesOf(settled)).toEqual([
      ['tick', 'recorded'],
      ['tick', 'skipped'],
      ['tick', 'skipped'],
      ['add_step', 'recorded'],
      ['revise_step', 'recorded'],
      ['revise_step', 'skipped'],
      ['revise_step', 'skipped'],
      ['move_step', 'recorded'],
      ['move_step', 'skipped'],
      ['move_step', 'skipped'],
      ['remove_step', 'recorded'],
      ['remove_step', 'skipped'],
      ['remove_step', 'skipped'],
      ['propose_todos', 'recorded'],
    ]);
    expect(await dbRows(card.id)).toHaveLength(0);
    // The refusals are stated under the reply, so the reader knows what did not happen.
    expect(settled.session.turns.at(-1)!.body).toContain('that step is not on the list');
  });

  it('corrections on a saved list land in place, with the step’s executor and command', async () => {
    const card = await manualCard();
    const [r1, r2, r3] = await addRows(card.id, ['One', 'Two', 'Three']);
    const opened = await open(card.identifier);
    turnAt(0, [
      {
        type: 'add_step',
        afterRowId: r1,
        reason: 'missing',
        text: 'One and a half',
        commandText: 'rotate --key',
        executor: 'human',
      },
      {
        type: 'revise_step',
        rowId: r2,
        reason: 'clearer',
        notesMd: 'Use the **console**.',
        commandText: 'echo two',
        executor: 'human',
      },
      { type: 'move_step', rowId: r3, afterRowId: null, reason: 'first' },
      { type: 'add_step', afterRowId: null, reason: 'start', text: 'Zero' },
      { type: 'propose_todos', rows: [{ id: 'tmp-1', text: 'No' }] },
      {
        type: 'write_todos',
        rows: [{ fromId: 'tmp-1', text: 'No', done: false }],
      },
    ]);
    expect(outcomesOf(await settle(opened))).toEqual([
      ['add_step', 'landed'],
      ['revise_step', 'landed'],
      ['move_step', 'landed'],
      ['add_step', 'landed'],
      ['propose_todos', 'skipped'],
      ['write_todos', 'skipped'],
    ]);
    const rows = await dbRows(card.id);
    expect(rows.map((r) => r.text)).toEqual(['Zero', 'Three', 'One', 'One and a half', 'Two']);
    expect(rows[3]).toMatchObject({ commandText: 'rotate --key', executor: 'human' });
    expect(rows[4]).toMatchObject({ notesMd: 'Use the **console**.', commandText: 'echo two' });
  });

  it('a step added to a card with no list is refused; the explanation is edited', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    turnAt(0, [
      { type: 'add_step', afterRowId: null, reason: 'x', text: 'Lonely' },
      {
        type: 'edit_item',
        reason: 'It says why now.',
        explanationMd: 'The old key leaked.',
        previous: { explanationMd: '' },
      },
      { type: 'cannot_do', reason: 'No step is current' },
    ]);
    // No list and no walk: there is nothing to add a step to.
    expect(outcomesOf(await settle(opened))).toEqual([
      ['add_step', 'skipped'],
      ['edit_item', 'landed'],
      ['cannot_do', 'landed'],
    ]);
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).explanationMd,
    ).toBe('The old key leaked.');
  });

  it('a job that returned no turn settles as failed and lands nothing', async () => {
    const card = await manualCard();
    await addRows(card.id, ['One']);
    const opened = await open(card.identifier);
    declareGuide([{}]);
    const settled = await settle(opened);
    expect(settled.outcome).toBe('failed');
    expect(settled.session.turns.filter((t) => t.role === 'assistant')).toHaveLength(0);
  });

  it('a blank reply, and a retry of a turn that is not the person’s, are refused', async () => {
    const card = await manualCard();
    turnAt(0, [], 'Ready.');
    const opened = await open(card.identifier);
    const landed = await settle(opened);
    const blank = await guide(post('/api/ai/guide', { sessionId: opened.session.id, text: '   ' }));
    expect(blank.status).toBe(400);
    const assistant = landed.session.turns.find((t) => t.role === 'assistant')!;
    const retry = await guide(
      post('/api/ai/guide', { sessionId: opened.session.id, turnId: assistant.id }),
    );
    expect(retry.status).toBe(404);
    expect(guideJobs()).toHaveLength(1);
  });

  it('a settle for a job the thread never sent is silent; for a non-guide thread, 404', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    const res = await guideSettle(
      post('/api/ai/guide/settle', {
        jobId: 'e2e-guide_work_item-99',
        sessionId: opened.session.id,
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ outcome: 'silent' });

    const planning = await adminDb.planChangeSession.create({
      data: {
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        createdById: fx.ownerId,
        origin: 'conversation',
      },
    });
    const notGuide = await guideSettle(
      post('/api/ai/guide/settle', { jobId: opened.jobId, sessionId: planning.id }),
    );
    expect(notGuide.status).toBe(404);
  });
});
