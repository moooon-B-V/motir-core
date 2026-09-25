import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalGateKind, ApprovalGateState, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import { PlanningSeedNotFoundError } from '@/lib/planChange/errors';
import { TWO_FACTOR_REQUIRED_PATH } from '@/lib/auth/twoFactorGate';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestWorkItem } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-6208 — `GET /api/approval-gates/[id]/planning-seed`, the REFUSAL SEED
// read (story MOTIR-6068; `approval-gates.md` §10f), against REAL Postgres and
// the real services. The only stubs are the context resolvers a Vitest process
// cannot supply through cookies (the active project, the session, the request
// locale) and the motir-ai boundary client a seeded session's first turn would
// otherwise reach.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
const requestLocale = { current: 'en' as string };

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: async () => session.current };
});
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});
vi.mock('next-intl/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl/server')>();
  return {
    ...actual,
    getLocale: async () => {
      // No request scope at all (a background caller) — the route falls back to en.
      if (requestLocale.current === 'throw') throw new Error('no request scope');
      return requestLocale.current;
    },
  };
});
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
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

const { GET: seedRoute } = await import('@/app/api/approval-gates/[id]/planning-seed/route');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planningSeedService } = await import('@/lib/services/planningSeedService');

const MINUTE = 60 * 1000;
const REASON = 'Not this direction.\nTry the other one — it is cheaper.\n\n  Keep the indent.';
const NOT_FOUND = { code: 'NOT_FOUND' };

let fx: WorkItemFixture;
let card: WorkItem;
let seq = 0;

type Actor = { id: string; email: string };

function pctxFor(actor: Actor, on: WorkItemFixture = fx, accessLevel?: 'private'): ProjectContext {
  return {
    userId: actor.id,
    workspaceId: on.workspaceId,
    projectId: on.projectId,
    project: { ...on.project, ...(accessLevel ? { accessLevel } : {}) },
  } as ProjectContext;
}

function signIn(actor: Actor, on: WorkItemFixture = fx, accessLevel?: 'private') {
  session.current = { user: { id: actor.id, email: actor.email, name: 'Ada Lovelace' } };
  activeCtx.current = pctxFor(actor, on, accessLevel);
}

const owner = (f: WorkItemFixture = fx): Actor => ({ id: f.owner.id, email: f.owner.email });

function readSeed(gateId: string): Promise<Response> {
  return seedRoute(
    new Request(
      `http://localhost:3000/api/approval-gates/${encodeURIComponent(gateId)}/planning-seed`,
    ),
    { params: Promise.resolve({ id: gateId }) },
  );
}

/** A gate row written in its FINAL state (the decided-immutable trigger fires on
 *  UPDATE, so a decided fixture is one INSERT). */
async function gate(
  item: { id: string; workspaceId: string; projectId: string },
  kind: ApprovalGateKind,
  state: ApprovalGateState,
  noteMd: string | null = REASON,
): Promise<string> {
  seq += 1;
  const decided = state !== 'awaiting' && state !== 'superseded';
  const row = await adminDb.approvalGate.create({
    data: {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      workItemId: item.id,
      kind,
      subjectId: `subject-${seq}`,
      state,
      ...(decided
        ? { decidedById: fx.ownerId, decidedAt: new Date(), decidedByLabel: 'Owner', noteMd }
        : {}),
    },
  });
  return row.id;
}

async function plainMember(): Promise<Actor> {
  const user = await createTestUser();
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, role: 'member' },
  });
  return { id: user.id, email: user.email };
}

async function counts() {
  return {
    sessions: await adminDb.planChangeSession.count(),
    turns: await adminDb.planChangeTurn.count(),
    jobs: await adminDb.jobRun.count(),
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  card = await createTestWorkItem(fx, { kind: 'story', title: 'Pick the export store' });
  session.current = null;
  activeCtx.current = null;
  requestLocale.current = 'en';
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('GET /api/approval-gates/[id]/planning-seed · 200', () => {
  it.each([
    ['decision_approval', 'changes_requested', 'Changes were requested on this decision.'],
    ['decision_choice', 'changes_requested', 'None of the options on this choice was picked.'],
    ['decision_confirmation', 'overturned', 'This decision was overturned.'],
  ] as const)(
    '%s in %s: the anchor, the kind and a first turn quoting the reason verbatim',
    async (kind, state, verb) => {
      const gateId = await gate(card, kind, state);
      signIn(owner());

      const res = await readSeed(gateId);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const body = await res.json();
      expect(Object.keys(body)).toEqual(['seed']);
      expect(body.seed).toEqual({
        gateId,
        gateKind: kind,
        anchorKey: card.identifier,
        firstTurn: expect.any(String),
        seededSessionId: null,
      });
      const turn: string = body.seed.firstTurn;
      expect(turn.startsWith(`${card.identifier} · ${card.title}`)).toBe(true);
      expect(turn).toContain(verb);
      expect(turn).toContain(REASON); // verbatim, line breaks included
      expect(turn).toContain('Re-plan this work item from that reason.');
    },
  );

  it('an overturn names each `## Supersedes` key of the decision, in the zh locale too', async () => {
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { descriptionMd: '## Supersedes\n- PROD-41 — the old table\n- PROD-42' },
    });
    const gateId = await gate(card, 'decision_confirmation', 'overturned');
    signIn(owner());

    const enTurn = (await (await readSeed(gateId)).json()).seed.firstTurn as string;
    expect(enTurn).toContain('The work items it superseded: PROD-41, PROD-42');

    requestLocale.current = 'zh';
    const zhTurn = (await (await readSeed(gateId)).json()).seed.firstTurn as string;
    expect(zhTurn).toContain('这个决策已被推翻。');
    expect(zhTurn).toContain('它曾取代的工作项：PROD-41、PROD-42');
    expect(zhTurn).toContain(`给出的理由：\n“${REASON}”`);
    expect(zhTurn).toContain('请根据这个理由重新规划这个工作项。');
  });

  it('an overturn with NO supersedes keys names none and carries no empty line', async () => {
    const gateId = await gate(card, 'decision_confirmation', 'overturned');
    signIn(owner());
    const turn = (await (await readSeed(gateId)).json()).seed.firstTurn as string;
    expect(turn).not.toContain('superseded');
    expect(turn).toBe(
      [
        `${card.identifier} · ${card.title}`,
        'This decision was overturned.',
        `The reason given:\n“${REASON}”`,
        'Re-plan this work item from that reason.',
      ].join('\n\n'),
    );
  });

  it('an unsupported or unresolvable request locale falls back to en', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    signIn(owner());
    for (const unusable of ['fr', 'throw']) {
      requestLocale.current = unusable;
      const turn = (await (await readSeed(gateId)).json()).seed.firstTurn as string;
      expect(turn).toContain('Changes were requested on this decision.');
    }
  });

  it('READING WRITES NOTHING: no session, no turn, no job', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    signIn(owner());
    const before = await counts();
    expect((await readSeed(gateId)).status).toBe(200);
    expect((await readSeed(gateId)).status).toBe(200);
    expect(await counts()).toEqual(before);
  });
});

describe('seededSessionId — the viewer’s own recent seeded session', () => {
  it('is the viewer’s session seeded by this gate, then null once past the window', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    const me = pctxFor(owner());
    const s = await planChangeSessionsService.startSeededWithFirstTurn(
      me,
      buildScope([card.identifier]),
      'Re-plan it',
      gateId,
    );
    signIn(owner());
    expect((await (await readSeed(gateId)).json()).seed.seededSessionId).toBe(s.id);

    await adminDb.planChangeSession.update({
      where: { id: s.id },
      data: { lastActivityAt: new Date(Date.now() - 121 * MINUTE) },
    });
    expect((await (await readSeed(gateId)).json()).seed.seededSessionId).toBeNull();
  });

  it('is null when the seeded session belongs to ANOTHER member', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    await planChangeSessionsService.startSeededWithFirstTurn(
      pctxFor(owner()),
      buildScope([card.identifier]),
      'mine',
      gateId,
    );
    const other = await plainMember();
    signIn(other);
    const res = await readSeed(gateId);
    expect(res.status).toBe(200);
    expect((await res.json()).seed.seededSessionId).toBeNull();
  });
});

describe('GET /api/approval-gates/[id]/planning-seed · the identical 404', () => {
  async function expectNotFound(gateId: string) {
    const res = await readSeed(gateId);
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(NOT_FOUND);
    expect(text).not.toContain('direction');
    return text;
  }

  it('an unknown id', async () => {
    signIn(owner());
    await expectNotFound('no-such-gate');
    await expectNotFound('   ');
  });

  it('a gate on a work item the viewer cannot BROWSE — the same body a readable gate’s owner never sees', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    // Readable for the owner…
    signIn(owner());
    expect((await readSeed(gateId)).status).toBe(200);
    // …and the same 404 as an unknown id for a workspace member outside the
    // private project.
    const outsider = await plainMember();
    await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'private' } });
    signIn(outsider, fx, 'private');
    const hidden = await expectNotFound(gateId);
    const absent = await expectNotFound('no-such-gate');
    expect(hidden).toBe(absent);
  });

  it('a gate in ANOTHER WORKSPACE (the scoped read narrows silently)', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    signIn(owner(rival), rival);
    await expectNotFound(gateId);
  });

  async function otherProject(): Promise<WorkItemFixture> {
    const project = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'ELSE',
    });
    return { ...fx, project, projectId: project.id, projectIdentifier: project.identifier };
  }

  it('a gate in ANOTHER PROJECT of the same workspace (not the active one)', async () => {
    const elsewhere = await otherProject();
    const theirs = await createTestWorkItem(elsewhere, { kind: 'story', title: 'Elsewhere' });
    const gateId = await gate(theirs, 'decision_approval', 'changes_requested');
    // Readable from its own project…
    signIn(owner(), elsewhere);
    expect((await readSeed(gateId)).status).toBe(200);
    // …and the same 404 with this project active.
    signIn(owner());
    await expectNotFound(gateId);
  });

  it('a gate whose card has since MOVED to another project', async () => {
    const elsewhere = await otherProject();
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { projectId: elsewhere.projectId },
    });
    signIn(owner());
    await expectNotFound(gateId);
  });

  it.each([
    ['decision_approval', 'awaiting'],
    ['decision_approval', 'approved'],
    ['decision_approval', 'superseded'],
    ['decision_choice', 'approved'],
    ['decision_confirmation', 'approved'],
    ['decision_confirmation', 'awaiting'],
  ] as const)('a %s gate in %s (not a refusal)', async (kind, state) => {
    const gateId = await gate(card, kind, state);
    signIn(owner());
    await expectNotFound(gateId);
  });

  it('a refused gate of a kind with NO composer (design_result changes_requested)', async () => {
    const gateId = await gate(card, 'design_result', 'changes_requested');
    signIn(owner());
    await expectNotFound(gateId);
  });

  it('the service answers every one of them with the one PlanningSeedNotFoundError', async () => {
    const awaiting = await gate(card, 'decision_approval', 'awaiting');
    for (const id of ['', 'no-such-gate', awaiting]) {
      await expect(
        planningSeedService.getRefusalSeed(id, pctxFor(owner()), 'en'),
      ).rejects.toBeInstanceOf(PlanningSeedNotFoundError);
    }
  });
});

describe('the defensive arms — a refusal the registry cannot compose, and the browse gate’s faults (MOTIR-6212)', () => {
  it('a kind the predicate accepts but whose composer is unset answers the same 404', async () => {
    // The next stories widen `isRefusalSeedGate` and the registry case by case; a kind
    // whose registry slot is present but empty must read exactly as an absent gate.
    const { REFUSAL_SEED_COMPOSERS, refusalSeedComposerFor } =
      await import('@/lib/planning/refusalSeed');
    const kept = REFUSAL_SEED_COMPOSERS.decision_approval;
    REFUSAL_SEED_COMPOSERS.decision_approval = undefined;
    try {
      expect(refusalSeedComposerFor('decision_approval')).toBeNull();
      const gateId = await gate(card, 'decision_approval', 'changes_requested');
      signIn(owner());
      const res = await readSeed(gateId);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual(NOT_FOUND);
      expect(text).not.toContain('direction');
    } finally {
      REFUSAL_SEED_COMPOSERS.decision_approval = kept;
    }
  });

  it('a project the browse gate cannot resolve is the same 404; any other fault is not swallowed', async () => {
    const { workItemsService } = await import('@/lib/services/workItemsService');
    const { ProjectNotFoundError } = await import('@/lib/projects/errors');
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    signIn(owner());

    const spy = vi.spyOn(workItemsService, 'getWorkItem');
    try {
      spy.mockRejectedValueOnce(new ProjectNotFoundError(fx.projectId));
      const hidden = await readSeed(gateId);
      expect(hidden.status).toBe(404);
      expect(JSON.parse(await hidden.text())).toEqual(NOT_FOUND);

      // A real fault is a real fault — never dressed up as "nothing here".
      spy.mockRejectedValueOnce(new Error('connection reset'));
      await expect(readSeed(gateId)).rejects.toThrow('connection reset');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('GET /api/approval-gates/[id]/planning-seed · auth', () => {
  it('no active project → 401', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    const res = await readSeed(gateId);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('a member held by the 2FA policy is refused 403 before anything is read', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    signIn(owner());
    await adminDb.workspace.update({
      where: { id: fx.workspaceId },
      data: { requiresTwoFactor: true },
    });
    const res = await readSeed(gateId);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
      enrolAt: TWO_FACTOR_REQUIRED_PATH,
    });
    expect(text).not.toContain('direction');
  });
});

describe('the catalogues and the route’s shape', () => {
  it('both catalogues hold every refusalSeed key the composers use', () => {
    const keysOf = (o: Record<string, unknown>, p = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        v && typeof v === 'object'
          ? keysOf(v as Record<string, unknown>, `${p}${k}.`)
          : [`${p}${k}`],
      );
    const enKeys = keysOf(en.planningWorkspace.refusalSeed).sort();
    expect(keysOf(zh.planningWorkspace.refusalSeed).sort()).toEqual(enKeys);
    expect(enKeys).toEqual(
      [
        'ask',
        'heading',
        'keySeparator',
        'reason',
        'supersedes',
        'verb.decisionApproval',
        'verb.decisionChoice',
        'verb.decisionConfirmation',
      ].sort(),
    );
  });

  it('the handler is a thin HTTP layer (no db, no repository, no transaction)', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/approval-gates/[id]/planning-seed/route.ts'),
      'utf8',
    );
    const code = source.replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/from '@\/lib\/db'/);
    expect(code).not.toMatch(/lib\/repositories/);
    expect(code).not.toMatch(/\$transaction/);
  });
});
