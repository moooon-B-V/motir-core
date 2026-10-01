import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { ProjectContext } from '@/lib/projects';
import type { DebugLandingDto } from '@/lib/dto/planChange';
import type { AiJobsFixture } from '@/lib/test-ai-jobs-mock';
import { triageService } from '@/lib/services/triageService';
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
import { openTestSession } from '../helpers/planSession';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';

// THE DEBUG TURN'S INTEGRATION GATE (Story MOTIR-7042 · MOTIR-7051), against a
// REAL Postgres, as the non-bypass app role, with the motir-ai boundary crossed
// on the WIRE.
//
// The story's earlier files (`askDebugIntent`, `debugLanding`,
// `triageBugConversationAnchor`) mock `@/lib/ai/motirAiClient` as a module. This
// file does not: the real client builds and posts the envelope, and the ONE mock
// is `lib/test-ai-jobs-mock.ts` — the undici intercept the E2E lane uses — so a
// `debug_bug` job counted here is a `POST /v1/jobs` whose body says `debug_bug`,
// and the out-of-credits error is the real client's mapping of motir-ai's own
// `402 out_of_credits` problem. Besides that seam, only `getSession` /
// `getActiveProject` are mocked, as every ask-route suite does.
//
// What it adds over the earlier files, and nothing else:
//   * the whole path in one run — `debug` verdict → one `debug_bug` job on the
//     wire → landing → EXACTLY ONE card changed, measured over every card in the
//     project, for each of the three landing outcomes;
//   * a retried job writes nothing twice: the anchored diagnosis replayed (its
//     description appended ONCE), a retry of an already-landed turn, and the
//     retry after an out-of-credits dispatch;
//   * the triage exclusion against a fixture whose SCOPED read and TRUE set
//     differ by a known count, so "not present" cannot pass on an empty list.

const ORIGIN = 'http://motir-ai.debug-gate.test';

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

let fixturePath: string;
let agent: MockAgent;
/** Every `POST /v1/jobs` body the seam received, in order. */
const wire: { jobKind: string; context: Record<string, unknown> }[] = [];

beforeAll(async () => {
  fixturePath = join(mkdtempSync(join(tmpdir(), 'motir-debug-gate-')), 'jobs.json');
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
    wire.push(JSON.parse(raw) as { jobKind: string; context: Record<string, unknown> });
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await agent.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

const { POST: ask } = await import('@/app/api/ai/ask/route');
const { POST: settle } = await import('@/app/api/ai/ask/settle/route');

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ── The motir-ai side ─────────────────────────────────────────────────────────

function declare(fixture: AiJobsFixture): void {
  writeFileSync(fixturePath, JSON.stringify(fixture));
}
/** What the seam recorded — including a refused submit, which the observer
 *  above also sees but which never became a job. */
function recorded(): NonNullable<AiJobsFixture['submitted']> {
  return (JSON.parse(readFileSync(fixturePath, 'utf8')) as AiJobsFixture).submitted ?? [];
}
/** The `debug_bug` jobs that EXIST — accepted submits only. */
const debugJobs = () => recorded().filter((s) => s.kind === 'debug_bug' && !s.refused);
const wireKinds = () => wire.map((b) => b.jobKind);

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
const diagnose = (anchorKey: string | null) => ({
  ...DIAGNOSIS,
  outcome: 'diagnose',
  anchorKey,
  replyMd: 'The diagnosis is on the bug in Triage.',
});
const enrich = (workItemKey: string, anchorKey: string | null) => ({
  ...DIAGNOSIS,
  outcome: 'enrich_existing',
  workItemKey,
  matchReason: 'It already describes mentions vanishing on save.',
  anchorKey,
  replyMd: `${workItemKey} already covers this defect.`,
});

const REPORT = 'Saving a comment drops the mention';

/** Send the turn and settle its `ask_project` job — the classifier's `debug`
 *  verdict — returning the settle's response and the ask job's id. */
async function sendReport(anchorKey?: string) {
  const res = await ask(post('/api/ai/ask', { body: REPORT, ...(anchorKey ? { anchorKey } : {}) }));
  expect(res.status).toBe(200);
  const { jobId } = (await res.json()) as { jobId: string };
  return { askJobId: jobId, dispatched: await settle(post('/api/ai/ask/settle', { jobId })) };
}
const settleJob = (jobId: string) => settle(post('/api/ai/ask/settle', { jobId }));

// ── Reading the database: what changed, card by card ──────────────────────────

/** Every card in the project with every column a landing could touch, plus its
 *  comment count — so "exactly one card" is measured over the WHOLE project. */
async function cards() {
  const rows = await adminDb.workItem.findMany({
    where: { projectId: fx.projectId },
    include: { _count: { select: { comments: true } } },
    orderBy: { id: 'asc' },
  });
  return new Map(rows.map((r) => [r.id, JSON.stringify(r)]));
}
/** The ids of the cards created or changed between two snapshots. */
function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after.keys()].filter((id) => before.get(id) !== after.get(id));
}
async function userTurn() {
  const turns = (await openTestSession(activeCtx.current!)).turns.filter((t) => t.role === 'user');
  expect(turns).toHaveLength(1);
  return turns[0]!;
}
const assistantTurns = async () =>
  (await openTestSession(activeCtx.current!)).turns.filter((t) => t.role === 'assistant');

// ── Fixtures ──────────────────────────────────────────────────────────────────

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  wire.length = 0;
  declare({});
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

/** The triage bug the report widget files — the widget path's anchor. */
function fileTriageBug(title = 'Mention disappears') {
  return triageService.createSubmission(
    {
      projectKey: fx.projectIdentifier,
      kind: 'bug',
      title,
      descriptionMd: 'Type @someone, save — the mention is gone.',
    },
    fx.ctx,
  );
}

/** A member whose project role is a custom one holding exactly `permissions`. */
async function becomeMemberWith(permissions: string[]): Promise<void> {
  const user = await createTestUser({ name: 'Reporter' });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const role = await createCustomRoleAs({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name: 'Custom',
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

// ── The substrate ─────────────────────────────────────────────────────────────

describe('the substrate', () => {
  it('the code under test runs as the NON-BYPASS app role, and the jobs cross the real client', async () => {
    // Probed through the SAME bound context the services open (not a bare
    // statement on the singleton), so this is the role the code under test runs as.
    const [{ role }] = await withWorkspaceContext(
      fx.ctx,
      (tx) => tx.$queryRaw<[{ role: string }]>`SELECT current_user::text AS role`,
    );
    expect(role).toBe('motir_app');

    declare({ ask: [{ intent: 'ask', answer: 'It is the export story.' }] });
    const res = await ask(post('/api/ai/ask', { body: 'What is PROD-1?' }));
    expect(res.status).toBe(200);
    // The real client posted a v1 envelope; the seam named the job for its kind.
    expect(wire).toHaveLength(1);
    expect(wire[0]).toMatchObject({
      jobKind: 'ask_project',
      context: { prompt: 'What is PROD-1?' },
    });
    await expect(res.json()).resolves.toMatchObject({ jobId: 'e2e-ask_project-0' });
  });
});

// ── End to end: the verdict, the one job, the one card ────────────────────────

describe('a `debug` verdict, end to end — one `debug_bug` job, one card', () => {
  it('records `intent = debug` and submits EXACTLY ONE `debug_bug` job on the wire', async () => {
    const triaged = await fileTriageBug();
    declare({ ask: [{ intent: 'debug', anchorKey: triaged.identifier }] });

    const { askJobId, dispatched } = await sendReport(triaged.identifier);
    expect(dispatched.status).toBe(200);
    await expect(dispatched.json()).resolves.toMatchObject({
      outcome: 'debugging',
      jobId: 'e2e-debug_bug-0',
    });
    expect(wireKinds()).toEqual(['ask_project', 'debug_bug']);
    expect(wire[1]!.context).toEqual({ prompt: REPORT, anchorKey: triaged.identifier });

    const turn = await userTurn();
    expect(turn.intent).toBe('debug');
    expect(turn.jobId).toBe('e2e-debug_bug-0');

    // The ask job settled again — a reload, a second tab — dispatches nothing more.
    expect((await settleJob(askJobId)).status).toBe(200);
    expect(wireKinds()).toEqual(['ask_project', 'debug_bug']);
  });

  const cases: {
    name: string;
    arrange: () => Promise<{ anchorKey?: string; debugBug: unknown; target?: string }>;
    expectLanding: (target: string | undefined) => Partial<DebugLandingDto>;
  }[] = [
    {
      name: 'enrich_existing — a comment on the covering card, and nothing filed',
      arrange: async () => {
        const existing = await createTestWorkItem(fx, { kind: 'bug', title: 'Mentions vanish' });
        const triaged = await fileTriageBug();
        return {
          anchorKey: triaged.identifier,
          debugBug: enrich(existing.identifier, triaged.identifier),
          target: existing.id,
        };
      },
      expectLanding: () => ({ outcome: 'enrich_existing', createdInTriage: false }),
    },
    {
      name: 'diagnose, anchored — the diagnosis on the triage bug the widget filed',
      arrange: async () => {
        const triaged = await fileTriageBug();
        return {
          anchorKey: triaged.identifier,
          debugBug: diagnose(triaged.identifier),
          target: triaged.id,
        };
      },
      expectLanding: () => ({ outcome: 'diagnose', createdInTriage: false }),
    },
    {
      name: 'diagnose from the orb — ONE new bug, born in Triage',
      arrange: async () => ({ debugBug: diagnose(null) }),
      expectLanding: () => ({ outcome: 'diagnose', createdInTriage: true }),
    },
  ];

  it.each(cases)('$name: writes exactly one card', async ({ arrange, expectLanding }) => {
    // Bystanders on both sides of the triage line, so "one card" is a claim
    // about a project that holds several of each.
    await createTestWorkItem(fx, { kind: 'task', title: 'Planned bystander' });
    await fileTriageBug('Triage bystander');
    const { anchorKey, debugBug, target } = await arrange();
    declare({
      ask: [{ intent: 'debug', ...(anchorKey ? { anchorKey } : {}) }],
      debugBug: [{ debugBug }],
    });

    const { dispatched } = await sendReport(anchorKey);
    const { jobId } = (await dispatched.json()) as { jobId: string };
    const before = await cards();

    const res = await settleJob(jobId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; landing: DebugLandingDto };
    expect(body.outcome).toBe('debugged');
    expect(body.landing).toMatchObject(expectLanding(target));

    const after = await cards();
    const touched = changed(before, after);
    expect(touched).toHaveLength(1);
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: touched[0]! } });
    expect(body.landing.workItemKey).toBe(card.identifier);
    if (target) {
      expect(touched[0]).toBe(target);
      expect(after.size).toBe(before.size);
    } else {
      // The orb path: the one card is NEW, a bug, parentless, in Triage.
      expect(before.has(card.id)).toBe(false);
      expect(after.size).toBe(before.size + 1);
      expect(card.kind).toBe('bug');
      expect(card.parentId).toBeNull();
      expect(card.triagedAt).not.toBeNull();
      const queue = await triageService.getTriageQueue(fx.projectId, {}, fx.ctx);
      expect(queue.items.map((i) => i.id)).toContain(card.id);
    }
    // One job, one reply citing the one card.
    expect(debugJobs()).toHaveLength(1);
    expect((await assistantTurns()).map((t) => t.citations)).toEqual([[card.identifier]]);
  });
});

// ── A retried job writes nothing twice ────────────────────────────────────────

describe('a retried job writes nothing twice', () => {
  it('the anchored diagnosis, settled again, appends its diagnosis ONCE', async () => {
    const triaged = await fileTriageBug();
    declare({
      ask: [{ intent: 'debug', anchorKey: triaged.identifier }],
      debugBug: [{ debugBug: diagnose(triaged.identifier) }],
    });
    const { dispatched } = await sendReport(triaged.identifier);
    const { jobId } = (await dispatched.json()) as { jobId: string };

    expect((await settleJob(jobId)).status).toBe(200);
    const landed = await cards();
    const replay = await settleJob(jobId);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ outcome: 'debugged' });

    expect(changed(landed, await cards())).toEqual([]);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: triaged.id } });
    expect(row.descriptionMd!.split('## Candidate mechanisms')).toHaveLength(2);
    expect(await assistantTurns()).toHaveLength(1);
  });

  it('a RETRY of a turn that already landed runs a job whose settle writes nothing', async () => {
    declare({ ask: [{ intent: 'debug' }], debugBug: [{ debugBug: diagnose(null) }] });
    const { dispatched } = await sendReport();
    const { jobId } = (await dispatched.json()) as { jobId: string };
    expect((await settleJob(jobId)).status).toBe(200);
    const landed = await cards();
    expect(landed.size).toBe(1);

    const turn = await userTurn();
    const retry = await ask(post('/api/ai/ask', { turnId: turn.id }));
    expect(retry.status).toBe(200);
    const { jobId: retryJobId } = (await retry.json()) as { jobId: string };
    expect(retryJobId).toBe('e2e-debug_bug-1');

    const res = await settleJob(retryJobId);
    expect(res.status).toBe(200);
    // The turn's landing is claimed: the second job's identical result files no
    // second bug and appends no second reply.
    expect(changed(landed, await cards())).toEqual([]);
    expect((await cards()).size).toBe(1);
    expect(await assistantTurns()).toHaveLength(1);
  });

  it('out of credits at the dispatch is the typed 402 and no job; the retry lands ONE card, once', async () => {
    declare({
      ask: [{ intent: 'debug' }],
      debugBug: [{ submit: 'out_of_credits' }, { debugBug: diagnose(null) }],
    });
    const { dispatched } = await sendReport();
    expect(dispatched.status).toBe(402);
    await expect(dispatched.json()).resolves.toMatchObject({ code: 'MOTIR_AI_OUT_OF_CREDITS' });
    // The submit reached motir-ai and was refused there: no job exists, no card.
    expect(recorded().filter((s) => s.kind === 'debug_bug')).toEqual([
      expect.objectContaining({ refused: true }),
    ]);
    expect(debugJobs()).toHaveLength(0);
    expect((await cards()).size).toBe(0);
    expect((await userTurn()).intent).toBe('debug');

    const retry = await ask(post('/api/ai/ask', { turnId: (await userTurn()).id }));
    expect(retry.status).toBe(200);
    const { jobId } = (await retry.json()) as { jobId: string };
    expect(debugJobs()).toHaveLength(1);

    await settleJob(jobId);
    await settleJob(jobId);
    expect((await cards()).size).toBe(1);
    expect(await assistantTurns()).toHaveLength(1);
  });
});

// ── Permissions ───────────────────────────────────────────────────────────────

describe('permissions', () => {
  it('no `work_item:edit` → 403 at the dispatch, and NO `debug_bug` crosses the wire', async () => {
    await becomeMemberWith(['project:browse', 'ai:plan']);
    declare({ ask: [{ intent: 'debug' }], debugBug: [{ debugBug: diagnose(null) }] });

    const { dispatched } = await sendReport();
    expect(dispatched.status).toBe(403);
    await expect(dispatched.json()).resolves.toMatchObject({
      code: 'PERMISSION_DENIED',
      permission: 'work_item:edit',
    });
    expect(wireKinds()).toEqual(['ask_project']);
    expect((await cards()).size).toBe(0);
  });
});

// ── The triage exclusion, over a fixture where the scoped view and the true set differ

describe('a triage bug is a conversation target and stays out of /items', () => {
  it('the list reads hold exactly the true set MINUS the triage rows — and the keyed read resolves each', async () => {
    const planned = [
      await createTestWorkItem(fx, { kind: 'bug', title: 'Planned one' }),
      await createTestWorkItem(fx, { kind: 'task', title: 'Planned two' }),
      await createTestWorkItem(fx, { kind: 'story', title: 'Planned three' }),
    ];
    const widgetBug = await fileTriageBug();
    // …and one the ORB filed through the landing, so the intake path is in it.
    declare({ ask: [{ intent: 'debug' }], debugBug: [{ debugBug: diagnose(null) }] });
    const { dispatched } = await sendReport();
    const { jobId } = (await dispatched.json()) as { jobId: string };
    const landed = (await (await settleJob(jobId)).json()) as { landing: DebugLandingDto };
    const orbBug = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, identifier: landed.landing.workItemKey! },
    });

    // THE TRUE SET — the table, read past every policy.
    const trueSet = await adminDb.workItem.findMany({ where: { projectId: fx.projectId } });
    const triageIds = trueSet.filter((r) => r.triagedAt !== null).map((r) => r.id);
    expect(trueSet).toHaveLength(5);
    expect(triageIds.sort()).toEqual([widgetBug.id, orbBug.id].sort());

    // THE SCOPED VIEW — what /items reads. Strictly smaller, by exactly the
    // triage rows, and equal to the rest; so its "absent" is not an empty list's.
    const SORT = { column: 'key', direction: 'asc' } as const;
    const list = await workItemsService.getProjectIssuesList(fx.projectId, { sort: SORT }, fx.ctx);
    expect(list.total).toBe(trueSet.length - triageIds.length);
    expect(list.items.map((i) => i.id).sort()).toEqual(planned.map((p) => p.id).sort());
    const roots = await workItemsService.listRootIssues(fx.projectId, { sort: SORT }, fx.ctx);
    // The root level also lists the project's FOLDERS; the claim is about cards.
    const rootCards = roots.rows.filter((r) => r.kind !== 'folder').map((r) => r.id);
    expect(rootCards.sort()).toEqual(planned.map((p) => p.id).sort());

    // …while each triage bug resolves as a conversation target by its key.
    for (const bug of [widgetBug, orbBug]) {
      const byKey = await workItemsService.getWorkItemByIdentifier(
        fx.projectId,
        bug.identifier,
        fx.ctx,
      );
      expect(byKey.id).toBe(bug.id);
    }
    // …and the ask door takes the orb-filed one as an anchor.
    const anchored = await ask(
      post('/api/ai/ask', { body: 'Still broken', anchorKey: orbBug.identifier }),
    );
    expect(anchored.status).toBe(200);
    expect(wire.at(-1)).toMatchObject({
      jobKind: 'ask_project',
      context: { prompt: 'Still broken', anchorKey: orbBug.identifier },
    });
  });
});
