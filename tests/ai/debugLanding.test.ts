import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { DebugLandingDto, PlanChangeSessionDto } from '@/lib/dto/planChange';
import { triageService } from '@/lib/services/triageService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { openTestSession } from '../helpers/planSession';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';

// LANDING a debug turn (Story MOTIR-7042 · MOTIR-7049), route-level against a
// REAL Postgres — `docs/decisions/conversation-turn-intent.md` AMENDMENT 1 · A1.4.
// Only `getSession` / `getActiveProject` and the motir-ai client (the HTTP
// boundary: `submitJob` / `getJob`) are mocked, as `askDebugIntent.test.ts` does;
// the settle route → aiAskService → debugLandingService → the comment / update /
// triage-intake authorities → the database run for real.
//
// Each case drives the WHOLE loop: an ask turn, its `ask_project` settle reading
// `debug` (which dispatches `debug_bug`), then the settle of that debug job with a
// `debugBug` result — and then reads the database to check that exactly the one
// card A1.4 names changed, and nothing else did.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn();
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

const { POST: ask } = await import('@/app/api/ai/ask/route');
const { POST: settle } = await import('@/app/api/ai/ask/settle/route');
const { DEBUG_DIAGNOSIS_DIVIDER, DEBUG_UNGROUNDED_REPLY } =
  await import('@/lib/services/debugLandingService');

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ── The motir-ai side ─────────────────────────────────────────────────────────

/** Job results by id — `getJob` answers from here. */
const jobs = new Map<string, unknown>();

const DESCRIPTION = [
  'Saving a comment strips every `@mention` token before the body is stored.',
  '',
  '## Acceptance criteria',
  '',
  '- A saved comment keeps its mention chips.',
  '',
  '## Candidate mechanisms',
  '',
  'None of these is established.',
  '',
  '- The sanitizer drops the `mention:` scheme.',
  '- The editor serializes before the picker commits.',
  '',
  '## Context refs',
  '',
  '- `lib/services/commentsService.ts`',
].join('\n');

const DIAGNOSIS = {
  descriptionMd: DESCRIPTION,
  explanationMd: 'Mentions are how people get pulled into a thread; losing them silences it.',
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 2,
  estimateMinutes: 60,
  difficulty: 'medium',
  contextRefs: ['lib/services/commentsService.ts'],
  candidateMechanisms: [
    'The sanitizer drops the `mention:` scheme.',
    'The editor serializes before the picker commits.',
  ],
  grounded: true,
  groundingReason: 'indexed',
  title: 'Saving a comment drops its @mentions',
  acceptanceCriteria: ['A saved comment keeps its mention chips.'],
};

const diagnose = (anchorKey: string | null, extra: Record<string, unknown> = {}) => ({
  ...DIAGNOSIS,
  outcome: 'diagnose',
  anchorKey,
  replyMd: 'No existing card covers this, so the diagnosis goes on a new bug in Triage.',
  ...extra,
});
const enrich = (workItemKey: string, anchorKey: string | null) => ({
  ...DIAGNOSIS,
  outcome: 'enrich_existing',
  workItemKey,
  matchReason: 'It already describes mentions vanishing on save.',
  anchorKey,
  replyMd: `${workItemKey} already covers this defect, so the diagnosis goes there.`,
});

// ── The loop ──────────────────────────────────────────────────────────────────

/** Send a turn, settle its `ask_project` job as a `debug` verdict, and return the
 *  `debug_bug` job the dispatch submitted — whose result is `debugBug`. */
async function debugTurn(debugBug: unknown, anchorKey?: string): Promise<string> {
  const askRes = await ask(
    post('/api/ai/ask', { body: 'Saving a comment drops the mention', anchorKey }),
  );
  expect(askRes.status).toBe(200);
  const { jobId: askJobId } = (await askRes.json()) as { jobId: string };
  jobs.set(askJobId, {
    status: 'succeeded',
    result: {
      ask: { intent: 'debug', answer: null, citations: [], ...(anchorKey ? { anchorKey } : {}) },
    },
  });
  const dispatched = (await (
    await settle(post('/api/ai/ask/settle', { jobId: askJobId }))
  ).json()) as {
    outcome: string;
    jobId: string;
  };
  expect(dispatched.outcome).toBe('debugging');
  jobs.set(dispatched.jobId, { status: 'succeeded', result: { debugBug } });
  return dispatched.jobId;
}

interface Debugged {
  outcome: 'debugged';
  landing: DebugLandingDto;
  session: PlanChangeSessionDto;
}
const settleDebug = (jobId: string) => settle(post('/api/ai/ask/settle', { jobId }));

// ── Reading the database ──────────────────────────────────────────────────────

/** Everything A1.4 says a debug turn may NEVER move — status, kind, parent,
 *  sprint, the triage marker — for every card in the project, plus every edge. */
async function frozenFacts() {
  const items = await adminDb.workItem.findMany({
    where: { projectId: fx.projectId },
    select: {
      id: true,
      status: true,
      kind: true,
      parentId: true,
      sprintId: true,
      triagedAt: true,
      archivedAt: true,
    },
    orderBy: { id: 'asc' },
  });
  const edges = await adminDb.workItemLink.findMany({
    where: { kind: { not: 'relates_to' } },
    select: { fromId: true, toId: true, kind: true },
  });
  return { items, edges };
}

const itemCount = () => adminDb.workItem.count({ where: { projectId: fx.projectId } });
const commentCount = () =>
  adminDb.comment.count({ where: { workItem: { projectId: fx.projectId } } });

async function thread() {
  return openTestSession(activeCtx.current!);
}
const assistantTurns = async () => (await thread()).turns.filter((t) => t.role === 'assistant');

// ── Fixtures ──────────────────────────────────────────────────────────────────

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  jobs.clear();
  let n = 0;
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async (kind: unknown) => ({
    jobId: `job-${String(kind)}-${++n}`,
  }));
  getJobMock.mockReset();
  getJobMock.mockImplementation(async (jobId: string) => {
    const view = jobs.get(jobId);
    if (!view) throw new Error(`unknown job ${jobId}`);
    return { jobId, error: null, ...(view as object) };
  });
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

/** The triage bug the report widget files — the widget path's anchor. */
function fileTriageBug(descriptionMd = 'Type @someone, save — the mention is gone.') {
  return triageService.createSubmission(
    {
      projectKey: fx.projectIdentifier,
      kind: 'bug',
      title: 'Mention disappears',
      descriptionMd,
    },
    fx.ctx,
  );
}

// ── A1.4, row by row ──────────────────────────────────────────────────────────

describe('enrich_existing — an existing card covers the defect', () => {
  it('adds ONE comment to that card and relates it to the anchored triage bug — nothing else', async () => {
    const existing = await createTestWorkItem(fx, { kind: 'bug', title: 'Mentions vanish' });
    const triaged = await fileTriageBug();
    const jobId = await debugTurn(
      enrich(existing.identifier, triaged.identifier),
      triaged.identifier,
    );

    const before = await frozenFacts();
    const itemsBefore = await itemCount();
    const triagedBefore = await adminDb.workItem.findUniqueOrThrow({ where: { id: triaged.id } });
    const existingBefore = await adminDb.workItem.findUniqueOrThrow({ where: { id: existing.id } });

    const res = await settleDebug(jobId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Debugged;
    expect(body.outcome).toBe('debugged');
    expect(body.landing).toEqual({
      outcome: 'enrich_existing',
      workItemKey: existing.identifier,
      title: 'Mentions vanish',
      createdInTriage: false,
    });

    // The ONE write: a comment by the sender, carrying the diagnosis.
    const comments = await adminDb.comment.findMany({
      where: { workItem: { projectId: fx.projectId } },
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.workItemId).toBe(existing.id);
    expect(comments[0]!.authorId).toBe(fx.ownerId);
    expect(comments[0]!.bodyMd).toContain('The sanitizer drops the `mention:` scheme.');
    expect(comments[0]!.bodyMd).toContain('`lib/services/commentsService.ts`');
    expect(comments[0]!.bodyMd).toContain(`[${triaged.identifier}](motir:${triaged.id})`);

    // …which relates the two, both halves of the pair.
    const links = await adminDb.workItemLink.findMany({ where: { kind: 'relates_to' } });
    expect(links.map((l) => [l.fromId, l.toId]).sort()).toEqual(
      [
        [existing.id, triaged.id],
        [triaged.id, existing.id],
      ].sort(),
    );

    // Nothing new filed; neither card's fields touched; no status or edge moved.
    expect(await itemCount()).toBe(itemsBefore);
    const triagedAfter = await adminDb.workItem.findUniqueOrThrow({ where: { id: triaged.id } });
    expect(triagedAfter.descriptionMd).toBe(triagedBefore.descriptionMd);
    const existingAfter = await adminDb.workItem.findUniqueOrThrow({ where: { id: existing.id } });
    expect(existingAfter.descriptionMd).toBe(existingBefore.descriptionMd);
    expect(existingAfter.explanationMd).toBe(existingBefore.explanationMd);
    expect(await frozenFacts()).toEqual(before);

    // The reply is on the thread, citing the ONE card touched.
    const replies = await assistantTurns();
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toBe(
      `${existing.identifier} already covers this defect, so the diagnosis goes there.`,
    );
    expect(replies[0]!.citations).toEqual([existing.identifier]);
    expect(replies[0]!.jobId).toBe(jobId);
  });

  it('a named card that does not resolve in the active project is a 404 — and writes nothing', async () => {
    const jobId = await debugTurn(enrich('PROD-9999', null));
    const before = { items: await itemCount(), comments: await commentCount() };

    const res = await settleDebug(jobId);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'NOT_FOUND' });

    expect({ items: await itemCount(), comments: await commentCount() }).toEqual(before);
    expect(await assistantTurns()).toHaveLength(0);
  });
});

describe('diagnose, anchored on a triage bug — the widget path', () => {
  it("writes the diagnosis onto that bug BENEATH the reporter's own text, filling only empty fields", async () => {
    const triaged = await fileTriageBug();
    // A field the person set is theirs — it must survive the diagnosis.
    await adminDb.workItem.update({ where: { id: triaged.id }, data: { estimateMinutes: 15 } });
    const jobId = await debugTurn(diagnose(triaged.identifier), triaged.identifier);
    const before = await frozenFacts();
    const itemsBefore = await itemCount();

    const res = await settleDebug(jobId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Debugged;
    expect(body.landing).toEqual({
      outcome: 'diagnose',
      workItemKey: triaged.identifier,
      title: 'Mention disappears',
      createdInTriage: false,
    });

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: triaged.id } });
    // ADDED, never replaced: the report as filed, a rule, then the diagnosis.
    expect(
      row.descriptionMd!.startsWith('Type @someone, save — the mention is gone.\n\n---\n\n'),
    ).toBe(true);
    expect(row.descriptionMd).toContain(DEBUG_DIAGNOSIS_DIVIDER);
    expect(row.descriptionMd).toContain('## Acceptance criteria');
    expect(row.descriptionMd).toContain('## Candidate mechanisms');
    expect(row.descriptionMd).toContain('`lib/services/commentsService.ts`');
    expect(row.title).toBe('Mention disappears');
    expect(row.explanationMd).toBe(DIAGNOSIS.explanationMd);
    expect(row.explanationSource).toBe('ai_draft');
    expect(row.type).toBe('code');
    expect(row.executor).toBe('coding_agent');
    expect(Number(row.storyPoints)).toBe(2);
    expect(row.difficulty).toBe('medium');
    expect(row.estimateMinutes).toBe(15);

    // Still in Triage, never promoted; no second bug, no comment, nothing moved.
    expect(row.triagedAt).not.toBeNull();
    expect(await itemCount()).toBe(itemsBefore);
    expect(await commentCount()).toBe(0);
    expect(await frozenFacts()).toEqual(before);

    const replies = await assistantTurns();
    expect(replies.map((t) => t.citations)).toEqual([[triaged.identifier]]);
  });

  it('refuses an anchor that is not a bug in Triage (422) and writes nothing', async () => {
    const promoted = await createTestWorkItem(fx, { kind: 'bug', title: 'Already planned' });
    const jobId = await debugTurn(diagnose(promoted.identifier), promoted.identifier);
    const rowBefore = await adminDb.workItem.findUniqueOrThrow({ where: { id: promoted.id } });

    const res = await settleDebug(jobId);
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'DEBUG_ANCHOR_NOT_TRIAGE_BUG' });
    const rowAfter = await adminDb.workItem.findUniqueOrThrow({ where: { id: promoted.id } });
    expect(rowAfter.updatedAt).toEqual(rowBefore.updatedAt);
    expect(await assistantTurns()).toHaveLength(0);
  });
});

describe('diagnose, no anchor — the orb path', () => {
  it('files ONE bug into Triage through the intake, born with the diagnosis', async () => {
    const other = await createTestWorkItem(fx, { kind: 'task', title: 'Unrelated' });
    const jobId = await debugTurn(diagnose(null));
    const before = await frozenFacts();

    const res = await settleDebug(jobId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Debugged;
    expect(body.landing).toMatchObject({
      outcome: 'diagnose',
      title: DIAGNOSIS.title,
      createdInTriage: true,
    });

    const created = await adminDb.workItem.findMany({
      where: { projectId: fx.projectId, id: { not: other.id } },
    });
    expect(created).toHaveLength(1);
    const bug = created[0]!;
    expect(body.landing.workItemKey).toBe(bug.identifier);
    expect(bug.kind).toBe('bug');
    expect(bug.parentId).toBeNull();
    expect(bug.triagedAt).not.toBeNull();
    expect(bug.submittedByUserId).toBe(fx.ownerId);
    expect(bug.reporterId).toBe(fx.ownerId);
    expect(bug.title).toBe(DIAGNOSIS.title);
    expect(bug.descriptionMd).toBe(DESCRIPTION);
    expect(bug.explanationMd).toBe(DIAGNOSIS.explanationMd);
    expect(bug.explanationSource).toBe('ai_draft');
    expect(bug.type).toBe('code');
    expect(bug.estimateMinutes).toBe(60);

    // The card that was already there is exactly as it stood.
    const after = await frozenFacts();
    expect(after.items.filter((i) => i.id !== bug.id)).toEqual(before.items);
    expect(after.edges).toEqual(before.edges);

    expect((await assistantTurns()).map((t) => t.citations)).toEqual([[bug.identifier]]);
  });
});

describe('an ungrounded report', () => {
  it.each([
    [
      'diagnose',
      () => diagnose(null, { grounded: false, groundingReason: 'no_match', contextRefs: [] }),
    ],
    ['enrich_existing', () => ({ ...enrich('PROD-1', null), grounded: false, contextRefs: [] })],
  ])('(%s) writes NO card and answers that it could not ground it', async (_label, make) => {
    await createTestWorkItem(fx, { kind: 'bug', title: 'Mentions vanish' });
    const jobId = await debugTurn(make());
    const before = {
      items: await itemCount(),
      comments: await commentCount(),
      facts: await frozenFacts(),
    };

    const res = await settleDebug(jobId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Debugged;
    expect(body.landing).toEqual({
      outcome: 'ungrounded',
      workItemKey: null,
      title: null,
      createdInTriage: false,
    });
    expect({
      items: await itemCount(),
      comments: await commentCount(),
      facts: await frozenFacts(),
    }).toEqual(before);
    const replies = await assistantTurns();
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toBe(DEBUG_UNGROUNDED_REPLY);
    expect(replies[0]!.citations).toEqual([]);
  });
});

// ── Exactly once ──────────────────────────────────────────────────────────────

describe('a replayed settle', () => {
  it('returns the SAME DTO and writes nothing — no second bug, no second reply', async () => {
    const jobId = await debugTurn(diagnose(null));
    const first = (await (await settleDebug(jobId)).json()) as Debugged;
    const itemsAfterFirst = await itemCount();

    const replay = await settleDebug(jobId);
    expect(replay.status).toBe(200);
    const second = (await replay.json()) as Debugged;
    expect(second.outcome).toBe('debugged');
    expect(second.landing).toEqual(first.landing);

    expect(await itemCount()).toBe(itemsAfterFirst);
    expect(await assistantTurns()).toHaveLength(1);
  });

  it('two CONCURRENT settles of one job file one bug', async () => {
    const jobId = await debugTurn(diagnose(null));
    const results = await Promise.all([settleDebug(jobId), settleDebug(jobId)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);

    const bugs = await adminDb.workItem.findMany({ where: { projectId: fx.projectId } });
    expect(bugs).toHaveLength(1);
    expect(await assistantTurns()).toHaveLength(1);
  });

  it('an enrichment replayed adds no second comment', async () => {
    const existing = await createTestWorkItem(fx, { kind: 'bug', title: 'Mentions vanish' });
    const jobId = await debugTurn(enrich(existing.identifier, null));
    await settleDebug(jobId);
    const replay = (await (await settleDebug(jobId)).json()) as Debugged;
    expect(replay.landing.workItemKey).toBe(existing.identifier);
    expect(await commentCount()).toBe(1);
  });
});

// ── A malformed result ────────────────────────────────────────────────────────

describe('a malformed result', () => {
  it.each([
    ['descriptionMd', diagnose(null, { descriptionMd: 'No sections at all.' })],
    ['candidateMechanisms', diagnose(null, { candidateMechanisms: ['only one'] })],
    ['storyPoints', diagnose(null, { storyPoints: 4 })],
    ['title', diagnose(null, { title: '' })],
    ['outcome', diagnose(null, { outcome: 'file_two_bugs' })],
  ])('is refused at %s with a typed 502 and writes nothing', async (field, bad) => {
    const jobId = await debugTurn(bad);

    const res = await settleDebug(jobId);
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_AUTHORED_BUG', field });
    expect(await itemCount()).toBe(0);
    expect(await assistantTurns()).toHaveLength(0);
  });

  it('claims nothing — the same turn lands once a valid result is read', async () => {
    const jobId = await debugTurn(diagnose(null, { storyPoints: 4 }));
    expect((await settleDebug(jobId)).status).toBe(502);

    jobs.set(jobId, { status: 'succeeded', result: { debugBug: diagnose(null) } });
    const res = await settleDebug(jobId);
    expect(res.status).toBe(200);
    expect(await itemCount()).toBe(1);
  });
});

// ── As the sender ─────────────────────────────────────────────────────────────

describe('every write runs as the sender', () => {
  it('a member who lost `work_item:edit` after the dispatch gets a 403 and nothing is written', async () => {
    const user = await createTestUser({ name: 'Reporter' });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    const role = await createCustomRoleAs({
      projectId: fx.projectId,
      ctx: fx.ctx,
      name: 'Debugger',
      permissions: ['project:browse', 'ai:plan', 'work_item:edit'],
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

    const jobId = await debugTurn(diagnose(null));
    // The role narrows while the diagnosis runs.
    const askOnly = await createCustomRoleAs({
      projectId: fx.projectId,
      ctx: fx.ctx,
      name: 'Ask only',
      permissions: ['project:browse', 'ai:plan'],
    });
    await setProjectRoleAs({
      key,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: user.id,
      role: askOnly.id,
    });

    const res = await settleDebug(jobId);
    expect(res.status).toBe(403);
    expect(await itemCount()).toBe(0);
    expect(await assistantTurns()).toHaveLength(0);
  });
});

// ── After a reload (MOTIR-7064) ───────────────────────────────────────────────
//
// A reload reads the thread back from the database (`openForScope` → the turn
// mapper) and has nothing else: no send-time anchor seed, no settle response. So
// what the rail needs to redraw the anchor chip and the outcome line must be ON
// the persisted turns — the `user` turn's anchor, the reply's landing.

describe('a settled debug turn, read back after a reload', () => {
  /** The thread exactly as a reload reads it, and its debug pair. */
  async function reloaded(jobId: string) {
    const turns = (await thread()).turns;
    const user = turns.find((t) => t.role === 'user' && t.jobId === jobId);
    const reply = turns.find((t) => t.role === 'assistant' && t.jobId === jobId);
    return { turns, user: user!, reply: reply! };
  }

  it('diagnose onto the anchored triage bug: the anchor and the landing survive', async () => {
    const triaged = await fileTriageBug();
    const jobId = await debugTurn(diagnose(triaged.identifier), triaged.identifier);
    const body = (await (await settleDebug(jobId)).json()) as Debugged;

    const { user, reply } = await reloaded(jobId);
    expect(user.anchorKey).toBe(triaged.identifier);
    expect(reply.debugLanding).toEqual(body.landing);
    expect(reply.debugLanding).toEqual({
      outcome: 'diagnose',
      workItemKey: triaged.identifier,
      title: 'Mention disappears',
      createdInTriage: false,
    });
  });

  it('enrich_existing on the widget path: the anchor and the covering card survive', async () => {
    const existing = await createTestWorkItem(fx, { kind: 'bug', title: 'Mentions vanish' });
    const triaged = await fileTriageBug();
    const jobId = await debugTurn(
      enrich(existing.identifier, triaged.identifier),
      triaged.identifier,
    );
    const body = (await (await settleDebug(jobId)).json()) as Debugged;

    const { user, reply } = await reloaded(jobId);
    expect(user.anchorKey).toBe(triaged.identifier);
    expect(reply.debugLanding).toEqual(body.landing);
    expect(reply.debugLanding?.workItemKey).toBe(existing.identifier);
  });

  it('diagnose from the orb: no anchor, and the bug it FILED in Triage survives', async () => {
    const jobId = await debugTurn(diagnose(null));
    const body = (await (await settleDebug(jobId)).json()) as Debugged;

    const { user, reply } = await reloaded(jobId);
    expect(user.anchorKey).toBeNull();
    expect(reply.debugLanding).toEqual(body.landing);
    expect(reply.debugLanding).toMatchObject({ outcome: 'diagnose', createdInTriage: true });
  });

  it('ungrounded: the "nothing was written" landing survives', async () => {
    const triaged = await fileTriageBug();
    const jobId = await debugTurn(
      diagnose(triaged.identifier, { grounded: false, groundingReason: 'no_match' }),
      triaged.identifier,
    );
    await settleDebug(jobId);

    const { user, reply } = await reloaded(jobId);
    expect(user.anchorKey).toBe(triaged.identifier);
    expect(reply.debugLanding).toEqual({
      outcome: 'ungrounded',
      workItemKey: null,
      title: null,
      createdInTriage: false,
    });
  });

  it('a replayed settle leaves the persisted landing as it was', async () => {
    const jobId = await debugTurn(diagnose(null));
    const first = (await (await settleDebug(jobId)).json()) as Debugged;
    await settleDebug(jobId);

    const { reply } = await reloaded(jobId);
    expect(reply.debugLanding).toEqual(first.landing);
  });

  it('an ordinary answered ask carries neither — it renders exactly as before', async () => {
    const askRes = await ask(post('/api/ai/ask', { body: 'What is in the sprint?' }));
    const { jobId } = (await askRes.json()) as { jobId: string };
    jobs.set(jobId, {
      status: 'succeeded',
      result: { ask: { intent: 'ask', answer: 'Two cards.', citations: [] } },
    });
    expect((await settle(post('/api/ai/ask/settle', { jobId }))).status).toBe(200);

    const { user, reply } = await reloaded(jobId);
    expect(user.anchorKey).toBeNull();
    expect(user.debugLanding).toBeNull();
    expect(reply.body).toBe('Two cards.');
    expect(reply.anchorKey).toBeNull();
    expect(reply.debugLanding).toBeNull();
  });
});
