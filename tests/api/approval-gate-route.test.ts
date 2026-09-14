import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { UNREGISTERED_GATE_KINDS } from '@/lib/approvalGates/registry';
import { TWO_FACTOR_REQUIRED_PATH } from '@/lib/auth/twoFactorGate';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-5223 — `GET /api/work-items/approval-gate?key=&kind=`, the read the
// approval OVERLAY (MOTIR-5214) makes from the browser.
//
// Against REAL Postgres and the real services, in the shape
// `tests/api/planning-anchor-route.test.ts` uses: the only stubs are the two
// context resolvers a Vitest process cannot supply through cookies, plus the ONE
// external the design-publish path touches — `@/lib/blob/uploader`, the same
// narrow mock `tests/approval-gate-decided-read.test.ts` records — so a
// `design_result` gate here is raised by a REAL publish, not hand-written.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: async () => session.current };
});
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});

const store = new Map<string, { contentType: string; size: number }>();
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { GET: gateRoute } = await import('@/app/api/work-items/approval-gate/route');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { workItemsService } = await import('@/lib/services/workItemsService');

let fx: WorkItemFixture;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  session.current = null;
  activeCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Actor = { id: string; email: string };

/** Sign `actor` in with `on`'s project active — the fixture's own by default. */
function signIn(actor: Actor, on: WorkItemFixture = fx, accessLevel?: 'private') {
  session.current = { user: { id: actor.id, email: actor.email, name: 'Ada Lovelace' } };
  activeCtx.current = {
    userId: actor.id,
    workspaceId: on.workspaceId,
    projectId: on.projectId,
    project: { ...on.project, ...(accessLevel ? { accessLevel } : {}) },
  } as ProjectContext;
}

function gateViaRoute(params: { key?: string; kind?: string }): Promise<Response> {
  const qs = new URLSearchParams();
  if (params.key !== undefined) qs.set('key', params.key);
  if (params.kind !== undefined) qs.set('kind', params.kind);
  return gateRoute(new Request(`http://localhost:3000/api/work-items/approval-gate?${qs}`));
}

/** A design subtask sitting where a published design waits: In Review. */
async function designCard(): Promise<WorkItem> {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Decide it full screen' },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the overlay' },
    fx.ctx,
  );
  await workItemsService.updateStatus(subtask.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(subtask.id, 'in_review', fx.ctx);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: subtask.id } });
}

/** A REAL publish — it raises the card's `awaiting` design gate itself. */
async function publish(card: WorkItem) {
  const pathname = `${designPrefix(fx.workspaceId, card.id)}overlay.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: card.id,
      assets: [{ kind: 'mock', sourcePath: 'design/workbench/overlay.mock.html', pathname }],
      commitSha: 'sha-overlay',
    },
    fx.ctx,
  );
}

/** A gate row written directly, for the shapes no shipped path creates yet. */
async function rawGate(card: WorkItem, kind: string, subjectId: string) {
  return withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind: kind as 'design_result',
        subjectId,
      },
      tx,
    ),
  );
}

/** A workspace member with no administrative role and no relationship to the card. */
async function plainMember(): Promise<Actor> {
  const user = await createTestUser();
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, role: 'member' },
  });
  return { id: user.id, email: user.email };
}

const owner = (): Actor => ({ id: fx.owner.id, email: fx.owner.email });

describe('GET /api/work-items/approval-gate · the four subject answers', () => {
  it('a published design: the gate, canDecide, the waiting-on name and the RESOLVED subject', async () => {
    const card = await designCard();
    const evidence = await publish(card);
    signIn(owner());

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.workItem).toEqual({ id: card.id, identifier: card.identifier, title: card.title });
    expect(body.gate).toMatchObject({
      workItemId: card.id,
      kind: 'design_result',
      state: 'awaiting',
      subjectId: evidence.id,
    });
    // The fixture owner REPORTED the card and nobody is assigned — §2's
    // reporter arm, so this reader may press the verbs.
    expect(body.canDecide).toBe(true);
    expect(typeof body.routedToLabel).toBe('string');
    expect(body.subject.state).toBe('resolved');
    expect(body.subject.kind).toBe('design_result');
    expect(body.subject.evidence.id).toBe(evidence.id);
    // Only an approval pins; an awaiting version keeps nothing yet.
    expect(body.subject.filesKept).toBe(false);
  });

  it('a card with NO gate of that kind is a 200 saying so — not a 404', async () => {
    const card = await designCard();
    signIn(owner());

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gate).toBeNull();
    expect(body.canDecide).toBe(false);
    expect(body.subject).toEqual({ state: 'no_gate' });
  });

  it('a gate whose subject no longer resolves is GONE — distinct from no gate', async () => {
    const card = await designCard();
    const gate = await rawGate(card, 'design_result', 'design-evidence-that-was-reclaimed');
    signIn(owner());

    const body = await (await gateViaRoute({ key: card.identifier, kind: 'design_result' })).json();
    expect(body.gate.id).toBe(gate.id);
    expect(body.subject).toEqual({ state: 'gone' });
  });

  it('a subject belonging to a DIFFERENT card is gone too — the cross-card guard holds', async () => {
    const other = await designCard();
    const foreign = await publish(other);
    const card = await designCard();
    await rawGate(card, 'design_result', foreign.id);
    signIn(owner());

    const body = await (await gateViaRoute({ key: card.identifier, kind: 'design_result' })).json();
    expect(body.subject).toEqual({ state: 'gone' });
  });

  it.each(UNREGISTERED_GATE_KINDS)(
    'an UNREGISTERED kind (%s) returns the gate and the not-built-yet answer — never a throw',
    async (kind) => {
      const card = await designCard();
      const gate = await rawGate(card, kind, `subject-${kind}`);
      signIn(owner());

      const res = await gateViaRoute({ key: card.identifier, kind });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.gate).toMatchObject({ id: gate.id, kind });
      expect(body.subject).toEqual({ state: 'kind_not_built' });
      // No handler to route by, so §2's shared rule names the reporter.
      expect(typeof body.routedToLabel).toBe('string');
    },
  );

  it('never serves a cached gate — its state changes under the reader by design', async () => {
    const card = await designCard();
    signIn(owner());
    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('GET /api/work-items/approval-gate · seeing is not deciding', () => {
  it('a reader who may BROWSE but not DECIDE gets the gate and the subject with canDecide false', async () => {
    const card = await designCard();
    await publish(card);
    const bystander = await plainMember();
    signIn(bystander);

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gate.state).toBe('awaiting');
    expect(body.subject.state).toBe('resolved');
    expect(body.canDecide).toBe(false);
  });
});

describe('GET /api/work-items/approval-gate · the permission floor (MOTIR-5445)', () => {
  it('a project VIEWER who is the ASSIGNEE sees the resolved gate with canDecide false', async () => {
    // Routed the gate, and held out of deciding it by the kind's
    // `work_item:edit` floor — which the door asserts, and which this read
    // skipped until MOTIR-5445, so the overlay drew verbs the door refused.
    const card = await designCard();
    await publish(card);
    const viewer = await plainMember();
    await adminDb.projectMembership.deleteMany({
      where: { userId: viewer.id, projectId: fx.projectId },
    });
    await adminDb.projectMembership.create({
      data: {
        userId: viewer.id,
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        role: 'viewer',
      },
    });
    await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: viewer.id } });
    signIn(viewer);

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gate.state).toBe('awaiting');
    expect(body.subject.state).toBe('resolved');
    expect(body.canDecide).toBe(false);
  });
});

describe('GET /api/work-items/approval-gate · the refusals', () => {
  it('no active project → 401, and the 2FA hold does NOT pre-empt it', async () => {
    await adminDb.workspace.update({
      where: { id: fx.workspaceId },
      data: { requiresTwoFactor: true },
    });
    session.current = { user: { id: fx.owner.id, email: fx.owner.email, name: 'Ada Lovelace' } };
    activeCtx.current = null;

    const res = await gateViaRoute({ key: 'PROD-1', kind: 'design_result' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('a member held by the 2FA policy is refused 403 with the typed body', async () => {
    const card = await designCard();
    signIn(owner());
    await adminDb.workspace.update({
      where: { id: fx.workspaceId },
      data: { requiresTwoFactor: true },
    });

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
      tier: 'workspace',
      enrolAt: TWO_FACTOR_REQUIRED_PATH,
    });
  });

  it('a missing or blank `key` → 400', async () => {
    signIn(owner());
    expect((await gateViaRoute({ kind: 'design_result' })).status).toBe(400);
    const blank = await gateViaRoute({ key: '   ', kind: 'design_result' });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ code: 'BAD_REQUEST', error: '`key` is required.' });
  });

  it('a missing, unknown or prototype-named `kind` → 400', async () => {
    const card = await designCard();
    signIn(owner());
    for (const kind of [undefined, '', 'merge', 'toString', 'constructor']) {
      const res = await gateViaRoute({ key: card.identifier, kind });
      expect(res.status, `kind=${String(kind)}`).toBe(400);
      expect((await res.json()).code).toBe('BAD_REQUEST');
    }
  });

  it('the scoping is real: a gate that RESOLVES for its reader is a 404 for an outsider, byte-identical to an unknown key', async () => {
    // The actor's view and the true population DIFFER here: the gate exists and
    // resolves for its own workspace, and must not for anybody else's. A test
    // whose actor could see everything could not tell a scoped read from an
    // unscoped one.
    const card = await designCard();
    await publish(card);
    signIn(owner());
    expect((await gateViaRoute({ key: card.identifier, kind: 'design_result' })).status).toBe(200);

    const home = fx;
    const outsiderFx = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    signIn({ id: outsiderFx.owner.id, email: outsiderFx.owner.email }, outsiderFx);

    const forbidden = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    const unknown = await gateViaRoute({ key: 'ELSE-99999', kind: 'design_result' });
    expect(forbidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    const [a, b] = [await forbidden.text(), await unknown.text()];
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ code: 'NOT_FOUND', error: 'Work item not available.' });

    // …and the gate is still there for its own reader afterwards.
    signIn(owner(), home);
    expect((await gateViaRoute({ key: card.identifier, kind: 'design_result' })).status).toBe(200);
  });

  it('a key in a project this reader may NOT BROWSE is the same 404', async () => {
    const card = await designCard();
    await publish(card);
    const outsider = await plainMember();
    await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'private' } });
    signIn(outsider, fx, 'private');

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND', error: 'Work item not available.' });
  });
});

describe('guard · the handler stays a THIN HTTP layer', () => {
  const source = readFileSync(
    join(process.cwd(), 'app/api/work-items/approval-gate/route.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('imports no `db`, no repository, and opens no transaction (the 4-layer rule)', () => {
    expect(code).not.toMatch(/from '@\/lib\/db'/);
    expect(code).not.toMatch(/lib\/repositories/);
    expect(code).not.toMatch(/\$transaction/);
    expect(code).not.toMatch(/prisma/i);
  });

  it('composes exactly the three shipped service reads and adds none', () => {
    const calls = [...new Set(code.match(/\w+Service\.\w+/g) ?? [])].sort();
    expect(calls).toEqual([
      'approvalGatesService.getForWorkItem',
      'designEvidenceService.getForGateSubject',
      'workItemsService.getWorkItemByIdentifier',
    ]);
  });

  it('holds the 2FA gate AFTER the no-project arm and BEFORE the parameter arms', () => {
    const gate = code.indexOf('refuseIfNonCompliant(');
    expect(gate).toBeGreaterThan(-1);
    expect(code.indexOf('getActiveProject(')).toBeLessThan(gate);
    expect(code.indexOf('UNAUTHENTICATED')).toBeLessThan(gate);
    expect(gate).toBeLessThan(code.indexOf('BAD_REQUEST'));
  });
});
