// @vitest-environment happy-dom
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Suspense, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import type { PageTreeLevelDto } from '@/lib/dto/pages';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE `/pages` INDEX (Story MOTIR-5752 · MOTIR-7300; the TREE since Story
// MOTIR-5753 · MOTIR-7373) — `design/pages/pages--tree.mock.html` panels 1–8.
// Two halves:
//
// 1. `PagesIndex`, rendered with the real catalogs: the server-read root level
//    handed to the tree (folders, then pages, each page ONE link to
//    `/pages/<id>`), the failed first level, and the two empty states — New page
//    for a member, no call to action for a viewer. The tree itself is
//    `tests/pages/pageTree.test.tsx`'s.
// 2. The Server Component, in `MyAgentsPage.test.tsx`'s shape: the request
//    boundary mocked, `await PagesIndexPage()`, and the element tree asserted —
//    `notFound()` BEFORE any read for a reader without `page:view`, then the
//    header, then an in-page <Suspense> whose child reads the ROOT LEVEL through
//    `listTreeLevel`.

const { getSession, getActiveProject, getPermissions, listTreeLevel } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveProject: vi.fn(),
  getPermissions: vi.fn(),
  listTreeLevel: vi.fn(),
}));
const { redirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({
  redirect,
  notFound,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { getPermissions },
}));
vi.mock('@/lib/services/pagesService', () => ({ pagesService: { listTreeLevel } }));

import PagesIndexPage from '@/app/(authed)/pages/page';
import { PagesIndex } from '@/app/(authed)/pages/_components/PagesIndex';
import { PagesIndexFrame } from '@/app/(authed)/pages/_components/PagesIndexFrame';
import { NewPageButton } from '@/app/(authed)/pages/_components/NewPageButton';

const VIEWER_ID = 'u-me';

const ROOT: PageTreeLevelDto = {
  rows: [
    { kind: 'folder', id: 'f-1', name: 'Specs', hasChildren: true },
    { kind: 'page', id: 'pg-1', title: 'Release runbook — v2.4', hasChildren: false },
    { kind: 'page', id: 'pg-2', title: '', hasChildren: true },
    { kind: 'page', id: 'pg-3', title: '迁移计划：工作区设置', hasChildren: false },
  ],
  nextCursor: null,
};
const EMPTY: PageTreeLevelDto = { rows: [], nextCursor: null };

function mountIndex(
  props: { root?: PageTreeLevelDto | null; canEdit?: boolean },
  options: { permissions?: PermissionKey[]; zh?: boolean } = {},
) {
  const permissions = options.permissions ?? ['page:view', 'page:edit'];
  return renderWithIntl(
    <ProjectAccessProvider permissions={permissions}>
      <PagesIndex
        root={props.root === undefined ? ROOT : props.root}
        projectKey="MOTIR"
        canEdit={props.canEdit ?? true}
      />
    </ProjectAccessProvider>,
    options.zh ? { locale: 'zh', messages: zhMessages } : {},
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PagesIndex — the tree (panels 1 and 8)', () => {
  it('renders the root level, folders first, each page ONE link to its own address', () => {
    mountIndex({});
    const tree = screen.getByRole('tree', { name: 'Folders and pages in this project' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Specs',
      'Release runbook — v2.4',
      'Untitled',
      '迁移计划：工作区设置',
    ]);
    expect(
      within(tree)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/pages/pg-1', '/pages/pg-2', '/pages/pg-3']);
  });

  it('a member gets the row menus; a viewer sees the same rows with no menu at all', () => {
    mountIndex({});
    expect(screen.getByRole('button', { name: 'Folder actions for Specs' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Page actions for Release runbook — v2.4' }),
    ).toBeTruthy();
    cleanup();
    mountIndex({ canEdit: false }, { permissions: ['page:view'] });
    expect(screen.getAllByRole('treeitem')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /actions for/ })).toBeNull();
  });

  it('renders zh chrome beside the writer’s own titles', () => {
    mountIndex({}, { zh: true });
    expect(screen.getByRole('tree', { name: '此项目中的文件夹和页面' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: '无标题' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'Release runbook — v2.4' })).toBeTruthy();
  });

  it('a failed root read is the first-level error, with Try again', () => {
    mountIndex({ root: null });
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load the pages.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('PagesIndex — the empty state (panel 4)', () => {
  it('a member is offered New page as the call to action', () => {
    mountIndex({ root: EMPTY, canEdit: true });
    const empty = screen.getByTestId('pages-empty');
    expect(within(empty).getByText('No pages yet')).toBeTruthy();
    expect(within(empty).getByText(/Write down a spec, a runbook/)).toBeTruthy();
    expect(within(empty).getByRole('button', { name: 'New page' })).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('a viewer gets no call to action, and copy that says who writes pages', () => {
    mountIndex({ root: EMPTY, canEdit: false }, { permissions: ['page:view'] });
    const empty = screen.getByTestId('pages-empty');
    expect(within(empty).getByText('No pages yet')).toBeTruthy();
    expect(
      within(empty).getByText('When someone in this project writes a page, it appears here.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('PagesIndexFrame — the pending frame (panel 5)', () => {
  it('is the shared PageSkeleton with no header, standing in for five tree rows', () => {
    renderWithIntl(<PagesIndexFrame />);
    const frame = screen.getByTestId('page-skeleton');
    expect(frame.getAttribute('aria-busy')).toBe('true');
    expect(within(frame).getByText('Loading page')).toBeTruthy();
    const rows = screen.getByTestId('pages-index-frame').children;
    expect(rows).toHaveLength(5);
  });
});

// ── The Server Component ──────────────────────────────────────────────────

const ACTIVE = {
  userId: VIEWER_ID,
  workspaceId: 'ws1',
  projectId: 'p1',
  project: { id: 'p1', identifier: 'MOTIR', name: 'motir' },
};

/** Collect every element in a tree, depth first. */
function elements(node: ReactNode): ReactElement[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [el, ...elements(el.props?.children)];
}

describe('/pages — the gate first, then the frame', () => {
  beforeEach(() => {
    getSession.mockResolvedValue({ user: { id: VIEWER_ID, name: 'Zhu Yue' } });
    getActiveProject.mockResolvedValue(ACTIVE);
    getPermissions.mockResolvedValue(new Set(['project:browse', 'page:view', 'page:edit']));
    listTreeLevel.mockResolvedValue(ROOT);
  });

  it('a reader without `page:view` gets notFound, and the tree is never read', async () => {
    getPermissions.mockResolvedValue(new Set(['project:browse']));
    await expect(PagesIndexPage()).rejects.toThrow('NOT_FOUND');
    expect(getPermissions).toHaveBeenCalledWith('p1', { userId: VIEWER_ID, workspaceId: 'ws1' });
    expect(listTreeLevel).not.toHaveBeenCalled();
  });

  it('no session goes to sign-in before any permission read', async () => {
    getSession.mockResolvedValue(null);
    await expect(PagesIndexPage()).rejects.toThrow('REDIRECT:/sign-in');
    expect(getPermissions).not.toHaveBeenCalled();
  });

  it('renders the real header with New page, then an in-page <Suspense> over the root-level read', async () => {
    const tree = await PagesIndexPage();
    const all = elements(tree);

    expect(all.some((e) => e.type === 'h1')).toBe(true);
    // The subtitle is the tree's — position order, not "most recently edited".
    expect(all.some((e) => e.type === 'p' && e.props.children === 'pages.tree.subtitle')).toBe(
      true,
    );
    expect(all.some((e) => e.type === NewPageButton)).toBe(true);

    const suspense = all.find((e) => e.type === Suspense) as ReactElement<{
      fallback: ReactElement;
      children: ReactElement<Record<string, unknown>>;
    }>;
    expect(suspense).toBeTruthy();
    expect(suspense.props.fallback.type).toBe(PagesIndexFrame);

    const data = suspense.props.children;
    const component = data.type as (props: Record<string, unknown>) => Promise<ReactNode>;
    const body = (await component(data.props)) as ReactElement<Record<string, unknown>>;
    expect(listTreeLevel).toHaveBeenCalledWith(
      { userId: VIEWER_ID, workspaceId: 'ws1' },
      { projectId: 'p1', parent: { kind: 'root' } },
    );
    expect(body.type).toBe(PagesIndex);
    expect(body.props).toMatchObject({ root: ROOT, projectKey: 'MOTIR', canEdit: true });
  });

  it('a failed root read is not a 500 — the body is handed `null` and draws the error state', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    listTreeLevel.mockRejectedValue(new Error('db down'));
    const tree = await PagesIndexPage();
    const suspense = elements(tree).find((e) => e.type === Suspense) as ReactElement<{
      children: ReactElement<Record<string, unknown>>;
    }>;
    const data = suspense.props.children;
    const component = data.type as (props: Record<string, unknown>) => Promise<ReactNode>;
    const body = (await component(data.props)) as ReactElement<Record<string, unknown>>;
    expect(body.props['root']).toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('a viewer’s body is told it may not edit — the empty state then offers nothing', async () => {
    getPermissions.mockResolvedValue(new Set(['project:browse', 'page:view']));
    const tree = await PagesIndexPage();
    const suspense = elements(tree).find((e) => e.type === Suspense) as ReactElement<{
      children: ReactElement<Record<string, unknown>>;
    }>;
    expect(suspense.props.children.props['canEdit']).toBe(false);
  });

  it('ships no `loading.tsx` — the route decides existence', () => {
    expect(existsSync(join(process.cwd(), 'app/(authed)/pages/loading.tsx'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'app/(authed)/loading.tsx'))).toBe(false);
  });
});
