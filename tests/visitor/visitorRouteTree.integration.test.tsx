import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { db } from '@/lib/db';
import { truncateRateLimitCounters } from '@/tests/helpers/db';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import { waitForWindowHeadroom } from '@/tests/helpers/rateLimitWindow';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// THE VISITOR ROUTE TREE, through the real resolver and datastore (Story
// MOTIR-6170 · MOTIR-6648): `app/(visitor)/p/[identifier]/…` — the layout's
// verdict order (not-found FIRST, then sign in, then a member sent home, then the
// consent screen), the chrome and its permission provider, each of the nine pages
// rendering its shared body for a consented Visitor, the render-time read budget,
// and the member redirect's route handler.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type TestSession = { user: { id: string; name: string; email: string } } | null;
const { state, redirect, notFound, permanentRedirect } = vi.hoisted(() => ({
  state: {
    session: null as { user: { id: string; name: string; email: string } } | null,
    path: null as string | null,
  },
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  permanentRedirect: vi.fn((to: string) => {
    throw new Error(`NEXT_PERMANENT_REDIRECT:${to}`);
  }),
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => state.session }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  notFound,
  permanentRedirect,
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(state.path ? { 'x-current-path': state.path } : {}),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => {
    const t = (key: string) => key;
    t.rich = (key: string) => key;
    return t;
  },
  getLocale: async () => 'en',
  getFormatter: async () => ({
    dateTime: () => '',
    relativeTime: () => '',
    number: (n: number) => String(n),
    list: (items: string[]) => items.join(', '),
  }),
}));

let previousCloud: string | undefined;
// The read budget's window for the budget case: large enough for its slow
// calls, aligned by headroom rather than a whole-window sleep (rateLimitWindow.ts).
const READ_WINDOW_MS = 20_000;
const READ_HEADROOM_MS = 10_000;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  previousCloud = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'];
  state.session = null;
  state.path = null;
  redirect.mockClear();
  notFound.mockClear();
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'];
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT_WINDOW_MS'];
  __resetSharedRateLimitStoreForTest();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
async function project(mode: 'public' | 'members' | 'workspace' = 'public') {
  const identifier = `VT${seq++}`;
  const fx = await makeWorkItemFixture({ name: `Visitor tree ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: projectAccessData(mode),
  });
  return { fx, identifier };
}

async function person(name = 'Riya Sen') {
  return adminDb.user.create({
    data: { email: `visitor-tree-${seq++}@example.com`, name, emailVerified: true },
  });
}
const sessionOf = (u: { id: string; name: string | null; email: string }): TestSession => ({
  user: { id: u.id, name: u.name ?? '', email: u.email },
});

/** A signed-in stranger who pressed Continue on the project's consent screen. */
async function consented(identifier: string) {
  const { visitorRecordsService } = await import('@/lib/services/visitorRecordsService');
  const u = await person();
  await visitorRecordsService.recordConsent({ identifier, userId: u.id });
  state.session = sessionOf(u);
  return u;
}

async function asOwner(fx: { ownerId: string }) {
  const owner = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
  state.session = sessionOf(owner);
  return owner;
}

// ── tree helpers ────────────────────────────────────────────────────────────

function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    const props = node.props as Record<string, unknown>;
    for (const value of Object.values(props)) {
      if (isValidElement(value) || Array.isArray(value)) elements(value as ReactNode, out);
    }
  }
  return out;
}
const named = (tree: ReactNode, name: string) =>
  elements(tree).filter((e) => {
    const type = e.type as { name?: string; displayName?: string } | string;
    return typeof type !== 'string' && (type.displayName ?? type.name) === name;
  });

const params = (identifier: string) => Promise.resolve({ identifier });
const noQuery = () => Promise.resolve({});

async function layout(identifier: string) {
  const { default: VisitorLayout } = await import('@/app/(visitor)/p/[identifier]/layout');
  return VisitorLayout({ children: <main data-probe="view" />, params: params(identifier) });
}

// ── 1. the verdict order ────────────────────────────────────────────────────

describe('the layout decides, in the order that is the privacy boundary', () => {
  it('not_found FIRST: a project that is not public is the same 404, signed out or in', async () => {
    for (const mode of ['members', 'workspace'] as const) {
      const { identifier } = await project(mode);
      state.path = `/p/${identifier}/board`;
      state.session = null;
      await expect(layout(identifier)).rejects.toThrow('NEXT_NOT_FOUND');
      state.session = sessionOf(await person());
      await expect(layout(identifier)).rejects.toThrow('NEXT_NOT_FOUND');
    }
    // Never a sign-in redirect for one of them — that would confirm the key exists.
    expect(redirect).not.toHaveBeenCalled();
  });

  it('not_found for an unknown key and for a cloud-off build, signed out or in', async () => {
    state.session = null;
    await expect(layout('NOSUCH404')).rejects.toThrow('NEXT_NOT_FOUND');
    state.session = sessionOf(await person());
    await expect(layout('NOSUCH404')).rejects.toThrow('NEXT_NOT_FOUND');

    const { identifier } = await project('public');
    process.env['MOTIR_CLOUD'] = 'false';
    state.session = null;
    await expect(layout(identifier)).rejects.toThrow('NEXT_NOT_FOUND');
    await consented(identifier).catch(() => undefined);
    await expect(layout(identifier)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('sign_in: a signed-out reader goes to sign in, and back through the consent screen to THIS view', async () => {
    const { identifier } = await project();
    for (const view of ['board', 'items', 'tree', 'roadmap', 'plans', 'approvals', 'runs']) {
      const here = `/p/${identifier}/${view}`;
      state.path = here;
      await expect(layout(identifier)).rejects.toThrow(
        `NEXT_REDIRECT:/sign-in?next=${encodeURIComponent(
          `/p/${identifier}/consent?next=${encodeURIComponent(here)}`,
        )}`,
      );
    }
    state.path = `/p/${identifier}/items/${identifier}-1?activity=comments`;
    await expect(layout(identifier)).rejects.toThrow(
      encodeURIComponent(encodeURIComponent(`/p/${identifier}/items/${identifier}-1`)),
    );
  });

  it('consent: a signed-in stranger with no record goes to the consent screen, carrying this view', async () => {
    const { identifier } = await project();
    state.session = sessionOf(await person());
    state.path = `/p/${identifier}/roadmap`;
    await expect(layout(identifier)).rejects.toThrow(
      `NEXT_REDIRECT:/p/${identifier}/consent?next=${encodeURIComponent(`/p/${identifier}/roadmap`)}`,
    );
  });

  it('enter: a reader who can enter the project is sent to their own view, never asked to consent', async () => {
    const { fx, identifier } = await project();
    await asOwner(fx);
    state.path = `/p/${identifier}/tree`;
    await expect(layout(identifier)).rejects.toThrow(
      `NEXT_REDIRECT:/p/${identifier}/enter?next=${encodeURIComponent(`/p/${identifier}/tree`)}`,
    );
  });

  it('a forged forwarded path is never followed — the next becomes the default view', async () => {
    const { identifier } = await project();
    state.session = sessionOf(await person());
    for (const forged of ['https://evil.example/x', '//evil.example', '/p/OTHER/board', '/items']) {
      state.path = forged;
      await expect(layout(identifier)).rejects.toThrow(
        `NEXT_REDIRECT:/p/${identifier}/consent?next=${encodeURIComponent(`/p/${identifier}/board`)}`,
      );
    }
  });
});

// ── 2. the chrome ───────────────────────────────────────────────────────────

describe('a consented Visitor gets the Visitor chrome, with the Visitor key set mounted', () => {
  it('mounts ProjectAccessProvider with the Visitor keys — browse, never work_item:edit', async () => {
    const { identifier } = await project();
    await consented(identifier);
    state.path = `/p/${identifier}/board`;
    const tree = await layout(identifier);

    const [provider] = named(tree, 'ProjectAccessProvider');
    expect(
      provider,
      'the permission provider is MOUNTED (it fails open when absent)',
    ).toBeDefined();
    const keys = (provider!.props as { permissions: string[] }).permissions;
    expect(keys).toContain('project:browse');
    for (const write of [
      'work_item:edit',
      'work_item:create',
      'work_item:delete',
      'work_item:archive',
      'comment:add',
      'watcher:manage',
      'project:administer',
    ]) {
      expect(keys, write).not.toContain(write);
    }

    // No create door at all, and no create modal.
    const [create] = named(tree, 'CreateIssueProvider');
    expect(create!.props).toMatchObject({ canEdit: false, canCreate: false });

    // The shell: the banner, the Visitor bar and rail — never the member TopNav,
    // SidebarNav, palette or orb.
    const [shell] = named(tree, 'AppLayout');
    const props = shell!.props as {
      banner: ReactElement;
      topNav: ReactElement;
      sidebar: ReactElement;
    };
    expect((props.banner.type as { name: string }).name).toBe('VisitorBanner');
    expect((props.topNav.type as { name: string }).name).toBe('VisitorTopNav');
    expect((props.sidebar.type as { name: string }).name).toBe('VisitorRail');
    expect(props.topNav.props).toMatchObject({
      projectKey: identifier,
      landingHref: expect.stringMatching(new RegExp(`/p/${identifier}$`)),
    });
    for (const member of [
      'TopNav',
      'SidebarNav',
      'AppCommandPalette',
      'PlanWithAIFab',
      'ReportProvider',
      'PlanningWorkspaceOverlay',
    ]) {
      expect(named(tree, member), member).toHaveLength(0);
    }
  });

  it('is not indexable', async () => {
    const { metadata } = await import('@/app/(visitor)/p/[identifier]/layout');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

// ── 3. the nine pages ───────────────────────────────────────────────────────

async function publicProjectWithWork() {
  const t = await project();
  const epic = await createTestWorkItem(t.fx, { kind: 'epic', title: 'Private launch epic' });
  await adminDb.workItem.update({ where: { id: epic.id }, data: { publicChildrenHidden: true } });
  const hidden = await createTestWorkItem(t.fx, {
    kind: 'story',
    title: 'Hidden story',
    parentId: epic.id,
  });
  const visible = await createTestWorkItem(t.fx, { kind: 'task', title: 'Visible task' });
  return { ...t, epic, hidden, visible };
}

describe('each Visitor page renders its shared body for a consented Visitor', () => {
  it('board, items, tree, roadmap, plans, approvals, runs and requested features render — no no-access state', async () => {
    const t = await publicProjectWithWork();
    await consented(t.identifier);
    const pages: Array<[string, () => Promise<{ default: (p: never) => Promise<ReactNode> }>]> = [
      ['board', () => import('@/app/(visitor)/p/[identifier]/board/page') as never],
      ['items', () => import('@/app/(visitor)/p/[identifier]/items/page') as never],
      ['tree', () => import('@/app/(visitor)/p/[identifier]/tree/page') as never],
      ['roadmap', () => import('@/app/(visitor)/p/[identifier]/roadmap/page') as never],
      ['plans', () => import('@/app/(visitor)/p/[identifier]/plans/page') as never],
      ['approvals', () => import('@/app/(visitor)/p/[identifier]/approvals/page') as never],
      ['runs', () => import('@/app/(visitor)/p/[identifier]/runs/page') as never],
      [
        'requested-features',
        () => import('@/app/(visitor)/p/[identifier]/requested-features/page') as never,
      ],
    ];
    for (const [view, load] of pages) {
      state.path = `/p/${t.identifier}/${view}`;
      const { default: Page } = await load();
      const tree = await Page({ params: params(t.identifier), searchParams: noQuery() } as never);
      expect(isValidElement(tree), view).toBe(true);
      expect(named(tree, 'NoAccessState'), view).toHaveLength(0);
      expect(named(tree, 'VisitorRateLimited'), view).toHaveLength(0);
    }
  });

  it('the board is read-only, and its members carry names, never emails', async () => {
    const t = await publicProjectWithWork();
    await consented(t.identifier);
    state.path = `/p/${t.identifier}/board`;
    const { default: Page } = await import('@/app/(visitor)/p/[identifier]/board/page');
    const tree = await Page({ params: params(t.identifier), searchParams: noQuery() });
    const [board] = named(tree, 'BoardContainer');
    const props = board!.props as {
      canEdit: boolean;
      activeProjectId: string;
      members: { email: string }[];
    };
    expect(props).toMatchObject({ canEdit: false, activeProjectId: t.fx.projectId });
    expect(props.members.length).toBeGreaterThan(0);
    for (const m of props.members) expect(m.email).toBe('');
  });

  it('requested features hands its list the pending set — by votes, names only, no email', async () => {
    const t = await publicProjectWithWork();
    const submitter = await adminDb.user.create({
      data: { email: `rf-${Date.now()}@example.com`, name: 'Rita Submitter', emailVerified: true },
    });
    const request = await createTestWorkItem(t.fx, { kind: 'task', title: 'Dark mode please' });
    await adminDb.workItem.update({
      where: { id: request.id },
      data: { triagedAt: new Date(), submittedByUserId: submitter.id, status: 'todo' },
    });
    await consented(t.identifier);
    state.path = `/p/${t.identifier}/requested-features`;
    const { default: Page } =
      await import('@/app/(visitor)/p/[identifier]/requested-features/page');
    const tree = await Page({ params: params(t.identifier) });
    const [list] = named(tree, 'RequestedFeaturesList');
    const props = list!.props as {
      identifier: string;
      initial: { items: { title: string; submitterName: string }[]; total: number };
    };
    expect(props.identifier).toBe(t.identifier);
    expect(props.initial.items.map((r) => r.title)).toEqual(['Dark mode please']);
    expect(props.initial.items[0]!.submitterName).toBe('Rita Submitter');
    expect(props.initial.total).toBe(1);
    // The ordinary work item and the private epic are not requests.
    expect(JSON.stringify(props.initial)).not.toContain('Visible task');
    expect(JSON.stringify(props.initial)).not.toContain('@');
  });

  it('items is the list and tree is the tree, whatever ?view= says, read as the Visitor', async () => {
    const t = await publicProjectWithWork();
    await consented(t.identifier);
    const pages = {
      items: () => import('@/app/(visitor)/p/[identifier]/items/page'),
      tree: () => import('@/app/(visitor)/p/[identifier]/tree/page'),
    };
    for (const [view, expected] of [
      ['items', 'list'],
      ['tree', 'tree'],
    ] as const) {
      state.path = `/p/${t.identifier}/${view}`;
      const { default: Page } = await pages[view]();
      const tree = await Page({
        params: params(t.identifier),
        searchParams: Promise.resolve({ view: expected === 'list' ? 'tree' : 'list' }),
      });
      const [section] = named(tree, 'IssueTreeSection');
      const props = section!.props as { view: string; reader: { kind?: string } };
      expect(props.view, view).toBe(expected);
      expect(props.reader.kind, 'the collection read is the Visitor’s').toBe('visitor');
      // The list's rows, rendered: the private epic's descendant is absent.
      const rendered = await (section!.type as (p: unknown) => Promise<ReactNode>)(section!.props);
      const text = JSON.stringify(rendered);
      expect(text).toContain('Visible task');
      expect(text).not.toContain('Hidden story');
    }
  });

  it('an item renders; a private epic’s descendant and an unknown key are the same not-found', async () => {
    const t = await publicProjectWithWork();
    await consented(t.identifier);
    const { default: Page } = await import('@/app/(visitor)/p/[identifier]/items/[key]/page');
    const render = (key: string) => {
      state.path = `/p/${t.identifier}/items/${key}`;
      return Page({
        params: Promise.resolve({ identifier: t.identifier, key }),
        searchParams: Promise.resolve({}),
      });
    };
    const tree = await render(t.visible.identifier);
    expect(JSON.stringify(named(tree, 'WorkItemTitle')[0]!.props)).toContain('Visible task');
    expect(named(tree, 'EpicNotPublicBlock')).toHaveLength(0);
    expect(named(tree, 'ChildPanel')).toHaveLength(1);
    const late = named(tree, 'LateUpperSections')[0]!.props as { reads: Promise<unknown> };
    await Promise.allSettled([late.reads]);

    // The private epic's own page: its row stays, marked Not public, and the
    // children panel is replaced by the "This epic is not public" block.
    const epicTree = await render(t.epic.identifier);
    expect(named(epicTree, 'EpicNotPublicBlock')).toHaveLength(1);
    expect(named(epicTree, 'EpicNotPublicPill')).toHaveLength(1);
    expect(named(epicTree, 'ChildPanel')).toHaveLength(0);
    expect(JSON.stringify(epicTree)).not.toContain('Hidden story');
    await Promise.allSettled([
      (named(epicTree, 'LateUpperSections')[0]!.props as { reads: Promise<unknown> }).reads,
    ]);

    await expect(render(t.hidden.identifier)).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(render(`${t.identifier}-9999`)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  // Found by the E2E walk (MOTIR-6651): a visible STORY's page crashed for a
  // Visitor — the acceptance-video eligibility read resolved an organisation the
  // Visitor is not in — and the page offered the Watch control and a plan
  // history the Visitor cannot read.
  it('a visible story renders for a Visitor, with no Watch control and no plan history', async () => {
    const t = await publicProjectWithWork();
    const story = await createTestWorkItem(t.fx, { kind: 'story', title: 'Visible story' });
    await consented(t.identifier);
    const { default: Page } = await import('@/app/(visitor)/p/[identifier]/items/[key]/page');
    state.path = `/p/${t.identifier}/items/${story.identifier}`;
    const tree = await Page({
      params: Promise.resolve({ identifier: t.identifier, key: story.identifier }),
      searchParams: Promise.resolve({}),
    });
    expect(JSON.stringify(named(tree, 'WorkItemTitle')[0]!.props)).toContain('Visible story');
    expect(named(tree, 'WatchControl')).toHaveLength(0);
    expect(named(tree, 'PlanHistorySection')).toHaveLength(0);
    const late = named(tree, 'LateUpperSections')[0]!.props as {
      reads: Promise<{ acceptanceEligibility: unknown }>;
    };
    const reads = await late.reads;
    expect(reads.acceptanceEligibility).toBeNull();
  });

  it('a plan of the project renders; a plan id that is not one is not-found', async () => {
    const t = await publicProjectWithWork();
    await consented(t.identifier);
    const { default: Page } = await import('@/app/(visitor)/p/[identifier]/plans/[id]/page');
    state.path = `/p/${t.identifier}/plans/cnosuchplan`;
    await expect(
      Page({ params: Promise.resolve({ identifier: t.identifier, id: 'cnosuchplan' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('every page runs the same gate — a signed-out reader is sent to sign in by the page too', async () => {
    const { identifier } = await project();
    state.path = `/p/${identifier}/runs`;
    const { default: Page } = await import('@/app/(visitor)/p/[identifier]/runs/page');
    await expect(Page({ params: params(identifier), searchParams: noQuery() })).rejects.toThrow(
      'NEXT_REDIRECT:/sign-in?next=',
    );
  });
});

// ── 4. the read budget ──────────────────────────────────────────────────────

describe('the render-time read budget (design panel 9b)', () => {
  it('past the per-reader budget the view is replaced by the rate-limited state with its seconds', async () => {
    process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'] = '1';
    // The counted calls must share ONE epoch-aligned window cell (MOTIR-2648):
    // pin a window, and guarantee the calls below its headroom before spending.
    process.env['MOTIR_PUBLIC_READ_RATE_LIMIT_WINDOW_MS'] = String(READ_WINDOW_MS);
    const { identifier } = await project();
    await consented(identifier);
    await waitForWindowHeadroom(READ_WINDOW_MS, READ_HEADROOM_MS);
    state.path = `/p/${identifier}/roadmap`;
    const { default: Page } = await import('@/app/(visitor)/p/[identifier]/roadmap/page');
    const first = await Page({ params: params(identifier), searchParams: noQuery() });
    expect(named(first, 'VisitorRateLimited')).toHaveLength(0);
    const second = await Page({ params: params(identifier), searchParams: noQuery() });
    expect(isValidElement(second)).toBe(true);
    const el = second as ReactElement<{ retryAfterSeconds: number }>;
    expect((el.type as { name: string }).name).toBe('VisitorRateLimited');
    expect(el.props.retryAfterSeconds).toBeGreaterThan(0);
  });
});

// ── 5. the member redirect ──────────────────────────────────────────────────

describe('/p/<identifier>/enter — a member who opened a Visitor link', () => {
  const BASE = process.env['MOTIR_BASE_URL']?.replace(/\/+$/, '') ?? 'http://localhost:3000';
  async function enter(identifier: string, next: string) {
    const { GET } = await import('@/app/(visitor)/p/[identifier]/enter/route');
    return GET(new Request(`${BASE}/p/${identifier}/enter?next=${encodeURIComponent(next)}`), {
      params: params(identifier),
    });
  }

  it.each([
    ['board', '/boards'],
    ['items', '/items?view=list'],
    ['tree', '/items?view=tree'],
    ['roadmap', '/roadmap'],
    ['plans', '/plans'],
    ['approvals', '/approvals'],
    ['runs', '/runs'],
  ])('%s → %s, with the project made active', async (view, member) => {
    const { fx, identifier } = await project();
    const owner = await asOwner(fx);
    const res = await enter(identifier, `/p/${identifier}/${view}`);
    expect(res.status).toBe(307);
    expect(
      new URL(res.headers.get('location')!).pathname + new URL(res.headers.get('location')!).search,
    ).toBe(member);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`workspace_id=${fx.workspaceId};`))).toBe(true);
    expect(cookies.some((c) => /^motir_visitor=;.*Max-Age=0/i.test(c))).toBe(true);
    const membership = await adminDb.workspaceMembership.findFirst({
      where: { userId: owner.id, workspaceId: fx.workspaceId },
    });
    expect(membership?.activeProjectId).toBe(fx.projectId);
  });

  it('items/<key> and plans/<id> keep their key', async () => {
    const { fx, identifier } = await project();
    await asOwner(fx);
    for (const [from, to] of [
      [`/p/${identifier}/items/${identifier}-3`, `/items/${identifier}-3`],
      [`/p/${identifier}/plans/cplan9`, '/plans/cplan9'],
    ] as const) {
      const res = await enter(identifier, from);
      expect(new URL(res.headers.get('location')!).pathname).toBe(to);
    }
  });

  it('anyone who cannot enter goes back to the Visitor view, with nothing set', async () => {
    const { identifier } = await project();
    await consented(identifier);
    const res = await enter(identifier, `/p/${identifier}/runs`);
    expect(new URL(res.headers.get('location')!).pathname).toBe(`/p/${identifier}/runs`);
    expect(res.headers.getSetCookie()).toEqual([]);

    state.session = null;
    const anon = await enter(identifier, 'https://evil.example/x');
    expect(new URL(anon.headers.get('location')!).pathname).toBe(`/p/${identifier}/board`);
    expect(new URL(anon.headers.get('location')!).host).not.toBe('evil.example');
  });
});
