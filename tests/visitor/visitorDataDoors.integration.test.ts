import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateRateLimitCounters } from '@/tests/helpers/db';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { consentedVisitor } from './_consentedVisitor';

// The client DATA DOORS a Visitor view calls (Story MOTIR-6170 · MOTIR-6647),
// driven as the browser drives them: a `motir_visitor` cookie naming the public
// project, the reader's session, and the real resolver and datastore behind them.
// A signed-in, consented stranger is served that project's data, with every
// private-epic descendant withheld; everyone else — no session, no consent, a
// member — is answered exactly as the route answers today.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
const wsCtx = { current: null as WorkspaceContext | null };
const incoming = { current: new Headers() };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => wsCtx.current,
}));
vi.mock('next/headers', () => ({
  headers: async () => incoming.current,
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  getLocale: async () => 'en',
}));

const { GET: boardGET } = await import('@/app/api/board/route');
const { GET: boardsGET } = await import('@/app/api/boards/route');
const { GET: peekGET } = await import('@/app/api/work-items/peek/route');
const { GET: commentsGET } = await import('@/app/api/work-items/[id]/comments/route');
const { GET: allGET } = await import('@/app/api/work-items/[id]/activity/all/route');
const { GET: historyGET } = await import('@/app/api/work-items/[id]/activity/history/route');
const { GET: rollupGET } = await import('@/app/api/work-items/[id]/rollup/route');
const { GET: roadmapGET } = await import('@/app/api/projects/[key]/roadmap/route');
const { GET: runGET } = await import('@/app/api/dispatch-runs/[id]/route');
const { listRootIssuesAction, listChildIssuesAction } =
  await import('@/app/(authed)/items/actions');

const BASE = 'http://localhost:3000';

let previousCloud: string | undefined;
beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  previousCloud = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'];
  session.current = null;
  activeCtx.current = null;
  wsCtx.current = null;
  incoming.current = new Headers();
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'];
  __resetSharedRateLimitStoreForTest();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

/** A public project with a private epic (child C, grandchild G) and a visible item V. */
async function publicProject() {
  const identifier = `VD${seq++}`;
  const fx = await makeWorkItemFixture({ name: `VD ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { accessMode: 'public', accessLevel: 'public' },
  });
  const E = await createTestWorkItem(fx, { kind: 'epic', title: 'Private epic E' });
  const C = await createTestWorkItem(fx, { kind: 'story', title: 'Hidden C', parentId: E.id });
  const G = await createTestWorkItem(fx, { kind: 'subtask', title: 'Hidden G', parentId: C.id });
  const V = await createTestWorkItem(fx, { kind: 'story', title: 'Visible V' });
  for (const w of [E, C, G, V]) {
    await adminDb.workItem.update({ where: { id: w.id }, data: { status: 'todo' } });
  }
  await adminDb.workItem.update({ where: { id: E.id }, data: { publicChildrenHidden: true } });
  return { fx, identifier, E, C, G, V, hidden: [C, G] };
}

type Fixture = Awaited<ReturnType<typeof publicProject>>;

/** Sign the reader in as a consented stranger of `t`, cookie set, no workspace. */
async function asVisitor(t: Fixture) {
  const ctx = await consentedVisitor(t.identifier);
  session.current = { user: { id: ctx.actorUserId, email: 'stranger@example.com', name: 'S' } };
  incoming.current = new Headers({ cookie: `motir_visitor=${t.identifier}` });
  return ctx.actorUserId;
}

/** Sign the reader in as the project's own owner, with its active project and workspace. */
function asMember(t: Fixture) {
  session.current = { user: { id: t.fx.ownerId, email: 'owner@example.com', name: 'O' } };
  activeCtx.current = {
    userId: t.fx.ownerId,
    workspaceId: t.fx.workspaceId,
    projectId: t.fx.projectId,
    project: t.fx.project as unknown as ProjectContext['project'],
  };
  wsCtx.current = { userId: t.fx.ownerId, workspaceId: t.fx.workspaceId };
}

const req = (path: string, cookie?: string) =>
  new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const text = async (res: Response) => JSON.stringify(await res.clone().json());

describe('a consented Visitor is served the public project, withheld rows excluded', () => {
  it('the board, boards, peek, comments, activity, rollup, roadmap and tree answer 200', async () => {
    const t = await publicProject();
    await asVisitor(t);
    const cookie = `motir_visitor=${t.identifier}`;

    const board = await boardGET(req('/api/board', cookie));
    expect(board.status).toBe(200);
    const boardBody = await text(board);
    expect(boardBody).toContain(t.V.id);
    for (const h of t.hidden) expect(boardBody).not.toContain(h.id);

    expect((await boardsGET(req('/api/boards', cookie))).status).toBe(200);

    const peek = await peekGET(req(`/api/work-items/peek?key=${t.V.identifier}`, cookie));
    expect(peek.status).toBe(200);
    expect(await text(peek)).not.toContain('@');

    for (const get of [commentsGET, allGET, historyGET]) {
      const res = await get(req(`/api/work-items/${t.V.id}/x`, cookie), params({ id: t.V.id }));
      expect(res.status).toBe(200);
    }
    const rollup = await rollupGET(
      req(`/api/work-items/${t.E.id}/rollup`, cookie),
      params({ id: t.E.id }),
    );
    expect(rollup.status).toBe(200);

    const roadmap = await roadmapGET(
      req(`/api/projects/${t.identifier}/roadmap`, cookie),
      params({ key: t.identifier }),
    );
    expect(roadmap.status).toBe(200);
    const roadmapBody = await text(roadmap);
    for (const h of t.hidden) expect(roadmapBody).not.toContain(h.id);

    const root = await listRootIssuesAction({ sortParam: '' });
    expect(root.ok).toBe(true);
    if (root.ok) {
      expect(root.level.rows.map((r) => r.id)).toEqual(expect.arrayContaining([t.E.id, t.V.id]));
      for (const h of t.hidden) expect(root.level.rows.map((r) => r.id)).not.toContain(h.id);
    }
    const drill = await listChildIssuesAction({ sortParam: '', parentId: t.E.id });
    expect(drill.ok && drill.level.rows).toEqual([]);
  });

  it('a hidden item answers exactly as an unknown one does', async () => {
    const t = await publicProject();
    await asVisitor(t);
    const cookie = `motir_visitor=${t.identifier}`;
    const hidden = await commentsGET(req('/x', cookie), params({ id: t.C.id }));
    const unknown = await commentsGET(req('/x', cookie), params({ id: 'cm-not-an-item' }));
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    const hiddenPeek = await peekGET(req(`/api/work-items/peek?key=${t.C.identifier}`, cookie));
    const unknownPeek = await peekGET(req(`/api/work-items/peek?key=${t.identifier}-9999`, cookie));
    expect(hiddenPeek.status).toBe(404);
    expect(await hiddenPeek.json()).toEqual(await unknownPeek.json());
    const drill = await listChildIssuesAction({ sortParam: '', parentId: t.C.id });
    expect(drill).toEqual({ ok: false, error: 'That issue no longer exists.' });
  });

  it('a cookie naming project A never serves a resource of project B', async () => {
    const a = await publicProject();
    const b = await publicProject();
    await asVisitor(a);
    const res = await commentsGET(
      req('/x', `motir_visitor=${a.identifier}`),
      params({ id: b.V.id }),
    );
    expect(res.status).toBe(404);
    const roadmap = await roadmapGET(
      req('/x', `motir_visitor=${a.identifier}`),
      params({ key: b.identifier }),
    );
    expect(roadmap.status).toBe(404);
  });

  it('a run touching a withheld item is not found; one on a visible item is served', async () => {
    const t = await publicProject();
    await asVisitor(t);
    const cookie = `motir_visitor=${t.identifier}`;
    const run = (scopeWorkItemId: string) =>
      adminDb.dispatchRun.create({
        data: {
          workspaceId: t.fx.workspaceId,
          projectId: t.fx.projectId,
          command: 'run_scope',
          status: 'running',
          scopeWorkItemId,
          cards: {
            create: { workspaceId: t.fx.workspaceId, workItemId: scopeWorkItemId, position: 0 },
          },
        },
      });
    const visible = await run(t.V.id);
    const hidden = await run(t.C.id);
    expect((await runGET(req('/x', cookie), params({ id: visible.id }))).status).toBe(200);
    expect((await runGET(req('/x', cookie), params({ id: hidden.id }))).status).toBe(404);
  });
});

describe('everyone else is answered exactly as today', () => {
  it('no session answers 401, cookie or not', async () => {
    const t = await publicProject();
    const cookie = `motir_visitor=${t.identifier}`;
    expect((await boardGET(req('/api/board', cookie))).status).toBe(401);
    const withCookie = await commentsGET(req('/x', cookie), params({ id: t.V.id }));
    const without = await commentsGET(req('/x'), params({ id: t.V.id }));
    expect(withCookie.status).toBe(401);
    expect(await withCookie.json()).toEqual(await without.json());
  });

  it('a signed-in stranger WITHOUT a consent gets the answer they get with no cookie', async () => {
    const t = await publicProject();
    const stranger = await adminDb.user.create({
      data: { email: `nc-${seq++}@example.com`, name: 'No consent', emailVerified: true },
    });
    session.current = { user: { id: stranger.id, email: stranger.email, name: 'N' } };
    const cookie = `motir_visitor=${t.identifier}`;
    const withCookie = await boardGET(req('/api/board', cookie));
    const without = await boardGET(req('/api/board'));
    expect(withCookie.status).toBe(without.status);
    expect(await withCookie.json()).toEqual(await without.json());
    const cWith = await commentsGET(req('/x', cookie), params({ id: t.V.id }));
    const cWithout = await commentsGET(req('/x'), params({ id: t.V.id }));
    expect(cWith.status).toBe(cWithout.status);
  });

  it('a cookie naming a non-public or unknown project changes nothing', async () => {
    const t = await publicProject();
    await asVisitor(t);
    await adminDb.project.update({
      where: { id: t.fx.projectId },
      data: { accessMode: 'members', accessLevel: 'private' },
    });
    const gone = await commentsGET(
      req('/x', `motir_visitor=${t.identifier}`),
      params({ id: t.V.id }),
    );
    const unknown = await commentsGET(req('/x', 'motir_visitor=NOPE404'), params({ id: t.V.id }));
    const none = await commentsGET(req('/x'), params({ id: t.V.id }));
    expect(gone.status).toBe(none.status);
    expect(unknown.status).toBe(none.status);
  });

  it('a member of the project, cookie or not, is served exactly as today', async () => {
    const t = await publicProject();
    asMember(t);
    const cookie = `motir_visitor=${t.identifier}`;
    const withCookie = await boardGET(req('/api/board', cookie));
    const without = await boardGET(req('/api/board'));
    expect(withCookie.status).toBe(200);
    expect(await text(withCookie)).toEqual(await text(without));
    const cWith = await commentsGET(req('/x', cookie), params({ id: t.C.id }));
    expect(cWith.status).toBe(200);
  });
});

describe('the per-person read budget', () => {
  it('a Visitor past the budget answers 429; a member is never counted', async () => {
    process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'] = '2';
    const t = await publicProject();
    await asVisitor(t);
    const cookie = `motir_visitor=${t.identifier}`;
    expect((await boardGET(req('/api/board', cookie))).status).toBe(200);
    expect((await boardGET(req('/api/board', cookie))).status).toBe(200);
    const refused = await boardGET(req('/api/board', cookie));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBeTruthy();

    asMember(t);
    for (let i = 0; i < 3; i += 1) {
      expect((await boardGET(req('/api/board', cookie))).status).toBe(200);
    }
  });
});
