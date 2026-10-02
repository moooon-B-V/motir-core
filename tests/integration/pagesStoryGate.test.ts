import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';

// STORY MOTIR-5752's INTEGRATION GATE (MOTIR-7281) — the ASSEMBLED pages layer,
// on real Postgres, through the real doors.
//
// Each card of the story tested its own layer with the next one mocked or faked:
// the package's procedures over an in-memory store, the editor with `fetch`
// stubbed, the routes with the service real but no editor-shaped bytes. What no
// card's suite could see is the SEAMS between them, so this file drives each one
// end to end:
//
//   • a Yjs update shaped the way the editor ships it (one doc's `update` events,
//     merged) → `POST /api/pages/<id>/updates` → `pagesService.savePageUpdate` →
//     the package's `savePageUpdate` → `pageStoreFor(tx)` → the `page` row → and
//     back out through `getPage` and the package's conversions;
//   • an image uploaded through the page images door, referenced in a saved body,
//     surviving the orphan sweep with its safety window elapsed, and read back
//     through the attachment content door;
//   • the `page:view` / `page:edit` keys through EVERY page door, per built-in
//     role (`docs/decisions/pages.md` §5), and the tenant and project ceilings.
//
// Mocked, and only these: the session and the active project (`getSession`,
// `getActiveProject`) and the content door's workspace context, which need
// cookies — the pattern `tests/api/pages-routes.test.ts` and
// `tests/services/attachmentsService.pageImage.integration.test.ts` set — and the
// blob store, which has no live instance in the test environment.

vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string) => ({ pathname })),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => undefined),
}));

interface Actor {
  userId: string;
  workspaceId: string;
  projectId: string;
}

const actor = vi.hoisted(() => ({ current: null as Actor | null }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (actor.current ? { user: { id: actor.current.userId } } : null)),
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () => actor.current),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: vi.fn(async () =>
    actor.current ? { userId: actor.current.userId, workspaceId: actor.current.workspaceId } : null,
  ),
}));

const { POST: CREATE } = await import('@/app/api/pages/route');
const { GET: READ, PATCH: RENAME } = await import('@/app/api/pages/[pageId]/route');
const { POST: SAVE } = await import('@/app/api/pages/[pageId]/updates/route');
const { POST: UPLOAD } = await import('@/app/api/pages/[pageId]/images/route');
const { GET: CONTENT } = await import('@/app/api/attachments/[id]/content/route');
const { pagesService } = await import('@/lib/services/pagesService');
const { attachmentsService, ORPHAN_SAFETY_WINDOW_MS } =
  await import('@/lib/services/attachmentsService');
const { PAGE_FRAGMENT, PageNotFoundError, deriveFormats, stateToMarkdown, markdownToUpdate } =
  await import('@/lib/pages');
const { ProjectAccessDeniedError } = await import('@/lib/projects/errors');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { setProjectAccess } = await import('../helpers/projectAccess');

// ── The editor's update shape ────────────────────────────────────────────────
//
// `<PageEditor>` binds a `Y.Doc` loaded from `getPage`'s state, collects the doc's
// `update` events while the writer types, and ships the batch as ONE
// `Y.mergeUpdates(batch)` (`packages/pages/src/editor/autosave.ts`). This builds
// exactly that: the same Yjs the package resolves, a doc loaded from the state
// the test was handed, a structural edit to the fragment y-prosemirror binds,
// and the merged update events. `@motir/pages` re-exports no Yjs surface and the
// app never names `yjs`, so it is reached from the package's own resolution.

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

/** The update the editor would send after the writer appends `paragraphs` to `state`. */
function editorUpdate(state: Uint8Array, ...paragraphs: string[]): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const batch: Uint8Array[] = [];
  doc.on('update', (update) => batch.push(update));
  const fragment = doc.getXmlFragment(PAGE_FRAGMENT);
  // One transaction per keystroke-burst, as ProseMirror dispatches them.
  for (const text of paragraphs) {
    doc.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      const run = new Y.XmlText();
      run.insert(0, text);
      paragraph.insert(0, [run]);
      fragment.insert(fragment.length, [paragraph]);
    });
  }
  expect(batch.length).toBe(paragraphs.length);
  return Y.mergeUpdates(batch);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "attachment", "page" RESTART IDENTITY CASCADE');
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
    email: `pages-gate-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Gate ${tag}`,
  });
}

interface Tenant {
  workspaceId: string;
  /** Project P — the workspace's first project. */
  projectId: string;
  /** Project Q — a sibling in the same workspace. */
  otherProjectId: string;
  /** The workspace's creator: a Manager. */
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

// ── The doors, as the browser calls them ─────────────────────────────────────

const BASE = 'http://localhost:3000/api/pages';
const params = (pageId: string) => ({ params: Promise.resolve({ pageId }) });

function create(body?: unknown): Promise<Response> {
  return CREATE(
    new Request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const read = (pageId: string) => READ(new Request(`${BASE}/${pageId}`), params(pageId));

function rename(pageId: string, title: string): Promise<Response> {
  return RENAME(
    new Request(`${BASE}/${pageId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
    params(pageId),
  );
}

/** What `sendPageUpdate` (the editor host) sends: raw bytes, octet-stream. */
function save(pageId: string, update: Uint8Array): Promise<Response> {
  return SAVE(
    new Request(`${BASE}/${pageId}/updates`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(update) as BodyInit,
    }),
    params(pageId),
  );
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function upload(pageId: string): Promise<Response> {
  const form = new FormData();
  form.set('file', new File([PNG as BlobPart], 'diagram.png', { type: 'image/png' }));
  return UPLOAD(new Request(`${BASE}/${pageId}/images`, { method: 'POST', body: form }), {
    params: Promise.resolve({ pageId }),
  });
}

function content(id: string): Promise<Response> {
  return CONTENT(new Request(`http://localhost:3000/api/attachments/${id}/content`), {
    params: Promise.resolve({ id }),
  });
}

const idFromUrl = (url: string) => /\/api\/attachments\/([^/]+)\/content$/.exec(url)![1]!;
const decode = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));

/** `getPage`'s state, as the page at its address hands it to the editor. */
async function stateOf(a: Actor, pageId: string): Promise<Uint8Array> {
  const page = await pagesService.getPage(svc(a), { projectId: a.projectId, pageId });
  return decode(page.bodyState);
}

/**
 * THE DERIVED-FORMAT SEAM: the row's markdown, text and JSON are what the
 * package derives from the row's OWN state — never a format the save computed
 * from something else. Called after every save in this file.
 */
async function expectDerivedAgree(pageId: string): Promise<{ markdown: string; text: string }> {
  const row = await adminDb.page.findUniqueOrThrow({ where: { id: pageId } });
  const derived = deriveFormats(new Uint8Array(row.bodyState));
  expect(row.bodyMarkdown).toBe(derived.markdown);
  expect(row.bodyText).toBe(derived.text);
  expect(row.bodyJson).toEqual(derived.json);
  return { markdown: row.bodyMarkdown, text: row.bodyText };
}

async function createdId(res: Response): Promise<string> {
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

// ── Seams ────────────────────────────────────────────────────────────────────

describe('seam: the save round-trip', () => {
  it('an editor-shaped update POSTed as raw bytes reads back through getPage → stateToMarkdown', async () => {
    const t = await makeTenant('Round');
    actor.current = await memberOf(t, 'writer', 'member');
    const id = await createdId(await create({ title: 'Runbook' }));
    await expectDerivedAgree(id);

    const first = editorUpdate(await stateOf(actor.current, id), 'Tag the commit.');
    const saved = await save(id, first);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ revision: 2 });
    expect(await expectDerivedAgree(id)).toEqual({
      markdown: 'Tag the commit.',
      text: 'Tag the commit.',
    });

    // A second edit, generated from the state getPage NOW returns.
    const second = editorUpdate(await stateOf(actor.current, id), 'Then push the tag.');
    expect((await save(id, second)).status).toBe(200);

    const page = await pagesService.getPage(svc(actor.current), {
      projectId: t.projectId,
      pageId: id,
    });
    expect(page.revision).toBe(3);
    expect(stateToMarkdown(decode(page.bodyState))).toBe('Tag the commit.\n\nThen push the tag.');
    expect(await expectDerivedAgree(id)).toEqual({
      markdown: 'Tag the commit.\n\nThen push the tag.',
      text: 'Tag the commit.\nThen push the tag.',
    });

    // The read door returns the same state the service does.
    const viaRoute = (await (await read(id)).json()) as { bodyState: string; revision: number };
    expect(viaRoute.revision).toBe(3);
    expect(viaRoute.bodyState).toBe(page.bodyState);
  });

  it('a markdown-door update (the agents’ way in) lands through the same seam', async () => {
    const t = await makeTenant('Mdoor');
    actor.current = t.manager;
    const id = await createdId(await create());
    const update = markdownToUpdate(await stateOf(t.manager, id), '# Goals\n\n- [ ] ship');
    expect((await save(id, update)).status).toBe(200);
    expect(stateToMarkdown(await stateOf(t.manager, id))).toBe('# Goals\n\n- [ ] ship');
    await expectDerivedAgree(id);
  });
});

describe('seam: concurrent stale saves', () => {
  it('two updates made from the SAME stale state, POSTed in parallel, both survive', async () => {
    const t = await makeTenant('Race');
    const a = await memberOf(t, 'alice', 'member');
    actor.current = a;
    const id = await createdId(await create());
    expect((await save(id, editorUpdate(await stateOf(a, id), 'Base line.'))).status).toBe(200);

    // Both writers loaded the page at revision 2 and edited independently.
    const stale = await stateOf(a, id);
    const fromAlice = editorUpdate(stale, 'Alice was here.');
    const fromBob = editorUpdate(stale, 'Bob was here.');

    const [r1, r2] = await Promise.all([save(id, fromAlice), save(id, fromBob)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const revisions = [
      ((await r1.json()) as { revision: number }).revision,
      ((await r2.json()) as { revision: number }).revision,
    ].sort();
    // Serialised under the row lock: one landed at 3, the other merged onto it at 4.
    expect(revisions).toEqual([3, 4]);

    const markdown = stateToMarkdown(await stateOf(a, id));
    expect(markdown).toContain('Base line.');
    expect(markdown).toContain('Alice was here.');
    expect(markdown).toContain('Bob was here.');
    const derived = await expectDerivedAgree(id);
    expect(derived.markdown).toBe(markdown);
    const row = await adminDb.page.findUniqueOrThrow({ where: { id } });
    expect(row.revision).toBe(4);
  });
});

describe('seam: a page image is owned by its page', () => {
  it('uploaded, referenced in a saved body, then swept with the window elapsed — the content door still redirects', async () => {
    const t = await makeTenant('Image');
    actor.current = await memberOf(t, 'painter', 'member');
    const id = await createdId(await create({ title: 'Diagram' }));

    const up = await upload(id);
    expect(up.status).toBe(200);
    const { url } = (await up.json()) as { url: string };
    const attachmentId = idFromUrl(url);

    const update = markdownToUpdate(
      await stateOf(actor.current, id),
      `The flow:\n\n![diagram](${url})`,
    );
    expect((await save(id, update)).status).toBe(200);
    const { markdown } = await expectDerivedAgree(id);
    expect(markdown).toContain(`![diagram](${url})`);

    // Age the image AND an unowned control row past the safety window, so the
    // sweep provably ran over both and chose.
    const aged = new Date(Date.now() - ORPHAN_SAFETY_WINDOW_MS - 60_000);
    await adminDb.attachment.update({ where: { id: attachmentId }, data: { createdAt: aged } });
    const control = await adminDb.attachment.create({
      data: {
        workspaceId: t.workspaceId,
        uploaderUserId: actor.current.userId,
        blobPathname: `attachments/${t.workspaceId}/orphan.png`,
        mimeType: 'image/png',
        sizeBytes: 8,
        originalFilename: 'orphan.png',
        createdAt: aged,
      },
    });

    const summary = await attachmentsService.sweepOrphanAttachments();
    expect(summary).toEqual({ scanned: 1, deleted: 1, failed: 0 });
    expect(await adminDb.attachment.findUnique({ where: { id: control.id } })).toBeNull();

    const row = await adminDb.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row).toMatchObject({ pageId: id, workItemId: null });
    const res = await content(attachmentId);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://blob.example/signed/${row.blobPathname}`);
  });
});

describe('seam: create, rename, then list', () => {
  it('a page created through POST /api/pages and renamed through PATCH is FIRST in listPages, with its new title', async () => {
    const t = await makeTenant('List');
    const m = await memberOf(t, 'lister', 'member');
    actor.current = m;
    const renamedId = await createdId(await create({ title: 'Draft' }));
    const otherId = await createdId(await create({ title: 'Later page' }));

    // Before the rename the newer page leads.
    const before = await pagesService.listPages(svc(m), { projectId: t.projectId });
    expect(before.map((p) => p.id)).toEqual([otherId, renamedId]);

    const res = await rename(renamedId, '  Release runbook  ');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: 'Release runbook' });

    const after = await pagesService.listPages(svc(m), { projectId: t.projectId });
    expect(after[0]).toMatchObject({
      id: renamedId,
      title: 'Release runbook',
      updatedBy: { id: m.userId, name: 'Gate lister' },
    });
    expect(after.map((p) => p.id)).toEqual([renamedId, otherId]);
  });
});

// ── Guards ───────────────────────────────────────────────────────────────────

describe('guard: cross-tenant isolation (workspace A vs workspace B)', () => {
  it('a member of B finds A’s page through no door, and B’s list never holds it', async () => {
    const a = await makeTenant('Alpha');
    const b = await makeTenant('Bravo');
    const page = await pagesService.createPage(svc(a.manager), { projectId: a.projectId });
    actor.current = a.manager;
    const image = idFromUrl(((await (await upload(page.id)).json()) as { url: string }).url);
    const before = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });

    // B's own Manager — the strongest key-holder in B — standing in B's project.
    const intruder = b.manager;
    actor.current = intruder;
    await expect(
      pagesService.getPage(svc(intruder), { projectId: b.projectId, pageId: page.id }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
    // Naming A's project outright does not help: B's member cannot browse it.
    await expect(
      pagesService.getPage(svc(intruder), { projectId: a.projectId, pageId: page.id }),
    ).rejects.toThrow();
    await expect(
      pagesService.listPages(svc(intruder), { projectId: a.projectId }),
    ).rejects.toThrow();
    expect(await pagesService.listPages(svc(intruder), { projectId: b.projectId })).toEqual([]);

    const notFound = { code: 'PAGE_NOT_FOUND', error: 'Page not found.' };
    for (const res of [
      await read(page.id),
      await rename(page.id, 'Taken'),
      await save(page.id, editorUpdate(new Uint8Array(before.bodyState), 'Injected.')),
      await upload(page.id),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(notFound);
    }
    expect((await content(image)).status).toBe(404);

    // Nothing moved in A.
    const after = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(after).toMatchObject({ title: before.title, revision: before.revision });
    expect(await adminDb.attachment.count({ where: { workspaceId: b.workspaceId } })).toBe(0);
  });
});

describe('guard: cross-project isolation (project P vs project Q, one workspace)', () => {
  it('a member of Q only finds no page of the members-only project P, and Q’s list never holds it', async () => {
    const t = await makeTenant('Split');
    await setProjectAccess(adminDb, t.projectId, 'members');
    const page = await pagesService.createPage(svc(t.manager), {
      projectId: t.projectId,
      title: 'P only',
    });
    actor.current = t.manager;
    const image = idFromUrl(((await (await upload(page.id)).json()) as { url: string }).url);

    // A workspace Member who is in Q (open to the workspace) and NOT in P.
    const qMember = { ...(await memberOf(t, 'q-member', 'member')), projectId: t.otherProjectId };
    actor.current = qMember;

    await expect(
      pagesService.getPage(svc(qMember), { projectId: t.otherProjectId, pageId: page.id }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
    const refused = await pagesService
      .getPage(svc(qMember), { projectId: t.projectId, pageId: page.id })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ProjectAccessDeniedError);
    expect((refused as InstanceType<typeof ProjectAccessDeniedError>).kind).toBe('browse');
    await expect(
      pagesService.listPages(svc(qMember), { projectId: t.projectId }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect(await pagesService.listPages(svc(qMember), { projectId: t.otherProjectId })).toEqual([]);

    for (const res of [
      await read(page.id),
      await rename(page.id, 'Taken'),
      await save(page.id, editorUpdate(await stateOf(t.manager, page.id), 'Injected.')),
      await upload(page.id),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });
    }
    expect((await content(image)).status).toBe(404);

    const row = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(row).toMatchObject({ title: 'P only', revision: 1 });
  });
});

describe('guard: the permission keys through every page door (ADR §5)', () => {
  // Manager holds all three keys, Member `page:view` + `page:edit`, Viewer
  // `page:view` only. So reading (the list, a page, an image) is open to all
  // three, and every WRITE door — create, rename, save, image upload — is the
  // Viewer's 403, never a 404: the Viewer may browse the project, so the refusal
  // is a forbidden, not an unknown.
  const EXPECTED: Record<
    WorkspaceRole,
    {
      list: 'ok' | 'refused';
      create: number;
      read: number;
      rename: number;
      updates: number;
      images: number;
      canEdit: boolean;
    }
  > = {
    manager: {
      list: 'ok',
      create: 201,
      read: 200,
      rename: 200,
      updates: 200,
      images: 200,
      canEdit: true,
    },
    member: {
      list: 'ok',
      create: 201,
      read: 200,
      rename: 200,
      updates: 200,
      images: 200,
      canEdit: true,
    },
    viewer: {
      list: 'ok',
      create: 403,
      read: 200,
      rename: 403,
      updates: 403,
      images: 403,
      canEdit: false,
    },
  };

  it.each(Object.keys(EXPECTED) as WorkspaceRole[])('a %s', async (role) => {
    const want = EXPECTED[role];
    const t = await makeTenant(`Role${role}`);
    const page = await pagesService.createPage(svc(t.manager), {
      projectId: t.projectId,
      title: 'Shared',
    });
    actor.current = t.manager;
    const seeded = idFromUrl(((await (await upload(page.id)).json()) as { url: string }).url);

    const who = role === 'manager' ? t.manager : await memberOf(t, role, role);
    actor.current = who;

    // list — the `/pages` index's read.
    const listed = await pagesService
      .listPages(svc(who), { projectId: t.projectId })
      .then(() => 'ok' as const)
      .catch(() => 'refused' as const);
    expect(listed).toBe(want.list);
    if (listed === 'ok') {
      const rows = await pagesService.listPages(svc(who), { projectId: t.projectId });
      expect(rows.map((r) => r.id)).toContain(page.id);
    }

    // create
    const created = await create({ title: `${role}'s page` });
    expect(created.status).toBe(want.create);
    if (want.create !== 201) {
      expect(await created.json()).toMatchObject({ code: 'PROJECT_ACCESS_DENIED' });
    }

    // read
    const got = await read(page.id);
    expect(got.status).toBe(want.read);
    expect(await got.json()).toMatchObject({ id: page.id, canEdit: want.canEdit });

    // rename
    const renamed = await rename(page.id, `Renamed by ${role}`);
    expect(renamed.status).toBe(want.rename);

    // updates
    const saved = await save(page.id, editorUpdate(await stateOf(who, page.id), `${role} line`));
    expect(saved.status).toBe(want.updates);
    await expectDerivedAgree(page.id);

    // images — upload, and the content read every reader keeps.
    const uploaded = await upload(page.id);
    expect(uploaded.status).toBe(want.images);
    expect((await content(seeded)).status).toBe(302);

    // What the writes left behind, read from the row rather than the responses.
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(row.title).toBe(want.rename === 200 ? `Renamed by ${role}` : 'Shared');
    expect(row.revision).toBe(want.updates === 200 ? 2 : 1);
    expect(await adminDb.page.count({ where: { projectId: t.projectId } })).toBe(
      want.create === 201 ? 2 : 1,
    );
    expect(await adminDb.attachment.count({ where: { pageId: page.id } })).toBe(
      want.images === 200 ? 2 : 1,
    );
  });
});
