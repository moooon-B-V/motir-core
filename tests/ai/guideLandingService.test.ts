import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import { commentsService } from '@/lib/services/commentsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemsService } from '@/lib/services/workItemsService';
import { manualWorkGateService } from '@/lib/services/manualWorkGateService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPr } from '../helpers/prLink';

// LANDING a guide turn (Story MOTIR-7459 · MOTIR-7470), route-level against a
// REAL Postgres — `docs/decisions/conversation-turn-intent.md` AMENDMENT 2,
// A2.4–A2.6. Only `getSession` / `getActiveProject` and the motir-ai client are
// mocked; every write runs through the service that owns it.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-1' }));
const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: (...args: unknown[]) => getJobMock(...(args as [])),
  streamJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { POST: guide } = await import('@/app/api/ai/guide/route');
const { POST: guideSettle } = await import('@/app/api/ai/guide/settle/route');
const { POST: askSettle } = await import('@/app/api/ai/ask/settle/route');

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Opened {
  jobId: string;
  session: PlanChangeSessionDto;
}
interface Settled {
  outcome: string;
  session: PlanChangeSessionDto;
  record?: { outcomes: Array<{ type: string; outcome: string; reason?: string }> };
}

let fx: WorkItemFixture;
let jobN = 0;

async function manualCard(title = 'Rotate the signing key') {
  const item = await createTestWorkItem(fx, {
    kind: 'task',
    title,
    type: 'manual',
    executor: 'human',
  });
  // The fixture writes the legacy `open`; a real card sits on a workflow status.
  return adminDb.workItem.update({ where: { id: item.id }, data: { status: 'todo' } });
}

async function open(identifier: string): Promise<Opened> {
  const res = await guide(post('/api/ai/guide', { itemKey: identifier }));
  expect(res.status).toBe(200);
  return (await res.json()) as Opened;
}

async function next(sessionId: string, text: string): Promise<Opened> {
  const res = await guide(post('/api/ai/guide', { sessionId, text }));
  expect(res.status).toBe(200);
  return (await res.json()) as Opened;
}

/** Make the job settle with this guide turn, then settle it. */
async function settleWith(
  opened: Opened,
  actions: unknown[],
  messageMd = 'Here is the next step.',
): Promise<Settled> {
  getJobMock.mockResolvedValue({
    status: 'succeeded',
    result: { guideTurn: { messageMd, actions, dropped: [] } },
    error: null,
  });
  const res = await guideSettle(
    post('/api/ai/guide/settle', { jobId: opened.jobId, sessionId: opened.session.id }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Settled;
}

async function rows(workItemId: string) {
  return (await workItemTodosService.listTodos(workItemId, fx.ctx)).items;
}

async function addRows(workItemId: string, texts: string[]) {
  const ids: string[] = [];
  for (const text of texts) {
    ids.push((await workItemTodosService.addTodo(workItemId, { text }, fx.ctx)).todo.id);
  }
  return ids;
}

const outcomesOf = (s: Settled) => s.record!.outcomes.map((o) => [o.type, o.outcome]);

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-guide-${++jobN}` }));
  getJobMock.mockReset();
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'test-service-token');
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('write_todos', () => {
  it('creates the rows IN ORDER on a card with none, with the ticks so far', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [
      {
        type: 'write_todos',
        rows: [
          { fromId: 'tmp-1', text: 'Open the console', done: true },
          { fromId: 'tmp-2', text: 'Rotate', commandText: 'motir keys rotate', done: false },
        ],
      },
    ]);
    expect(outcomesOf(settled)).toEqual([['write_todos', 'landed']]);
    const list = await rows(card.id);
    expect(list.map((r) => [r.text, r.done, r.commandText])).toEqual([
      ['Open the console', true, null],
      ['Rotate', false, 'motir keys rotate'],
    ]);
    expect(list[0]!.doneBy?.id).toBe(fx.ownerId);
  });

  it('creates nothing on a card that already has rows', async () => {
    const card = await manualCard();
    await addRows(card.id, ['Existing']);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [
      { type: 'write_todos', rows: [{ fromId: 'tmp-1', text: 'New', done: false }] },
    ]);
    expect(outcomesOf(settled)).toEqual([['write_todos', 'skipped']]);
    expect((await rows(card.id)).map((r) => r.text)).toEqual(['Existing']);
  });
});

describe('tick / untick', () => {
  it('ticks as the person and unticks, and a row from another card is skipped while the rest land', async () => {
    const card = await manualCard();
    const [r1, r2] = await addRows(card.id, ['One', 'Two']);
    const other = await manualCard('Other');
    const [foreign] = await addRows(other.id, ['Theirs']);
    await workItemTodosService.setTodoDone(r2!, true, fx.ctx);

    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [
      { type: 'tick', rowId: foreign },
      { type: 'tick', rowId: r1 },
      { type: 'untick', rowId: r2 },
    ]);
    expect(outcomesOf(settled)).toEqual([
      ['tick', 'skipped'],
      ['tick', 'landed'],
      ['untick', 'landed'],
    ]);
    const list = await rows(card.id);
    expect(list.map((r) => r.done)).toEqual([true, false]);
    expect(list[0]!.doneBy?.id).toBe(fx.ownerId);
    expect((await rows(other.id))[0]!.done).toBe(false);
    // The turn says what did not land, and why.
    expect(settled.session.turns.at(-1)!.body).toContain('Some of that did not land:');
  });

  it('a tick on a row already done is skipped, not an error', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['One']);
    await workItemTodosService.setTodoDone(r1!, true, fx.ctx);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [{ type: 'tick', rowId: r1 }]);
    expect(outcomesOf(settled)).toEqual([['tick', 'skipped']]);
  });
});

describe('corrections on a saved list', () => {
  it('add, revise, remove and move each change the rows as stated', async () => {
    const card = await manualCard();
    const [a, b, c] = await addRows(card.id, ['A', 'B', 'C']);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [
      { type: 'add_step', afterRowId: a, reason: 'Missing', text: 'A2' },
      { type: 'revise_step', rowId: b, reason: 'Clearer', text: 'B!' },
      { type: 'remove_step', rowId: c, reason: 'Not needed' },
      { type: 'move_step', rowId: a, afterRowId: b, reason: 'Order' },
    ]);
    expect(outcomesOf(settled).map((o) => o[1])).toEqual(['landed', 'landed', 'landed', 'landed']);
    expect((await rows(card.id)).map((r) => r.text)).toEqual(['A2', 'B!', 'A']);
  });

  it('a correction naming a TICKED row changes nothing', async () => {
    const card = await manualCard();
    const [a] = await addRows(card.id, ['A', 'B']);
    await workItemTodosService.setTodoDone(a!, true, fx.ctx);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [
      { type: 'revise_step', rowId: a, reason: 'x', text: 'Changed' },
      { type: 'remove_step', rowId: a, reason: 'x' },
      { type: 'move_step', rowId: a, afterRowId: null, reason: 'x' },
    ]);
    expect(outcomesOf(settled).map((o) => o[1])).toEqual(['skipped', 'skipped', 'skipped']);
    expect((await rows(card.id)).map((r) => [r.text, r.done])).toEqual([
      ['A', true],
      ['B', false],
    ]);
  });
});

describe('edit_item', () => {
  it('changes the guided card as the person, and a second edit restores it', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    await settleWith(opened, [
      {
        type: 'edit_item',
        reason: 'The scope changed',
        descriptionMd: 'Rotate both keys.',
        previous: { descriptionMd: '' },
      },
    ]);
    const edited = await workItemsService.getWorkItem(card.id, fx.ctx);
    expect(edited.descriptionMd).toBe('Rotate both keys.');
    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: card.id, changeKind: 'updated' },
    });
    expect(revisions.some((r) => r.changedById === fx.ownerId)).toBe(true);

    const again = await next(opened.session.id, 'Put it back');
    await settleWith(again, [
      {
        type: 'edit_item',
        reason: 'Undo',
        descriptionMd: '',
        previous: { descriptionMd: 'Rotate both keys.' },
      },
    ]);
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).descriptionMd ?? '').toBe('');
  });

  it('an edit naming another field is refused whole and changes nothing', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    getJobMock.mockResolvedValue({
      status: 'succeeded',
      result: {
        guideTurn: {
          messageMd: 'x',
          actions: [{ type: 'edit_item', reason: 'x', status: 'done', title: 'T' }],
        },
      },
      error: null,
    });
    const res = await guideSettle(
      post('/api/ai/guide/settle', { jobId: opened.jobId, sessionId: opened.session.id }),
    );
    expect(res.status).toBe(502);
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).title).toBe(
      'Rotate the signing key',
    );
  });
});

describe('cannot_do', () => {
  it('adds ONE comment naming the step and the reason', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Log in to the vault']);
    const opened = await open(card.identifier);
    await settleWith(opened, [
      { type: 'current_step', rowId: r1 },
      { type: 'cannot_do', reason: 'Needs an admin you do not have' },
    ]);
    const comments = await commentsService.listComments(card.id, {}, fx.ctx);
    const bodies = JSON.stringify(comments);
    expect(bodies).toContain('Log in to the vault');
    expect(bodies).toContain('Needs an admin you do not have');
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);
  });
});

describe('close', () => {
  it('moves the card to Done with a summary comment when every row is ticked and no PR is linked', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Only step']);
    await workItemTodosService.setTodoDone(r1!, true, fx.ctx);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [{ type: 'close' }], 'All done, closing it.');
    expect(settled.record!.outcomes[0]!.reason).toBeUndefined();
    expect(outcomesOf(settled)).toEqual([['close', 'landed']]);
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).status).toBe('done');
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);
  });

  it('DECIDES a pending manual-work gate through the decide door — Mark done, as the person (MOTIR-7474)', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Only step']);
    await workItemTodosService.setTodoDone(r1!, true, fx.ctx);
    await withWorkspaceContext(fx.ctx, (tx) =>
      manualWorkGateService.raise(card.id, { createdById: fx.ownerId }, fx.workspaceId, tx),
    );
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [{ type: 'close' }], 'All done, closing it.');
    expect(outcomesOf(settled)).toEqual([['close', 'landed']]);
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).status).toBe('done');
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: card.id, kind: 'manual_work' },
    });
    expect(gate).toMatchObject({ state: 'approved', decidedById: fx.ownerId });
  });

  it('lands nothing while a row is unticked', async () => {
    const card = await manualCard();
    await addRows(card.id, ['Not yet']);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [{ type: 'close' }]);
    expect(settled.record!.outcomes[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'not every step is ticked',
    });
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).status).not.toBe('done');
  });

  it('lands nothing when a pull request is linked — its merge closes the card', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Only step']);
    await workItemTodosService.setTodoDone(r1!, true, fx.ctx);
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: { installationId: '7470', accountLogin: 'moooon', accountType: 'Organization' },
      repos: [
        {
          providerRepoId: '747001',
          owner: 'moooon',
          name: 'acme',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    await linkPr(
      {
        workItemId: card.id,
        projectId: fx.projectId,
        owner: 'moooon',
        name: 'acme',
        number: 12,
        headRef: 'subtask/guide',
      },
      fx.ctx,
    );
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [{ type: 'close' }]);
    expect(settled.record!.outcomes[0]).toMatchObject({ outcome: 'skipped' });
    expect(settled.record!.outcomes[0]!.reason).toContain('pull request');
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).status).not.toBe('done');
  });
});

describe('replay and failure', () => {
  it('settling the same job twice lands each action once', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['One']);
    const opened = await open(card.identifier);
    await settleWith(opened, [
      { type: 'tick', rowId: r1 },
      { type: 'cannot_do', reason: 'Stuck' },
    ]);
    const replay = await settleWith(opened, [
      { type: 'tick', rowId: r1 },
      { type: 'cannot_do', reason: 'Stuck' },
    ]);
    expect(replay.outcome).toBe('guided');
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);
    const replies = replay.session.turns.filter((t) => t.role === 'assistant');
    expect(replies).toHaveLength(1);
  });

  it('two CONCURRENT settles land once', async () => {
    const card = await manualCard();
    await addRows(card.id, ['One']);
    const opened = await open(card.identifier);
    getJobMock.mockResolvedValue({
      status: 'succeeded',
      result: { guideTurn: { messageMd: 'm', actions: [{ type: 'cannot_do', reason: 'Stuck' }] } },
      error: null,
    });
    const body = { jobId: opened.jobId, sessionId: opened.session.id };
    await Promise.all([
      guideSettle(post('/api/ai/guide/settle', body)),
      guideSettle(post('/api/ai/guide/settle', body)),
    ]);
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);
  });

  it('a failed job lands no action and appends no reply', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['One']);
    const opened = await open(card.identifier);
    getJobMock.mockResolvedValue({
      status: 'failed',
      result: { guideTurn: { messageMd: 'm', actions: [{ type: 'tick', rowId: r1 }] } },
      error: { code: 'out_of_credits' },
    });
    const res = await guideSettle(
      post('/api/ai/guide/settle', { jobId: opened.jobId, sessionId: opened.session.id }),
    );
    await expect(res.json()).resolves.toMatchObject({ outcome: 'failed' });
    expect((await rows(card.id))[0]!.done).toBe(false);
  });

  it('the ask settle door lands a guide session’s job too', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['One']);
    const opened = await open(card.identifier);
    getJobMock.mockResolvedValue({
      status: 'succeeded',
      result: { guideTurn: { messageMd: 'Ticked.', actions: [{ type: 'tick', rowId: r1 }] } },
      error: null,
    });
    const res = await askSettle(
      post('/api/ai/ask/settle', { jobId: opened.jobId, sessionId: opened.session.id }),
    );
    await expect(res.json()).resolves.toMatchObject({ outcome: 'guided' });
    expect((await rows(card.id))[0]!.done).toBe(true);
  });
});

describe('a temporary walk', () => {
  it('ticks write nothing to the card; saving mid-walk writes the rows with the ticks so far', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    await settleWith(opened, [
      {
        type: 'propose_todos',
        rows: [
          { id: 'tmp-1', text: 'Open the console' },
          { id: 'tmp-2', text: 'Rotate' },
        ],
      },
      { type: 'current_step', rowId: 'tmp-1' },
    ]);
    const second = await next(opened.session.id, 'Done with the first');
    // The next job reads the temporary list from the conversation.
    const ctx2 = (
      submitJobMock.mock.calls.at(-1)![2] as {
        guideContext: { todos: { temporary: boolean; rows: Array<{ id: string }> } };
      }
    ).guideContext;
    expect(ctx2.todos.temporary).toBe(true);
    expect(ctx2.todos.rows.map((r) => r.id)).toEqual(['tmp-1', 'tmp-2']);

    const ticked = await settleWith(second, [{ type: 'tick', rowId: 'tmp-1' }]);
    expect(outcomesOf(ticked)).toEqual([['tick', 'recorded']]);
    expect(await rows(card.id)).toHaveLength(0);

    const third = await next(opened.session.id, 'Save it');
    await settleWith(third, [
      {
        type: 'write_todos',
        rows: [
          { fromId: 'tmp-1', text: 'Open the console', done: true },
          { fromId: 'tmp-2', text: 'Rotate', done: false },
        ],
      },
    ]);
    expect((await rows(card.id)).map((r) => [r.text, r.done])).toEqual([
      ['Open the console', true],
      ['Rotate', false],
    ]);
  });
});
