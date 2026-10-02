import { Suspense, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';

// The two SERVER pages of Story MOTIR-5752 — the `/pages` index (MOTIR-7300) and
// the page at its address (MOTIR-7280) — rendered with the RSC harness
// (`tests/helpers/serverPageHarness.tsx`) against real Postgres. Part of the
// story's coverage gate (MOTIR-7281): the index's `page:view` gate and its list
// read, the page's one-read gate with every not-found case, and both pages'
// metadata.
//
// Mocked: the session and the active project (they need cookies), and the two
// framework calls a page makes that only a Next request can honour —
// `notFound()` / `redirect()` (made to throw, as Next's do) and the server half
// of `next-intl` (the harness's key-echoing `serverTranslations`).

class NotFound extends Error {}
class Redirect extends Error {}

interface Reader {
  userId: string;
  workspaceId: string;
  projectId: string;
  project: unknown;
}

const reader = vi.hoisted(() => ({ current: null as Reader | null }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () =>
    reader.current ? { user: { id: reader.current.userId, name: 'Reader' } } : null,
  ),
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () => reader.current),
}));
vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  notFound: () => {
    throw new NotFound('NEXT_NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock('next-intl/server', async () => ({
  getTranslations: (await import('../helpers/serverPageHarness')).serverTranslations,
}));

const IndexPage = await import('@/app/(authed)/pages/page');
const AddressPage = await import('@/app/(authed)/pages/[pageId]/page');
const { PagesIndex } = await import('@/app/(authed)/pages/_components/PagesIndex');
const { NewPageButton } = await import('@/app/(authed)/pages/_components/NewPageButton');
const { PagesIndexFrame } = await import('@/app/(authed)/pages/_components/PagesIndexFrame');
const { PageView } = await import('@/app/(authed)/pages/[pageId]/_components/PageView');
const { PAGE_TITLE_MAX_LENGTH } = await import('@/lib/pages');
const { pagesService } = await import('@/lib/services/pagesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { createCustomRoleAs, setWorkspaceRoleFor } =
  await import('../helpers/workspaceRoleFixtures');
const { findFirst, renderTree, textOf } = await import('../helpers/serverPageHarness');

beforeEach(async () => {
  await truncateAuthTables();
  reader.current = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function makeUser(tag: string) {
  seq += 1;
  return usersService.createUser({
    email: `pages-rsc-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `RSC ${tag}`,
  });
}

interface Fixture {
  workspaceId: string;
  manager: Reader;
  other: Reader;
}

async function makeFixture(): Promise<Fixture> {
  const owner = await makeUser('owner');
  const ws = await workspacesService.createWorkspace({ name: 'RSC', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'RSC',
    identifier: 'RSC',
  });
  const other = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Other',
    identifier: 'RSO',
  });
  return {
    workspaceId,
    manager: { userId: owner.id, workspaceId, projectId: project.id, project },
    other: { userId: owner.id, workspaceId, projectId: other.id, project: other },
  };
}

async function readerAs(f: Fixture, tag: string, role: WorkspaceRole): Promise<Reader> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: f.workspaceId, workspaceRole: role },
  });
  return { ...f.manager, userId: user.id };
}

/** A workspace member on a custom role that may browse the project and holds no page key. */
async function browserWithoutPageKeys(f: Fixture): Promise<Reader> {
  const r = await readerAs(f, 'browser', 'member');
  const role = await createCustomRoleAs({
    ctx: { userId: f.manager.userId, workspaceId: f.workspaceId },
    name: 'Browse only',
    permissions: ['project:browse'],
  });
  await setWorkspaceRoleFor(r.userId, f.workspaceId, role.id);
  return r;
}

const params = (pageId: string) => ({ params: Promise.resolve({ pageId }) });

/** Render the Suspense child (an async server component) the page streams. */
async function settle(el: ReactElement): Promise<ReactNode> {
  const render = el.type as (props: unknown) => Promise<ReactNode>;
  return render(el.props);
}

describe('/pages — the index', () => {
  it.each([
    ['manager', true],
    ['member', true],
    ['viewer', false],
  ] as const)(
    'a %s gets the header and the list, newest edit first (canEdit %s)',
    async (role, canEdit) => {
      const f = await makeFixture();
      const first = await pagesService.createPage(f.manager, {
        projectId: f.manager.projectId,
        title: 'First',
      });
      const second = await pagesService.createPage(f.manager, {
        projectId: f.manager.projectId,
        title: 'Second',
      });
      // A page in the OTHER project is never listed here.
      await pagesService.createPage(f.manager, {
        projectId: f.other.projectId,
        title: 'Elsewhere',
      });
      reader.current = role === 'manager' ? f.manager : await readerAs(f, role, role);

      const tree = await renderTree(IndexPage.default);
      expect(textOf(tree)).toContain('title');
      expect(findFirst(tree, NewPageButton)).toBeDefined();
      const boundary = findFirst<{ fallback: ReactElement; children: ReactElement }>(
        tree,
        Suspense,
      )!;
      expect(boundary.props.fallback.type).toBe(PagesIndexFrame);

      const list = (await settle(boundary.props.children)) as ReactElement<{
        pages: { id: string; title: string }[];
        viewerId: string;
        canEdit: boolean;
      }>;
      expect(list.type).toBe(PagesIndex);
      expect(list.props.canEdit).toBe(canEdit);
      expect(list.props.viewerId).toBe(reader.current.userId);
      expect(list.props.pages.map((p) => p.id)).toEqual([second.id, first.id]);
    },
  );

  it('a reader without `page:view` gets notFound() and the list is never read', async () => {
    const f = await makeFixture();
    reader.current = await browserWithoutPageKeys(f);
    const list = vi.spyOn(pagesService, 'listPages');
    await expect(renderTree(IndexPage.default)).rejects.toBeInstanceOf(NotFound);
    expect(list).not.toHaveBeenCalled();
  });

  it('is titled from the catalogue', async () => {
    expect(await IndexPage.generateMetadata()).toEqual({ title: 'title' });
  });
});

describe('/pages/<id> — the page at its address', () => {
  it('a member gets the page’s view, writable, behind the in-page frame', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPage(f.manager, {
      projectId: f.manager.projectId,
      title: 'Runbook',
    });
    reader.current = await readerAs(f, 'member', 'member');

    const tree = await renderTree(AddressPage.default, params(page.id));
    const view = findFirst<{
      page: { id: string; title: string; bodyState: string; canEdit: boolean };
      titleMaxLength: number;
    }>(tree, PageView)!;
    expect(view.props.page).toMatchObject({ id: page.id, title: 'Runbook', canEdit: true });
    expect(view.props.titleMaxLength).toBe(PAGE_TITLE_MAX_LENGTH);
    expect(typeof view.props.page.bodyState).toBe('string');

    // The frame draws the header pair and paragraph bars — and no toolbar.
    const boundary = findFirst<{ fallback: ReactElement }>(tree, Suspense)!;
    const frame = await settle(boundary.props.fallback);
    expect(frame).toBeTruthy();

    expect(await AddressPage.generateMetadata(params(page.id))).toEqual({ title: 'Runbook' });
  });

  it('a viewer gets the same page read-only; an untitled page is titled with the untitled copy', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPage(f.manager, { projectId: f.manager.projectId });
    reader.current = await readerAs(f, 'viewer', 'viewer');
    const tree = await renderTree(AddressPage.default, params(page.id));
    expect(findFirst<{ page: { canEdit: boolean } }>(tree, PageView)!.props.page.canEdit).toBe(
      false,
    );
    expect(await AddressPage.generateMetadata(params(page.id))).toEqual({ title: 'untitled' });
  });

  it('an unknown id, a page from another project and a non-browser all get notFound() — and no title', async () => {
    const f = await makeFixture();
    const elsewhere = await pagesService.createPage(f.manager, { projectId: f.other.projectId });
    const mine = await pagesService.createPage(f.manager, { projectId: f.manager.projectId });

    reader.current = f.manager;
    for (const id of ['no-such-page', elsewhere.id]) {
      await expect(renderTree(AddressPage.default, params(id))).rejects.toBeInstanceOf(NotFound);
      expect(await AddressPage.generateMetadata(params(id))).toEqual({});
    }

    // A workspace member outside a members-only project cannot browse it.
    await adminDb.project.update({
      where: { id: f.manager.projectId },
      data: { accessMode: 'members' },
    });
    reader.current = await readerAs(f, 'outsider', 'member');
    await expect(renderTree(AddressPage.default, params(mine.id))).rejects.toBeInstanceOf(NotFound);
  });

  it('a reader who may browse the project but holds no `page:view` gets notFound(), as the index refuses them', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPage(f.manager, { projectId: f.manager.projectId });
    reader.current = await browserWithoutPageKeys(f);
    await expect(renderTree(AddressPage.default, params(page.id))).rejects.toBeInstanceOf(NotFound);
    expect(await AddressPage.generateMetadata(params(page.id))).toEqual({});
  });

  it('an error that is not a refusal is rethrown to the error boundary, never a 404', async () => {
    const f = await makeFixture();
    reader.current = f.manager;
    vi.spyOn(pagesService, 'getPage').mockRejectedValueOnce(new Error('database down'));
    await expect(renderTree(AddressPage.default, params('any'))).rejects.toThrow('database down');
  });

  it('an anonymous reader is sent to sign in', async () => {
    reader.current = null;
    await expect(renderTree(AddressPage.default, params('any'))).rejects.toBeInstanceOf(Redirect);
  });
});
