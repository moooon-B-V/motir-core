// @vitest-environment happy-dom
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Suspense, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import type { PageListItemDto } from '@/lib/dto/pages';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE `/pages` INDEX (Story MOTIR-5752 · MOTIR-7300) — `design/pages/pages.mock.html`
// states 2–5. Two halves:
//
// 1. `PagesIndex`, rendered with the real catalogs: the rows in the order the
//    service returned them, each ONE link to `/pages/<id>`, the untitled copy,
//    "Edited <time> by <name>" / "by you", and the two empty states — New page
//    for a member, no call to action for a viewer.
// 2. The Server Component, in `MyAgentsPage.test.tsx`'s shape: the request
//    boundary mocked, `await PagesIndexPage()`, and the element tree asserted —
//    `notFound()` BEFORE any read for a reader without `page:view`, then the
//    header, then an in-page <Suspense> whose child reads `listPages`.

const { getSession, getActiveProject, getPermissions, listPages } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveProject: vi.fn(),
  getPermissions: vi.fn(),
  listPages: vi.fn(),
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
vi.mock('@/lib/services/pagesService', () => ({ pagesService: { listPages } }));

import PagesIndexPage from '@/app/(authed)/pages/page';
import { PagesIndex } from '@/app/(authed)/pages/_components/PagesIndex';
import { PagesIndexFrame } from '@/app/(authed)/pages/_components/PagesIndexFrame';
import { NewPageButton } from '@/app/(authed)/pages/_components/NewPageButton';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const VIEWER_ID = 'u-me';

const PAGES: PageListItemDto[] = [
  {
    id: 'pg-1',
    title: 'Release runbook — v2.4',
    updatedAt: '2026-10-02T11:58:00.000Z',
    updatedBy: { id: 'u-mia', name: 'Mia Chen' },
  },
  {
    id: 'pg-2',
    title: '',
    updatedAt: '2026-10-02T11:46:00.000Z',
    updatedBy: { id: VIEWER_ID, name: 'Zhu Yue' },
  },
  {
    id: 'pg-3',
    title: '迁移计划：工作区设置',
    updatedAt: '2026-10-02T11:00:00.000Z',
    updatedBy: { id: 'u-yue', name: 'Zhu Yue' },
  },
];

function mountIndex(
  props: { pages?: PageListItemDto[]; canEdit?: boolean },
  options: { permissions?: PermissionKey[]; zh?: boolean } = {},
) {
  const permissions = options.permissions ?? ['page:view', 'page:edit'];
  return renderWithIntl(
    <ProjectAccessProvider permissions={permissions}>
      <PagesIndex
        pages={props.pages ?? PAGES}
        viewerId={VIEWER_ID}
        canEdit={props.canEdit ?? true}
        now={NOW}
      />
    </ProjectAccessProvider>,
    options.zh ? { locale: 'zh', messages: zhMessages, now: NOW } : { now: NOW },
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PagesIndex — the list (states 2 and 4)', () => {
  it('renders every page, in the order given, each as ONE link to its own address', () => {
    mountIndex({});
    const list = screen.getByRole('list', { name: 'Pages in this project' });
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/pages/pg-1',
      '/pages/pg-2',
      '/pages/pg-3',
    ]);
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  });

  it('a row carries the title and "Edited <time> by <name>"; the reader’s own edit says "by you"', () => {
    mountIndex({});
    const [first, second, third] = screen.getAllByRole('link');
    expect(first!.textContent).toContain('Release runbook — v2.4');
    expect(first!.textContent).toContain('Edited 2 minutes ago by Mia Chen');
    expect(second!.textContent).toContain('Edited 14 minutes ago by you');
    // Page content is the writer's and is never translated.
    expect(third!.textContent).toContain('迁移计划：工作区设置');
    expect(third!.textContent).toContain('Edited 1 hour ago by Zhu Yue');
  });

  it('an untitled page is still a findable row — the untitled copy, in secondary ink', () => {
    mountIndex({});
    const untitled = screen.getByText('Untitled');
    expect(untitled.closest('a')?.getAttribute('href')).toBe('/pages/pg-2');
    expect(untitled.className).toContain('text-(--el-text-secondary)');
    expect(untitled.className).toContain('italic');
  });

  it('a viewer sees the same rows and links', () => {
    mountIndex({ canEdit: false }, { permissions: ['page:view'] });
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders zh chrome beside the writer’s own titles', () => {
    mountIndex({}, { zh: true });
    expect(screen.getByRole('list', { name: '此项目中的页面' })).toBeTruthy();
    expect(screen.getByText('无标题')).toBeTruthy();
    expect(screen.getByText('Release runbook — v2.4')).toBeTruthy();
    expect(screen.getAllByRole('link')[1]!.textContent).toContain('你于');
  });
});

describe('PagesIndex — the empty state (state 3)', () => {
  it('a member is offered New page as the call to action', () => {
    mountIndex({ pages: [], canEdit: true });
    const empty = screen.getByTestId('pages-empty');
    expect(within(empty).getByText('No pages yet')).toBeTruthy();
    expect(within(empty).getByText(/Write down a spec, a runbook/)).toBeTruthy();
    expect(within(empty).getByRole('button', { name: 'New page' })).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('a viewer gets no call to action, and copy that says who writes pages', () => {
    mountIndex({ pages: [], canEdit: false }, { permissions: ['page:view'] });
    const empty = screen.getByTestId('pages-empty');
    expect(within(empty).getByText('No pages yet')).toBeTruthy();
    expect(
      within(empty).getByText('When someone in this project writes a page, it appears here.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('PagesIndexFrame — the pending frame (state 5)', () => {
  it('is the shared PageSkeleton with no header, standing in for five rows', () => {
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
    listPages.mockResolvedValue(PAGES);
  });

  it('a reader without `page:view` gets notFound, and the list is never read', async () => {
    getPermissions.mockResolvedValue(new Set(['project:browse']));
    await expect(PagesIndexPage()).rejects.toThrow('NOT_FOUND');
    expect(getPermissions).toHaveBeenCalledWith('p1', { userId: VIEWER_ID, workspaceId: 'ws1' });
    expect(listPages).not.toHaveBeenCalled();
  });

  it('no session goes to sign-in before any permission read', async () => {
    getSession.mockResolvedValue(null);
    await expect(PagesIndexPage()).rejects.toThrow('REDIRECT:/sign-in');
    expect(getPermissions).not.toHaveBeenCalled();
  });

  it('renders the real header with New page, then an in-page <Suspense> over the list read', async () => {
    const tree = await PagesIndexPage();
    const all = elements(tree);

    expect(all.some((e) => e.type === 'h1')).toBe(true);
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
    expect(listPages).toHaveBeenCalledWith(
      { userId: VIEWER_ID, workspaceId: 'ws1' },
      { projectId: 'p1' },
    );
    expect(body.type).toBe(PagesIndex);
    expect(body.props).toMatchObject({ pages: PAGES, viewerId: VIEWER_ID, canEdit: true });
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
