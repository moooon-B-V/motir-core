import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma, WorkspaceRole } from '@/generated/prisma/client';

// STORY MOTIR-5754's INTEGRATION GATE (MOTIR-7389) — a page's HISTORY, assembled,
// on real Postgres, through the real doors.
//
// Each card of the story tested its own layer with the next one faked: the
// package's coalescing and cap over an in-memory store, the adapter and the
// service on Postgres without the routes, the panel and restore with `fetch`
// stubbed. This file drives the SEAMS between them:
//
//   an editor-shaped Yjs update → `POST /api/pages/<id>/updates` →
//   `pagesService.savePageUpdate` → the package's `savePageUpdate` +
//   `recordVersion` → `pageStoreFor(tx)` → `page_version` → and back out through
//   `GET …/versions`, `GET …/versions/<n>` and `POST …/versions/<n>/restore`.
//
// Mocked, and only these: the session and the active project (`getSession`,
// `getActiveProject`), which need cookies — `tests/integration/pagesStoryGate.test.ts`'s
// pattern. The actor is read from an AsyncLocalStorage first, so two requests
// can run IN PARALLEL as two different people.
//
// ⚠️ THE COALESCING WINDOW IS WALL-CLOCK. The app's `systemClock` is the real
// clock and nothing here fakes it; a test that needs a save to fall OUTSIDE the
// 10-minute window moves the stored `saved_at` back instead
// (`ageVersions`), which is what time passing would have done to the row.

interface Actor {
  userId: string;
  workspaceId: string;
  projectId: string;
}

const actor = vi.hoisted(() => ({
  current: null as Actor | null,
  als: null as { getStore(): Actor | undefined } | null,
}));
const who = () => actor.als?.getStore() ?? actor.current;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => {
    const a = who();
    return a ? { user: { id: a.userId } } : null;
  }),
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () => who()),
}));

const requestAs = new AsyncLocalStorage<Actor>();
actor.als = requestAs;

const { POST: CREATE } = await import('@/app/api/pages/route');
const { GET: READ } = await import('@/app/api/pages/[pageId]/route');
const { POST: SAVE } = await import('@/app/api/pages/[pageId]/updates/route');
const { GET: LIST } = await import('@/app/api/pages/[pageId]/versions/route');
const { GET: VERSION } = await import('@/app/api/pages/[pageId]/versions/[number]/route');
const { POST: RESTORE } = await import('@/app/api/pages/[pageId]/versions/[number]/restore/route');
const { pagesService } = await import('@/lib/services/pagesService');
const { PAGE_FRAGMENT, PAGE_VERSION_CAP, stateToMarkdown } = await import('@/lib/pages');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { setProjectAccess } = await import('../helpers/projectAccess');

// ── The editor's update shape (as `pagesStoryGate.test.ts` builds it) ─────────

interface YText {
  insert(index: number, text: string): void;
}
interface YElement {
  insert(index: number, content: unknown[]): void;
}
interface YFragment {
  length: number;
  insert(index: number, content: unknown[]): void;
}
interface YDoc {
  on(event: 'update', handler: (update: Uint8Array) => void): void;
  transact(fn: () => void): void;
  getXmlFragment(name: string): YFragment;
}
interface Yjs {
  Doc: new () => YDoc;
  XmlElement: new (name: string) => YElement;
  XmlText: new () => YText;
  applyUpdate(doc: YDoc, update: Uint8Array): void;
  mergeUpdates(updates: Uint8Array[]): Uint8Array;
}
const Y = createRequire(join(process.cwd(), 'packages', 'pages', 'package.json'))('yjs') as Yjs;

/** The update the editor would send after the writer appends `text` as a paragraph. */
function editorUpdate(state: Uint8Array, text: string): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const batch: Uint8Array[] = [];
  doc.on('update', (update) => batch.push(update));
  doc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph');
    const run = new Y.XmlText();
    run.insert(0, text);
    paragraph.insert(0, [run]);
    const fragment = doc.getXmlFragment(PAGE_FRAGMENT);
    fragment.insert(fragment.length, [paragraph]);
  });
  return Y.mergeUpdates(batch);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "page" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  actor.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function makeUser(tag: string) {
  seq += 1;
  return usersService.createUser({
    email: `history-gate-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `History ${tag}`,
  });
}

interface Tenant {
  workspaceId: string;
  projectId: string;
  otherProjectId: string;
  manager: Actor;
}

async function makeTenant(tag: string): Promise<Tenant> {
  const owner = await makeUser(`${tag}-owner`);
  const ws = await workspacesService.createWorkspace({ name: tag, ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const key = tag.slice(0, 2).toUpperCase();
  const p = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: `${tag} P`,
    identifier: `${key}P`,
  });
  const q = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: `${tag} Q`,
    identifier: `${key}Q`,
  });
  return {
    workspaceId,
    projectId: p.id,
    otherProjectId: q.id,
    manager: { userId: owner.id, workspaceId, projectId: p.id },
  };
}

async function memberOf(t: Tenant, tag: string, role: WorkspaceRole): Promise<Actor> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: t.workspaceId, workspaceRole: role },
  });
  return { userId: user.id, workspaceId: t.workspaceId, projectId: t.projectId };
}

const svc = (a: Actor) => ({ userId: a.userId, workspaceId: a.workspaceId });
const decode = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));

/** Run one door as `a` — safe to run in parallel with another actor's door. */
const as = <T>(a: Actor, door: () => Promise<T>): Promise<T> => requestAs.run(a, door);

// ── The doors ────────────────────────────────────────────────────────────────

const BASE = 'http://localhost:3000/api/pages';
const pageParams = (pageId: string) => ({ params: Promise.resolve({ pageId }) });
const versionParams = (pageId: string, n: number) => ({
  params: Promise.resolve({ pageId, number: String(n) }),
});

async function create(title: string): Promise<string> {
  const res = await CREATE(
    new Request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const read = (pageId: string) => READ(new Request(`${BASE}/${pageId}`), pageParams(pageId));

function rawSave(pageId: string, update: Uint8Array): Promise<Response> {
  return SAVE(
    new Request(`${BASE}/${pageId}/updates`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(update) as BodyInit,
    }),
    pageParams(pageId),
  );
}

const list = (pageId: string, query = '') =>
  LIST(new Request(`${BASE}/${pageId}/versions${query}`), pageParams(pageId));
const version = (pageId: string, n: number) =>
  VERSION(new Request(`${BASE}/${pageId}/versions/${n}`), versionParams(pageId, n));
const restore = (pageId: string, n: number) =>
  RESTORE(
    new Request(`${BASE}/${pageId}/versions/${n}/restore`, { method: 'POST' }),
    versionParams(pageId, n),
  );

interface ListedVersion {
  number: number;
  authorId: string;
  authorName: string;
  restoredFromNumber: number | null;
  restoredFromKept: boolean;
  isCurrent: boolean;
}

async function listed(pageId: string): Promise<ListedVersion[]> {
  const res = await list(pageId, '?limit=100');
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: ListedVersion[] }).items;
}

/** The page's current state, read through the page door as the browser does. */
async function currentState(pageId: string): Promise<Uint8Array> {
  const res = await read(pageId);
  expect(res.status).toBe(200);
  return decode(((await res.json()) as { bodyState: string }).bodyState);
}

/** What a version write leaves behind: how many, and the newest one's last save. */
async function fingerprint(pageId: string) {
  const rows = await adminDb.pageVersion.findMany({
    where: { pageId },
    orderBy: { number: 'desc' },
    select: { number: true, savedAt: true },
  });
  return { count: rows.length, latest: rows[0]?.number, savedAt: rows[0]?.savedAt.getTime() };
}

/**
 * THE "NEITHER IS A DEFECT" GUARD. A save through the route must leave a mark on
 * `page_version`: either a NEW version (the count grows) or the coalesced one's
 * `saved_at` moved. A save that leaves both unchanged is a silently broken
 * version write, and every save in this file goes through here.
 */
async function save(pageId: string, text: string): Promise<void> {
  const before = await fingerprint(pageId);
  const res = await rawSave(pageId, editorUpdate(await currentState(pageId), text));
  expect(res.status).toBe(200);
  const after = await fingerprint(pageId);
  const versioned = after.count !== before.count || after.savedAt !== before.savedAt;
  expect(versioned, 'a save through the route left page_version unchanged').toBe(true);
}

/** Time passing: every version of the page now sits outside the coalescing window. */
async function ageVersions(pageId: string, minutes = 11): Promise<void> {
  await adminDb.$executeRaw`
    UPDATE "page_version"
       SET "saved_at" = "saved_at" - make_interval(mins => ${minutes}),
           "started_at" = "started_at" - make_interval(mins => ${minutes})
     WHERE "page_id" = ${pageId}`;
}

/** Fill the page's history up to `upTo` with direct rows by `authorId`, aged out of the window. */
async function seedVersions(
  t: Tenant,
  pageId: string,
  authorId: string,
  upTo: number,
): Promise<void> {
  const latest = (await fingerprint(pageId)).latest ?? 0;
  const { bodyState, bodyMarkdown } = await adminDb.page.findUniqueOrThrow({
    where: { id: pageId },
    select: { bodyState: true, bodyMarkdown: true },
  });
  const at = new Date(Date.now() - 60 * 60_000);
  const data: Prisma.PageVersionCreateManyInput[] = [];
  for (let n = latest + 1; n <= upTo; n++) {
    data.push({
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      pageId,
      authorId,
      number: n,
      bodyState,
      bodyMarkdown,
      startedAt: at,
      savedAt: at,
    });
  }
  await adminDb.pageVersion.createMany({ data });
}

// ── Seams ────────────────────────────────────────────────────────────────────

describe('seam: coalescing through the real door', () => {
  it('one member’s two saves fold into one version inside the window, and make two outside it', async () => {
    const t = await makeTenant('Fold');
    actor.current = t.manager;
    const id = await create('Runbook');
    const writer = await memberOf(t, 'writer', 'member');
    actor.current = writer;

    await save(id, 'First.');
    await save(id, 'Second.');
    // The manager's v1, and the writer's ONE version for both saves.
    expect((await listed(id)).map((v) => [v.number, v.authorId])).toEqual([
      [2, writer.userId],
      [1, t.manager.userId],
    ]);

    await ageVersions(id);
    await save(id, 'Third.');
    expect((await listed(id)).map((v) => v.number)).toEqual([3, 2, 1]);
  });

  it('two authors’ saves make two versions, each listed with its author', async () => {
    const t = await makeTenant('Pair');
    const a = await memberOf(t, 'a', 'member');
    const b = await memberOf(t, 'b', 'member');
    actor.current = a;
    const id = await create('Notes');
    await save(id, 'From A.');
    actor.current = b;
    await save(id, 'From B.');

    const rows = await listed(id);
    expect(rows.map((v) => [v.number, v.authorId, v.authorName, v.isCurrent])).toEqual([
      [2, b.userId, 'History b', true],
      [1, a.userId, 'History a', false],
    ]);
    // Each version reads back as the content it held.
    const v1 = (await (await version(id, 1)).json()) as { bodyState: string };
    expect(stateToMarkdown(decode(v1.bodyState))).toBe('From A.');
  });
});

describe('seam: the 100-version cap', () => {
  it('a 101st version deletes the oldest in the same save', async () => {
    const t = await makeTenant('Cap');
    actor.current = t.manager;
    const id = await create('Long-lived');
    await seedVersions(t, id, t.manager.userId, PAGE_VERSION_CAP);
    expect((await fingerprint(id)).count).toBe(100);

    actor.current = await memberOf(t, 'late', 'member');
    await save(id, 'One more.');

    const numbers = (await adminDb.pageVersion.findMany({ where: { pageId: id } })).map(
      (v) => v.number,
    );
    expect(numbers).toHaveLength(100);
    expect(numbers).not.toContain(1);
    expect(numbers).toContain(101);
    expect(Math.min(...numbers)).toBe(2);
  });
});

describe('seam: restore', () => {
  it('restoring v1 through the route makes it current as a new version and keeps every earlier one', async () => {
    const t = await makeTenant('Back');
    actor.current = t.manager;
    const id = await create('Plan');
    await save(id, 'Alpha.');
    const writer = await memberOf(t, 'w', 'member');
    actor.current = writer;
    await save(id, 'Beta.');

    actor.current = t.manager;
    const res = await restore(id, 1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: ListedVersion;
      bodyState: string;
      revision: number;
    };
    expect(body.version).toMatchObject({ number: 3, restoredFromNumber: 1, isCurrent: true });

    // The page door now serves v1's content, as markdown and as the returned state.
    const page = (await (await read(id)).json()) as { bodyState: string; revision: number };
    expect(stateToMarkdown(decode(page.bodyState))).toBe('Alpha.');
    expect(page.bodyState).toBe(body.bodyState);
    expect(page.revision).toBe(body.revision);

    const rows = await listed(id);
    expect(rows.map((v) => [v.number, v.restoredFromNumber, v.isCurrent])).toEqual([
      [3, 1, true],
      [2, null, false],
      [1, null, false],
    ]);
  });

  it('a restore and another member’s save, in parallel, both land with distinct numbers', async () => {
    const t = await makeTenant('Race');
    actor.current = t.manager;
    const id = await create('Contended');
    await save(id, 'Alpha.');
    const writer = await memberOf(t, 'racer', 'member');
    actor.current = writer;
    await save(id, 'Beta.');
    await ageVersions(id);
    const state = await currentState(id);
    actor.current = null;

    const [restored, saved] = await Promise.all([
      as(t.manager, () => restore(id, 1)),
      as(writer, () => rawSave(id, editorUpdate(state, 'Gamma.'))),
    ]);
    expect(restored.status).toBe(200);
    expect(saved.status).toBe(200);

    const rows = await adminDb.pageVersion.findMany({
      where: { pageId: id },
      orderBy: { number: 'asc' },
    });
    expect(rows.map((v) => v.number)).toEqual([1, 2, 3, 4]);
    const added = rows.slice(2);
    expect(added.map((v) => v.authorId).sort()).toEqual([t.manager.userId, writer.userId].sort());
    expect(added.find((v) => v.authorId === t.manager.userId)!.restoredFromNumber).toBe(1);
    // Neither write lost the other: the writer's paragraph merged either way.
    const markdown = stateToMarkdown(await as(writer, () => currentState(id)));
    expect(markdown).toContain('Gamma.');
  });

  it('a restore row whose source the cap pruned reads restoredFromKept: false and keeps its number', async () => {
    const t = await makeTenant('Pruned');
    actor.current = t.manager;
    const id = await create('Old');
    await save(id, 'Alpha.');
    actor.current = await memberOf(t, 'w', 'member');
    await save(id, 'Beta.');
    actor.current = t.manager;
    expect((await restore(id, 1)).status).toBe(200);
    expect((await listed(id))[0]).toMatchObject({ restoredFromNumber: 1, restoredFromKept: true });

    await seedVersions(t, id, t.manager.userId, PAGE_VERSION_CAP);
    actor.current = await memberOf(t, 'pusher', 'member');
    await save(id, 'Pushes v1 out.');

    expect((await version(id, 1)).status).toBe(404);
    const v3 = (await listed(id)).find((v) => v.number === 3)!;
    expect(v3).toMatchObject({ restoredFromNumber: 1, restoredFromKept: false });
    const restoreGone = await restore(id, 1);
    expect(restoreGone.status).toBe(404);
    expect(await restoreGone.json()).toMatchObject({ code: 'PAGE_VERSION_NOT_FOUND' });
  });
});

// ── Guards ───────────────────────────────────────────────────────────────────

describe('guard: the history keys per built-in role (ADR §5)', () => {
  const EXPECTED: Record<WorkspaceRole, { list: number; get: number; restore: number }> = {
    manager: { list: 200, get: 200, restore: 200 },
    member: { list: 200, get: 200, restore: 200 },
    viewer: { list: 200, get: 200, restore: 403 },
  };

  it.each(Object.keys(EXPECTED) as WorkspaceRole[])('a %s', async (role) => {
    const want = EXPECTED[role];
    const t = await makeTenant(`Hist${role}`);
    actor.current = t.manager;
    const id = await create('Shared');
    await save(id, 'Alpha.');
    await ageVersions(id);
    await save(id, 'Beta.');

    actor.current = role === 'manager' ? t.manager : await memberOf(t, role, role);
    expect((await list(id)).status).toBe(want.list);
    expect((await version(id, 1)).status).toBe(want.get);
    const restored = await restore(id, 1);
    expect(restored.status).toBe(want.restore);
    if (want.restore === 403) {
      expect(await restored.json()).toMatchObject({ code: 'PROJECT_ACCESS_DENIED' });
    }
    expect((await fingerprint(id)).count).toBe(want.restore === 200 ? 3 : 2);
  });

  it('a non-member gets the page-not-found body from all three doors', async () => {
    const a = await makeTenant('Owner');
    const b = await makeTenant('Stranger');
    actor.current = a.manager;
    const id = await create('Private');
    await save(id, 'Alpha.');

    actor.current = b.manager;
    for (const res of [await list(id), await version(id, 1), await restore(id, 1)]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });
    }
    expect((await fingerprint(id)).count).toBe(1);
  });
});

describe('guard: tenancy of page_version', () => {
  /** `withWorkspaceContext`'s GUC binding plus the drop to the non-bypass role. */
  async function asAppRole<T>(
    ctx: { userId: string; workspaceId: string; projectId?: string },
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
      if (ctx.projectId !== undefined) {
        await tx.$executeRaw`SELECT set_config('app.project_id', ${ctx.projectId}, true)`;
      }
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return fn(tx);
    });
  }

  it('workspace B’s versions are invisible under A’s context, and the project narrowing hides a sibling project’s', async () => {
    const a = await makeTenant('Ayy');
    const b = await makeTenant('Bee');
    actor.current = a.manager;
    const inP = await create('In P');
    await setProjectAccess(adminDb, a.otherProjectId, 'workspace');
    const inQ = await pagesService.createPage(svc(a.manager), {
      projectId: a.otherProjectId,
      title: 'In Q',
    });
    actor.current = b.manager;
    const inB = await create('In B');

    const ids = async (ctx: { userId: string; workspaceId: string; projectId?: string }) =>
      (
        await asAppRole(ctx, (tx) =>
          tx.pageVersion.findMany({ select: { pageId: true }, orderBy: { pageId: 'asc' } }),
        )
      ).map((r) => r.pageId);

    const wide = await ids(svc(a.manager));
    expect(wide.sort()).toEqual([inP, inQ.id].sort());
    expect(wide).not.toContain(inB);
    expect(await ids({ ...svc(a.manager), projectId: a.projectId })).toEqual([inP]);

    // And through the door: A's project P never lists Q's page's history.
    actor.current = a.manager;
    const res = await list(inQ.id);
    expect(res.status).toBe(404);
  });
});
