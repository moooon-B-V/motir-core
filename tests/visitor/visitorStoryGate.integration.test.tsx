import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { db } from '@/lib/db';
import {
  ProjectAccessProvider,
  useProjectAccess,
} from '@/app/(authed)/_components/ProjectAccessProvider';
import type { ProjectContext } from '@/lib/projects';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { planSessionsService } from '@/lib/services/planSessionsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { visitorRecordsService } from '@/lib/services/visitorRecordsService';
import { VisitorConsentNotApplicableError } from '@/lib/visitor/errors';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import { truncateRateLimitCounters } from '@/tests/helpers/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { changedTables, snapshotRows } from './_rowSnapshot';
import { consent, emailsOf, storyGateFixture, type StoryGateFixture } from './_storyGateFixture';

// THE STORY'S INTEGRATION GATE (Story MOTIR-6170 · MOTIR-6650), for `motir-core`.
//
// Every card of the story promised something that must NOT happen, and proved
// it over its own surface. This file proves the promises over the ASSEMBLED
// system — the real resolver, the real routes, the real pages and the real
// Postgres — with ONE fixture (`_storyGateFixture.ts`) in which what a Visitor
// may see and what is true genuinely differ, and a reader at every step of
// admission:
//
//   R0  no session                        → sign_in, and no project data anywhere
//   R1  another organisation, no record   → consent, and no project data anywhere
//   R2  another organisation, consented   → visitor
//   R3  a Limited member not added, consented → visitor
//   M1  the Manager                        → enter — and the Visitor rule never
//   M2  a Full member                      → enter    reaches them
//
// Then the guards coverage cannot see: no other person's email reaches a Visitor
// on any page or data door, the Managers' Visitors list is the ONE surface that
// hands out another person's email (to M1 alone), the consent action writes only
// the visitor record, no MCP token can be minted into the project for a
// Visitor, and every Visitor page sits under a permission provider that grants
// no write. The write doors themselves are `visitorWriteDoorGuard.test.ts`
// (static) and `visitorWriteRefusal.integration.test.ts` (dynamic).

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Session = { user: { id: string; name: string; email: string } } | null;
const { state, redirect, notFound, permanentRedirect } = vi.hoisted(() => ({
  state: {
    session: null as { user: { id: string; name: string; email: string } } | null,
    path: null as string | null,
    cookie: null as string | null,
    active: null as unknown,
    ws: null as unknown,
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
vi.mock('@/lib/auth', () => ({
  getSession: async () => state.session,
  readSession: async () => state.session,
}));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => state.active }));
vi.mock('@/lib/workspaces', async (orig) => ({
  ...(await orig<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => state.ws,
}));
vi.mock('@/lib/auth/requireCompliantSession', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/requireCompliantSession')>()),
  refuseIfNonCompliant: async () => null,
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect,
  notFound,
  permanentRedirect,
}));
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers({
      ...(state.path ? { 'x-current-path': state.path } : {}),
      ...(state.cookie ? { cookie: state.cookie } : {}),
    }),
  cookies: async () => ({
    get: (name: string) => {
      const m = state.cookie?.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
      return m ? { name, value: decodeURIComponent(m[1]!) } : undefined;
    },
    getAll: () => [],
    has: () => false,
  }),
}));
// The item page starts its late reads as ONE promise and keeps awaiting other
// things before any section takes it; when it rejects in that window (defect ②
// below) Node calls it unhandled. Attach a no-op handler at birth — the promise
// itself, and its rejection reaching both sections, are unchanged.
vi.mock('@/app/(authed)/items/[key]/_components/lateReads', async (orig) => {
  const real = await orig<typeof import('@/app/(authed)/items/[key]/_components/lateReads')>();
  return {
    ...real,
    readLateSections: (...args: Parameters<typeof real.readLateSections>) => {
      const reads = real.readLateSections(...args);
      reads.catch(() => undefined);
      return reads;
    },
  };
});
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => {
    const t = (key: string) => key;
    t.rich = (key: string) => key;
    t.has = () => true;
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
beforeAll(() => {
  previousCloud = process.env['MOTIR_CLOUD'];
});
beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  process.env['MOTIR_CLOUD'] = 'true';
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'];
  Object.assign(state, { session: null, path: null, cookie: null, active: null, ws: null });
  redirect.mockClear();
  notFound.mockClear();
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
  __resetSharedRateLimitStoreForTest();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── readers ─────────────────────────────────────────────────────────────────

type Reader = 'R0' | 'R1' | 'R2' | 'R3' | 'M1' | 'M2';
const READERS: Reader[] = ['R0', 'R1', 'R2', 'R3', 'M1', 'M2'];
const VISITORS = ['R2', 'R3'] as const;

const sessionOf = (u: { id: string; name: string; email: string }): Session => ({
  user: { id: u.id, name: u.name, email: u.email },
});

function userOf(t: StoryGateFixture, who: Reader) {
  return (
    {
      R0: null,
      R1: t.people.r1,
      R2: t.people.r2,
      R3: t.people.r3,
      M1: t.people.m1,
      M2: t.people.m2,
    } as const
  )[who];
}

/**
 * Sign `who` in as the browser would present them on a Visitor view: their
 * session, their own workspace and active project (the app resolves those from
 * the session alone), and the `motir_visitor` cookie naming `cookieFor`.
 */
function as(t: StoryGateFixture, who: Reader, cookieFor: string | null = t.identifier) {
  const u = userOf(t, who);
  state.session = u ? sessionOf(u) : null;
  state.cookie = cookieFor ? `motir_visitor=${cookieFor}` : null;
  const own = (fx: StoryGateFixture['fx'] | StoryGateFixture['other'], userId: string) => {
    state.ws = { userId, workspaceId: fx.workspaceId } satisfies WorkspaceContext;
    state.active = {
      userId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      project: fx.project as unknown as ProjectContext['project'],
    } satisfies ProjectContext;
  };
  state.ws = null;
  state.active = null;
  if (who === 'R1' || who === 'R2') own(t.other, u!.id);
  if (who === 'M1' || who === 'M2') own(t.fx, u!.id);
  // R3 belongs to the workspace but can enter none of its projects: no active one.
  if (who === 'R3') state.ws = { userId: u!.id, workspaceId: t.fx.workspaceId };
}

// ── the data doors ──────────────────────────────────────────────────────────

const BASE = 'http://localhost:3000';
const routes = {
  board: () => import('@/app/api/board/route'),
  boards: () => import('@/app/api/boards/route'),
  sprints: () => import('@/app/api/sprints/route'),
  peek: () => import('@/app/api/work-items/peek/route'),
  comments: () => import('@/app/api/work-items/[id]/comments/route'),
  all: () => import('@/app/api/work-items/[id]/activity/all/route'),
  history: () => import('@/app/api/work-items/[id]/activity/history/route'),
  rollup: () => import('@/app/api/work-items/[id]/rollup/route'),
  roadmap: () => import('@/app/api/projects/[key]/roadmap/route'),
  run: () => import('@/app/api/dispatch-runs/[id]/route'),
  plan: () => import('@/app/api/plans/[id]/route'),
  visitors: () => import('@/app/api/projects/[key]/visitors/route'),
};

interface Door {
  name: string;
  call: () => Promise<{ status: number; body: string }>;
  /** The id or key the request itself names — a refusal may echo it back. */
  echo?: string;
}

async function answer(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text };
}

function req(path: string) {
  return new Request(`${BASE}${path}`, {
    headers: state.cookie ? { cookie: state.cookie } : {},
  });
}
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

/**
 * Every Visitor-served data door (MOTIR-6647's list), addressed at VISIBLE
 * resources of the fixture. The three item-tree server actions are doors too.
 */
function dataDoors(t: StoryGateFixture): Door[] {
  const { V1, E } = t.items;
  const get =
    (
      load: () => Promise<{ GET: (...a: never[]) => Promise<Response> }>,
      path: string,
      p?: Record<string, string>,
    ) =>
    async () => {
      const { GET } = await load();
      try {
        const res = p
          ? await (GET as (r: Request, c: unknown) => Promise<Response>)(req(path), params(p))
          : await (GET as (r: Request) => Promise<Response>)(req(path));
        return answer(res);
      } catch (err) {
        // A door that THROWS answers with Next's 500; the error's name is all of it
        // that reaches a browser.
        return { status: 500, body: (err as Error).name };
      }
    };
  const action =
    (run: (m: typeof import('@/app/(authed)/items/actions')) => Promise<unknown>) => async () => {
      const m = await import('@/app/(authed)/items/actions');
      try {
        const out = await run(m);
        const ok = (out as { ok?: boolean }).ok;
        return { status: ok ? 200 : 404, body: JSON.stringify(out) };
      } catch (err) {
        return { status: 401, body: String((err as Error).message) };
      }
    };
  return [
    { name: 'GET /api/board', call: get(routes.board, '/api/board') },
    { name: 'GET /api/boards', call: get(routes.boards, '/api/boards') },
    { name: 'GET /api/sprints', call: get(routes.sprints, '/api/sprints') },
    {
      name: 'GET /api/work-items/peek',
      echo: V1.identifier,
      call: get(routes.peek, `/api/work-items/peek?key=${V1.identifier}`),
    },
    {
      name: 'GET /api/work-items/[id]/comments',
      echo: V1.id,
      call: get(routes.comments, `/api/work-items/${V1.id}/comments`, { id: V1.id }),
    },
    {
      name: 'GET /api/work-items/[id]/activity/all',
      echo: V1.id,
      call: get(routes.all, `/api/work-items/${V1.id}/activity/all`, { id: V1.id }),
    },
    {
      name: 'GET /api/work-items/[id]/activity/history',
      echo: V1.id,
      call: get(routes.history, `/api/work-items/${V1.id}/activity/history`, { id: V1.id }),
    },
    {
      name: 'GET /api/work-items/[id]/rollup',
      echo: E.id,
      call: get(routes.rollup, `/api/work-items/${E.id}/rollup`, { id: E.id }),
    },
    {
      name: 'GET /api/projects/[key]/roadmap',
      echo: t.identifier,
      call: get(routes.roadmap, `/api/projects/${t.identifier}/roadmap`, { key: t.identifier }),
    },
    {
      name: 'GET /api/dispatch-runs/[id]',
      echo: t.runs.onV2,
      call: get(routes.run, `/api/dispatch-runs/${t.runs.onV2}`, { id: t.runs.onV2 }),
    },
    {
      name: 'GET /api/plans/[id]',
      echo: t.plans.P2.planId,
      call: get(routes.plan, `/api/plans/${t.plans.P2.planId}`, { id: t.plans.P2.planId }),
    },
    {
      name: 'action listRootIssuesAction',
      call: action((m) => m.listRootIssuesAction({ sortParam: '' })),
    },
    {
      name: 'action listChildIssuesAction(E)',
      echo: E.id,
      call: action((m) => m.listChildIssuesAction({ sortParam: '', parentId: E.id })),
    },
  ];
}

/** The same doors addressed at WITHHELD resources — each must be an unknown one. */
const unecho = (body: string, addressed: string) => body.split(addressed).join('<addressed>');

function withheldDoors(
  t: StoryGateFixture,
): Array<
  Door & { unknown: () => Promise<Door['call']>; addressed: string; unknownAddress: string }
> {
  const { C1 } = t.items;
  const byId = (
    name: string,
    load: () => Promise<{ GET: (...a: never[]) => Promise<Response> }>,
    id: string,
    unknownId: string,
  ) => {
    const call = (x: string) => async () => {
      const { GET } = await load();
      return answer(
        await (GET as (r: Request, c: unknown) => Promise<Response>)(req('/x'), params({ id: x })),
      );
    };
    return {
      name,
      call: call(id),
      unknown: async () => call(unknownId),
      addressed: id,
      unknownAddress: unknownId,
    };
  };
  return [
    byId('comments on C1', routes.comments, C1.id, 'cm-not-an-item'),
    byId('history of C1', routes.history, C1.id, 'cm-not-an-item'),
    byId('run on C1', routes.run, t.runs.onC1, 'cm-not-a-run'),
    byId('plan P1', routes.plan, t.plans.P1.planId, 'cm-not-a-plan'),
    {
      name: 'peek C1',
      addressed: C1.identifier,
      unknownAddress: `${t.identifier}-9999`,
      call: async () => {
        const { GET } = await routes.peek();
        return answer(await GET(req(`/api/work-items/peek?key=${C1.identifier}`)));
      },
      unknown: async () => async () => {
        const { GET } = await routes.peek();
        return answer(await GET(req(`/api/work-items/peek?key=${t.identifier}-9999`)));
      },
    },
  ];
}

// ── the nine Visitor pages ──────────────────────────────────────────────────

type PageModule = { default: (p: never) => Promise<ReactNode> };
function visitorPages(t: StoryGateFixture) {
  const q = () => Promise.resolve({});
  const id = t.identifier;
  const p = (extra: Record<string, string> = {}) => Promise.resolve({ identifier: id, ...extra });
  return [
    [
      'board',
      () => import('@/app/(visitor)/p/[identifier]/board/page'),
      { params: p(), searchParams: q() },
    ],
    [
      'items',
      () => import('@/app/(visitor)/p/[identifier]/items/page'),
      { params: p(), searchParams: q() },
    ],
    [
      'tree',
      () => import('@/app/(visitor)/p/[identifier]/tree/page'),
      { params: p(), searchParams: q() },
    ],
    [
      'roadmap',
      () => import('@/app/(visitor)/p/[identifier]/roadmap/page'),
      { params: p(), searchParams: q() },
    ],
    [
      `items/${t.items.V1.identifier}`,
      () => import('@/app/(visitor)/p/[identifier]/items/[key]/page'),
      { params: p({ key: t.items.V1.identifier }), searchParams: q() },
    ],
    [
      'plans',
      () => import('@/app/(visitor)/p/[identifier]/plans/page'),
      { params: p(), searchParams: q() },
    ],
    [
      `plans/${t.plans.P2.planId}`,
      () => import('@/app/(visitor)/p/[identifier]/plans/[id]/page'),
      { params: p({ id: t.plans.P2.planId }) },
    ],
    [
      'approvals',
      () => import('@/app/(visitor)/p/[identifier]/approvals/page'),
      { params: p(), searchParams: q() },
    ],
    [
      'runs',
      () => import('@/app/(visitor)/p/[identifier]/runs/page'),
      { params: p(), searchParams: q() },
    ],
  ] as Array<[string, () => Promise<PageModule>, Record<string, unknown>]>;
}

async function layout(identifier: string, children: ReactNode = createElement('main')) {
  const { default: VisitorLayout } = await import('@/app/(visitor)/p/[identifier]/layout');
  return VisitorLayout({ children, params: Promise.resolve({ identifier }) });
}

/**
 * A page's element tree with every ASYNC server component under it run, every
 * promise prop awaited, and functions dropped — i.e. what actually reaches the
 * browser: the server-rendered data and every client component's props.
 */
async function expand(node: unknown, errors: string[], depth = 0): Promise<unknown> {
  if (depth > 60 || node === null || node === undefined) return null;
  if (typeof node === 'function' || typeof node === 'symbol') return null;
  if (typeof node !== 'object') return node;
  if (node instanceof Promise) {
    try {
      return await expand(await node, errors, depth + 1);
    } catch (err) {
      errors.push(String((err as Error).message).slice(0, 120));
      return null;
    }
  }
  if (node instanceof Date) return node.toISOString();
  if (node instanceof Map) return expand([...node.entries()], errors, depth + 1);
  if (node instanceof Set) return expand([...node], errors, depth + 1);
  if (Array.isArray(node)) return Promise.all(node.map((n) => expand(n, errors, depth + 1)));
  if (isValidElement(node)) {
    const el = node as ReactElement<Record<string, unknown>>;
    const type = el.type as unknown;
    if (typeof type === 'function' && type.constructor.name === 'AsyncFunction') {
      try {
        const out = await (type as (p: unknown) => Promise<unknown>)(el.props);
        defuse(out);
        return {
          server: (type as { name: string }).name,
          out: await expand(out, errors, depth + 1),
        };
      } catch (err) {
        errors.push(
          `${(type as { name: string }).name}: ${String((err as Error).message).slice(0, 120)}`,
        );
        return null;
      }
    }
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(el.props ?? {}))
      props[k] = await expand(v, errors, depth + 1);
    const name =
      typeof type === 'string'
        ? type
        : ((type as { displayName?: string; name?: string })?.displayName ??
          (type as { name?: string })?.name ??
          'element');
    return { el: name, props };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = await expand(v, errors, depth + 1);
  }
  return out;
}

/**
 * Attach a handler to every promise prop in the tree NOW, synchronously. The
 * item page hands its late sections one shared promise; if it rejects while the
 * walk is still awaiting an earlier section, Node would report it unhandled even
 * though `expand` handles it a moment later.
 */
function defuse(node: unknown, seen = new WeakSet<object>()): void {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (node instanceof Promise) {
    node.catch(() => undefined);
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) defuse(n, seen);
    return;
  }
  if (isValidElement(node)) {
    defuse((node as ReactElement<Record<string, unknown>>).props, seen);
    return;
  }
  if (Object.getPrototypeOf(node) === Object.prototype) {
    for (const v of Object.values(node as Record<string, unknown>)) defuse(v, seen);
  }
}

async function renderPage(
  load: () => Promise<PageModule>,
  props: Record<string, unknown>,
): Promise<{ text: string; tree: ReactNode; errors: string[] }> {
  const { default: Page } = await load();
  const tree = await Page(props as never);
  defuse(tree);
  const errors: string[] = [];
  const text = JSON.stringify(await expand(tree, errors));
  return { text, tree, errors };
}

const elements = (node: ReactNode, out: ReactElement[] = []): ReactElement[] => {
  if (Array.isArray(node)) for (const c of node) elements(c, out);
  else if (isValidElement(node)) {
    out.push(node);
    for (const v of Object.values(node.props as Record<string, unknown>)) {
      if (isValidElement(v) || Array.isArray(v)) elements(v as ReactNode, out);
    }
  }
  return out;
};
const named = (tree: ReactNode, name: string) =>
  elements(tree).filter((e) => {
    const type = e.type as { name?: string; displayName?: string } | string;
    return typeof type !== 'string' && (type.displayName ?? type.name) === name;
  });

// ── assertions ──────────────────────────────────────────────────────────────

/**
 * DEFECTS THIS GATE FOUND in the assembled story, each reproduced here and
 * reported for filing rather than fixed by a test card (MOTIR-6650's scope says a
 * failing guard is a defect for the card that owns the surface). Asserted TIGHT,
 * both ways: a finding not listed fails, and a listed one that stops reproducing
 * fails — so the list only shrinks, and a fix must delete its entry.
 */
const KNOWN_DEFECTS: Record<'doors' | 'withheld' | 'pages', string[]> = {
  // ① (fixed by MOTIR-6733 — a non-entrant holds no key on the member path, so R3's
  // member read is not-found and `memberThenVisitor` serves the Visitor read, with
  // the hidden set): no door or withheld finding is known.
  doors: [],
  withheld: [],
  // ② (fixed in the parent run, 9262567f3 — the story page's eligibility read
  // is skipped for a Visitor): no page finding is known.
  pages: [],
};
const knownFindings = (k: keyof typeof KNOWN_DEFECTS) => [...KNOWN_DEFECTS[k]].sort();

/** Which withheld things — named by what they are, not by their volatile ids — a text carries. */
function withheldIn(t: StoryGateFixture, text: string): string[] {
  const { C1, C2, G } = t.items;
  const named: Array<[string, string[]]> = [
    ['C1', [C1.id, C1.identifier, C1.title]],
    ['C2', [C2.id, C2.identifier, C2.title]],
    ['G', [G.id, G.identifier, G.title]],
    ['plan P1', [t.plans.P1.planId, t.plans.P1.sessionId, 'Reshape the hush pricing']],
    ['approval on C1', [t.gates.onC1]],
    ['run on C1', [t.runs.onC1]],
  ];
  return named.filter(([, needles]) => needles.some((n) => text.includes(n))).map(([k]) => k);
}

function expectNoProjectData(t: StoryGateFixture, where: string, raw: string, echo?: string) {
  const text = echo ? raw.split(echo).join('<addressed>') : raw;
  for (const w of [...t.visible, ...t.hidden]) {
    expect(text.includes(w.id), `${where} carries ${w.identifier}'s id`).toBe(false);
    expect(text.includes(w.title), `${where} carries "${w.title}"`).toBe(false);
  }
}

/** No email — nor its local part — of any fixture person other than the reader. */
function expectNoOtherEmail(t: StoryGateFixture, readerId: string, where: string, text: string) {
  const lower = text.toLowerCase();
  for (const e of emailsOf(t)) {
    if (e.id === readerId) continue;
    expect(lower.includes(e.email.toLowerCase()), `${where} carries ${e.email}`).toBe(false);
    expect(lower.includes(e.local.toLowerCase()), `${where} carries ${e.local}@…`).toBe(false);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 1. THE ADMISSION
// ════════════════════════════════════════════════════════════════════════════

describe('the admission seam', () => {
  it('R0 → sign_in, R1 → consent, R2/R3 → consent then visitor, M1/M2 → enter', async () => {
    const t = await storyGateFixture();
    const verdict = (who: Reader) => {
      const u = userOf(t, who);
      return projectAccessService.resolveVisitor(t.identifier, u ? { user: { id: u.id } } : null);
    };
    expect(await verdict('R0')).toEqual({ kind: 'sign_in', identifier: t.identifier });
    for (const who of ['R1', 'R2', 'R3'] as const) {
      expect((await verdict(who)).kind, who).toBe('consent');
    }
    await consent(t);
    expect((await verdict('R1')).kind).toBe('consent');
    for (const who of VISITORS) {
      const v = await verdict(who);
      expect(v.kind, who).toBe('visitor');
      if (v.kind === 'visitor') {
        expect([...v.ctx.hiddenIds].sort()).toEqual(t.hidden.map((w) => w.id).sort());
      }
    }
    for (const who of ['M1', 'M2'] as const) expect((await verdict(who)).kind, who).toBe('enter');

    // A Manager's consent is refused, and nothing is written.
    const before = await adminDb.projectVisitor.count({ where: { projectId: t.fx.projectId } });
    await expect(
      visitorRecordsService.recordConsent({ identifier: t.identifier, userId: t.people.m1.id }),
    ).rejects.toBeInstanceOf(VisitorConsentNotApplicableError);
    expect(await adminDb.projectVisitor.count({ where: { projectId: t.fx.projectId } })).toBe(
      before,
    );
  });

  it('no project data reaches R0 or R1 through any data door — each answers as it does with no cookie', async () => {
    const t = await storyGateFixture();
    await consent(t);
    for (const who of ['R0', 'R1'] as const) {
      for (const door of dataDoors(t)) {
        as(t, who);
        const withCookie = await door.call();
        as(t, who, null);
        const without = await door.call();
        expect(withCookie.status, `${who} ${door.name}`).toBe(without.status);
        expectNoProjectData(t, `${who} ${door.name}`, withCookie.body, door.echo);
        expectNoOtherEmail(t, userOf(t, who)?.id ?? '', `${who} ${door.name}`, withCookie.body);
      }
    }
  });

  it('every Visitor page sends R0 to sign in and R1 to the consent screen, rendering nothing', async () => {
    const t = await storyGateFixture();
    for (const [view, load, props] of visitorPages(t)) {
      state.path = `/p/${t.identifier}/${view}`;
      as(t, 'R0');
      await expect(renderPage(load, props), `R0 ${view}`).rejects.toThrow(
        'NEXT_REDIRECT:/sign-in?next=',
      );
      as(t, 'R1');
      await expect(renderPage(load, props), `R1 ${view}`).rejects.toThrow(
        `NEXT_REDIRECT:/p/${t.identifier}/consent?next=`,
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE READS
// ════════════════════════════════════════════════════════════════════════════

describe('the read seams, as R2 and R3', () => {
  it('every data door serves the project with every withheld row, key, title and record absent', async () => {
    const t = await storyGateFixture();
    await consent(t);
    const findings: string[] = [];
    for (const who of VISITORS) {
      for (const door of dataDoors(t)) {
        as(t, who);
        const res = await door.call();
        expect(res.status, `${who} ${door.name}`).toBe(200);
        for (const w of withheldIn(t, res.body)) findings.push(`${who} ${door.name} → ${w}`);
      }
      // The board and the tree carry the private epic, marked, with no count.
      as(t, who);
      const { GET: boardGET } = await routes.board();
      const board = (await (await boardGET(req('/api/board'))).json()) as {
        columns: { cards: { id: string; childrenHidden?: boolean }[] }[];
      };
      const cards = board.columns.flatMap((c) => c.cards);
      expect(cards.find((c) => c.id === t.items.E.id)?.childrenHidden, who).toBe(true);
      expect(cards.map((c) => c.id)).toEqual(
        expect.arrayContaining([t.items.V1.id, t.items.V2.id]),
      );

      const { listRootIssuesAction } = await import('@/app/(authed)/items/actions');
      const root = await listRootIssuesAction({ sortParam: '' });
      expect(root.ok).toBe(true);
      if (root.ok) {
        const epic = root.level.rows.find((r) => r.id === t.items.E.id) as
          | { childrenHidden?: boolean; hasChildren?: boolean; childCount?: number }
          | undefined;
        expect(epic?.childrenHidden, who).toBe(true);
        expect(epic?.hasChildren ?? false, who).toBe(false);
        expect(epic?.childCount ?? 0, who).toBe(0);
      }
    }
    expect(findings.sort()).toEqual(knownFindings('doors'));
  });

  it('every withheld resource addressed directly is exactly an unknown one', async () => {
    const t = await storyGateFixture();
    await consent(t);
    const findings: string[] = [];
    for (const who of VISITORS) {
      for (const door of withheldDoors(t)) {
        as(t, who);
        const hidden = await door.call();
        const unknown = await (await door.unknown())();
        // A not-found body echoes the id the READER sent — the only difference
        // allowed between the two answers.
        if (
          hidden.status !== 404 ||
          unecho(hidden.body, door.addressed) !== unecho(unknown.body, door.unknownAddress)
        ) {
          findings.push(`${who} ${door.name} → ${hidden.status}`);
        }
      }
    }
    expect(findings.sort()).toEqual(knownFindings('withheld'));
  });

  it('the rooms list and count only what touches visible work', async () => {
    const t = await storyGateFixture();
    await consent(t);
    for (const who of VISITORS) {
      const u = userOf(t, who)!;
      const v = await projectAccessService.resolveVisitor(t.identifier, { user: { id: u.id } });
      const ctx = (v as { ctx: VisitorReadContext }).ctx;
      const sessions = await planSessionsService.listSessions(t.fx.projectId, ctx);
      expect(
        sessions.sessions.map((s) => s.id),
        who,
      ).toEqual([t.plans.P2.sessionId]);
      const counts = await planSessionsService.countSessionsByPlanState(t.fx.projectId, ctx);
      expect(
        Object.values(counts).reduce((a, b) => a + b, 0),
        who,
      ).toBe(1);
      const records = await approvalGatesService.listRecords(ctx, { view: 'project' });
      expect(
        records.sections.awaiting.items.map((r) => r.gateId),
        who,
      ).toEqual([t.gates.onV2]);
      expect(records.total, who).toBe(1);
      const runs = await dispatchRunService.listRunsForProject(t.identifier, { take: 20 }, ctx);
      expect(
        runs.runs.map((r) => r.id),
        who,
      ).toEqual([t.runs.onV2]);
    }
  });

  it('every one of the nine Visitor pages renders with no withheld string anywhere in it', async () => {
    const t = await storyGateFixture();
    await consent(t);
    const findings: string[] = [];
    for (const who of VISITORS) {
      for (const [view, load, props] of visitorPages(t)) {
        as(t, who);
        state.path = `/p/${t.identifier}/${view}`;
        const page = await renderPage(load, props);
        expect(page.text.length, `${who} ${view} rendered`).toBeGreaterThan(200);
        const label = view
          .replace(t.items.V1.identifier, '[key]')
          .replace(t.plans.P2.planId, '[id]');
        for (const w of withheldIn(t, page.text)) findings.push(`${who} page ${label} → ${w}`);
        for (const e of page.errors) {
          findings.push(`${who} page ${label} ✗ ${e.replace(/\bc[a-z0-9]{24}\b/g, '<id>')}`);
        }
      }
    }
    expect([...new Set(findings)].sort()).toEqual(knownFindings('pages'));
  });
});

describe('the same entrances as M1 and M2 still return the hidden rows', () => {
  it('the Visitor rule did not leak onto members', async () => {
    const t = await storyGateFixture();
    await consent(t);
    for (const who of ['M1', 'M2'] as const) {
      as(t, who);
      const { GET: boardGET } = await routes.board();
      const board = await (await boardGET(req('/api/board'))).text();
      for (const h of t.hidden) expect(board, `${who} board has ${h.identifier}`).toContain(h.id);
      expect(board).not.toContain('childrenHidden');

      for (const door of withheldDoors(t)) {
        as(t, who);
        expect((await door.call()).status, `${who} ${door.name}`).toBe(200);
      }
      // The roadmap's root level: the epic still counts its three descendants.
      const { GET: roadmapGET } = await routes.roadmap();
      const roadmap = (await (
        await roadmapGET(
          req(`/api/projects/${t.identifier}/roadmap`),
          params({ key: t.identifier }),
        )
      ).json()) as {
        nodes: { id: string; hasChildren: boolean; progress: { total: number } | null }[];
      };
      const epic = roadmap.nodes.find((n) => n.id === t.items.E.id)!;
      expect(epic.hasChildren, who).toBe(true);
      expect(epic.progress?.total, who).toBe(3);
    }
  });
});

describe('a project that is not Public', () => {
  it('answers every reader, R0 included, the not-found it answers for an unknown identifier', async () => {
    const t = await storyGateFixture();
    await consent(t);
    for (const mode of ['workspace', 'members'] as const) {
      await adminDb.project.update({
        where: { id: t.fx.projectId },
        data: { accessMode: mode, accessLevel: mode === 'workspace' ? 'open' : 'private' },
      });
      for (const who of READERS) {
        const u = userOf(t, who);
        const session = u ? { user: { id: u.id } } : null;
        expect(
          await projectAccessService.resolveVisitor(t.identifier, session),
          `${mode} ${who}`,
        ).toEqual(await projectAccessService.resolveVisitor('NOSUCH404', session));
        as(t, who);
        state.path = `/p/${t.identifier}/board`;
        redirect.mockClear();
        await expect(layout(t.identifier), `${mode} ${who} layout`).rejects.toThrow(
          'NEXT_NOT_FOUND',
        );
        // Never a sign-in or consent redirect — that would confirm the key exists.
        expect(redirect, `${mode} ${who} layout`).not.toHaveBeenCalled();
        for (const door of dataDoors(t)) {
          as(t, who);
          const named = await door.call();
          as(t, who, 'NOSUCH404');
          const unknown = await door.call();
          expect(named, `${mode} ${who} ${door.name}`).toEqual(unknown);
        }
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. THE RECORD
// ════════════════════════════════════════════════════════════════════════════

describe('the record seam', () => {
  it('a read touches the latest visit; M1 lists R2 and R3 with emails; M2 is refused; deleting R2 removes the record', async () => {
    const t = await storyGateFixture();
    await consent(t);
    const stale = new Date(Date.now() - 30 * 60_000);
    await adminDb.projectVisitor.updateMany({
      where: { projectId: t.fx.projectId },
      data: { lastVisitAt: stale, firstVisitAt: stale, consentedAt: stale },
    });
    as(t, 'R2');
    const { GET: boardGET } = await routes.board();
    expect((await boardGET(req('/api/board'))).status).toBe(200);
    const r2 = await adminDb.projectVisitor.findFirstOrThrow({
      where: { projectId: t.fx.projectId, userId: t.people.r2.id },
    });
    expect(r2.lastVisitAt.getTime()).toBeGreaterThan(stale.getTime());

    const page = await visitorRecordsService.listForManagers({ key: t.identifier, ctx: t.fx.ctx });
    expect(page.visitors.map((v) => v.email).sort()).toEqual(
      [t.people.r2.email, t.people.r3.email].sort(),
    );
    await expect(
      visitorRecordsService.listForManagers({
        key: t.identifier,
        ctx: { userId: t.people.m2.id, workspaceId: t.fx.workspaceId },
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await adminDb.user.delete({ where: { id: t.people.r2.id } });
    expect(
      await adminDb.projectVisitor.count({
        where: { projectId: t.fx.projectId, userId: t.people.r2.id },
      }),
    ).toBe(0);
    expect(await adminDb.projectVisitor.count({ where: { projectId: t.fx.projectId } })).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. THE GUARDS
// ════════════════════════════════════════════════════════════════════════════

describe('the no-email guard', () => {
  it('no page and no data door hands R2 or R3 anyone else’s email; the Managers’ list is the one surface that does, to M1 alone', async () => {
    const t = await storyGateFixture();
    await consent(t);
    const scanned: string[] = [];
    for (const who of VISITORS) {
      const me = userOf(t, who)!.id;
      for (const door of dataDoors(t)) {
        as(t, who);
        expectNoOtherEmail(t, me, `${who} ${door.name}`, (await door.call()).body);
        scanned.push(door.name);
      }
      for (const [view, load, props] of visitorPages(t)) {
        as(t, who);
        state.path = `/p/${t.identifier}/${view}`;
        const page = await renderPage(load, props);
        expectNoOtherEmail(t, me, `${who} page ${view}`, page.text);
        scanned.push(
          `page /p/<id>/${view.replace(t.items.V1.identifier, '[key]').replace(t.plans.P2.planId, '[id]')}`,
        );
      }
      // The Visitor chrome itself (banner, bar, rail, account menu).
      as(t, who);
      state.path = `/p/${t.identifier}/board`;
      const errors: string[] = [];
      const chrome = JSON.stringify(await expand(await layout(t.identifier), errors));
      expectNoOtherEmail(t, me, `${who} layout`, chrome);
      scanned.push('layout /p/<id>');
    }

    // The ONE email-bearing surface, and who reaches it.
    const { GET } = await routes.visitors();
    const visitorsRoute = async (who: Reader) => {
      as(t, who);
      return answer(
        await GET(
          new Request(`${BASE}/api/projects/${t.identifier}/visitors`),
          params({ key: t.identifier }),
        ),
      );
    };
    const m1 = await visitorsRoute('M1');
    expect(m1.status).toBe(200);
    expect(m1.body).toContain(t.people.r2.email);
    expect(m1.body).toContain(t.people.r3.email);
    for (const who of ['M2', 'R0', 'R1', 'R2', 'R3'] as const) {
      const res = await visitorsRoute(who);
      expect([401, 403, 404], `${who} visitors list`).toContain(res.status);
      for (const e of emailsOf(t)) expect(res.body, `${who} visitors list`).not.toContain(e.email);
    }
    scanned.push('GET /api/projects/[key]/visitors (the Managers’ list — M1 only)');
    // The surfaces scanned, named — so the guard's reach is on the record.
    expect([...new Set(scanned)]).toEqual([
      ...dataDoors(t).map((d) => d.name),
      ...[
        'board',
        'items',
        'tree',
        'roadmap',
        'items/[key]',
        'plans',
        'plans/[id]',
        'approvals',
        'runs',
      ].map((v) => `page /p/<id>/${v}`),
      'layout /p/<id>',
      'GET /api/projects/[key]/visitors (the Managers’ list — M1 only)',
    ]);
  });
});

describe('the consent action writes only the visitor record', () => {
  it('Continue changes project_visitor and no other table', async () => {
    const t = await storyGateFixture();
    as(t, 'R1');
    const { recordVisitorConsentAction } =
      await import('@/app/(auth)/p/[identifier]/consent/_actions');
    const before = await snapshotRows();
    expect(await recordVisitorConsentAction(t.identifier)).toEqual({ ok: true });
    const after = await snapshotRows();
    expect(changedTables(before, after)).toEqual(['project_visitor']);

    // A member pressing it writes nothing at all.
    as(t, 'M2');
    const b2 = await snapshotRows();
    expect(await recordVisitorConsentAction(t.identifier)).toEqual({ ok: false, reason: 'member' });
    expect(changedTables(b2, await snapshotRows())).toEqual([]);
  });
});

describe('the MCP guard', () => {
  it('no token can be minted into the project’s workspace for a Visitor', async () => {
    const t = await storyGateFixture();
    await consent(t);
    for (const who of ['R1', 'R2'] as const) {
      const u = userOf(t, who)!;
      const before = await snapshotRows();
      await expect(
        apiTokensService.create(u.id, t.fx.workspaceId, {
          label: 'mine',
          projectId: t.fx.projectId,
          permissions: ['plan:create'],
        } as never),
      ).rejects.toThrow();
      expect(changedTables(before, await snapshotRows()), who).toEqual([]);
    }
  });
});

describe('the provider guard', () => {
  function Probe(): ReactNode {
    const access = useProjectAccess();
    return createElement(
      'output',
      null,
      `edit=${access.can('work_item:edit')} archive=${access.can('work_item:archive')} browse=${access.can('project:browse')}`,
    );
  }

  it('every Visitor page sits under a provider whose can(work_item:edit) is false', async () => {
    const t = await storyGateFixture();
    await consent(t);
    for (const [view, load, props] of visitorPages(t)) {
      as(t, 'R2');
      state.path = `/p/${t.identifier}/${view}`;
      const tree = await layout(t.identifier, createElement('main'));
      const [provider] = named(tree, 'ProjectAccessProvider');
      expect(provider, `${view}: the provider is mounted`).toBeDefined();
      const permissions = (provider!.props as { permissions: PermissionKey[] }).permissions;
      const html = renderToStaticMarkup(
        <ProjectAccessProvider permissions={permissions}>
          <Probe />
        </ProjectAccessProvider>,
      );
      expect(html, view).toContain('edit=false archive=false browse=true');
      // …and the page under it mounts no provider of its own that grants more.
      const { tree: pageTree } = await renderPage(load, props);
      for (const inner of named(pageTree, 'ProjectAccessProvider')) {
        expect((inner.props as { permissions: string[] }).permissions, view).not.toContain(
          'work_item:edit',
        );
      }
    }
  });
});
