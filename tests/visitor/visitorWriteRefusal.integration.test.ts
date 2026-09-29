import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import { truncateRateLimitCounters } from '@/tests/helpers/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { VISITOR_ADDRESS_HEADER } from '@/lib/visitor/address';
import { changedTables, snapshotRows } from './_rowSnapshot';
import { consent, storyGateFixture, type StoryGateFixture } from './_storyGateFixture';

// THE WRITE-DOOR GUARD, dynamic half (Story MOTIR-6170 · MOTIR-6650).
//
// `visitorWriteDoorGuard.test.ts` proves, from source, that no write door
// reaches a Visitor entrance. This file DRIVES them: every mutating handler in
// the families a Visitor view can reach, and every server action of the pages
// it renders, called as each reader short of admission — R0 no session, R1
// another organisation with no record, R2 another organisation consented, R3 a
// Limited member of the workspace not added to the project, consented — each
// carrying a `motir_visitor` cookie naming the fixture's public project. Each
// must refuse (401 / 403 / 404 for a route; a throw, a redirect or a not-ok
// result for an action), and a before/after picture of every table
// (`_rowSnapshot.ts`) — scoped to the project's workspace wherever a table
// carries one, so R1 and R2 writing in their OWN organisation (a sprint in their
// own active project) is not mistaken for a write into this one — must be
// unchanged.
//
// The ids each handler is addressed with are REAL rows of the fixture (the
// visible item V1, plan P2, the approval on V2, a sprint, a label …), so a door
// that failed to refuse would land its write on something, and the snapshot
// would see it.
//
// The families (the card's list): app/api/{work-items, board, boards, plans,
// approval-gates, dispatch-runs, attachments, upload, sprints}/** and the
// `'use server'` files under app/(authed)/{items, boards, plans, approvals, runs}.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });

const { state } = vi.hoisted(() => ({
  state: {
    session: null as { user: { id: string; name: string; email: string } } | null,
    cookie: null as string | null,
    address: null as string | null,
  },
}));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  getSession: async () => state.session,
  readSession: async () => state.session,
}));
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers(
      // The Visitor address header — spelled out, since a mock factory is hoisted above the imports.
      state.cookie ? { cookie: state.cookie, 'x-motir-visitor': state.address! } : {},
    ),
  cookies: async () => ({
    get: (name: string) => {
      const m = state.cookie?.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
      return m ? { name, value: decodeURIComponent(m[1]!) } : undefined;
    },
    getAll: () => [],
    has: () => false,
    set: () => undefined,
    delete: () => undefined,
  }),
}));
vi.mock('next/cache', () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
  unstable_cache: <T>(fn: T) => fn,
}));
vi.mock('next-intl/server', async (orig) => ({
  ...(await orig<typeof import('next-intl/server')>()),
  getTranslations: async () => {
    const t = (key: string) => key;
    t.rich = (key: string) => key;
    t.has = () => true;
    return t;
  },
  getLocale: async () => 'en',
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const ROOT = resolve(__dirname, '..', '..');
const ROUTE_FAMILIES = [
  'work-items',
  'board',
  'boards',
  'plans',
  'approval-gates',
  'dispatch-runs',
  'attachments',
  'upload',
  'sprints',
].map((d) => join(ROOT, 'app', 'api', d));
const ACTION_DIRS = ['items', 'boards', 'plans', 'approvals', 'runs'].map((d) =>
  join(ROOT, 'app', '(authed)', d),
);
const MUTATING = ['POST', 'PATCH', 'PUT', 'DELETE'] as const;
type Reader = 'R0' | 'R1' | 'R2' | 'R3';
const READERS: Reader[] = ['R0', 'R1', 'R2', 'R3'];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = join(dir, e);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}
const rel = (abs: string) => relative(ROOT, abs).split(sep).join('/');

const routeFiles = ROUTE_FAMILIES.flatMap((d) => walk(d)).filter((f) => f.endsWith('/route.ts'));
const actionFiles = ACTION_DIRS.flatMap((d) => walk(d))
  .filter((f) => /\.tsx?$/.test(f))
  .filter((f) => /^['"]use server['"]/.test(readFileSync(f, 'utf8')));

let t: StoryGateFixture;

beforeAll(async () => {
  process.env['MOTIR_CLOUD'] = 'true';
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  t = await storyGateFixture();
  await consent(t);
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function as(who: Reader) {
  const u = { R0: null, R1: t.people.r1, R2: t.people.r2, R3: t.people.r3 }[who];
  state.session = u ? { user: { id: u.id, name: u.name, email: u.email } } : null;
  state.cookie = `motir_visitor=${t.identifier}`;
  state.address = t.identifier;
}

/** A real fixture row for each dynamic segment the families use. */
function segmentValue(route: string, segment: string): string {
  const rows = t.rows;
  const byFamily: Record<string, string | null> = {
    'work-items': t.items.V1.id,
    boards: rows.boardId,
    plans: t.plans.P2.planId,
    'approval-gates': t.gates.onV2,
    attachments: rows.attachmentId,
    sprints: rows.sprintId,
    'dispatch-runs': t.runs.onV2,
  };
  const named: Record<string, string | null> = {
    itemId: t.plans.P2.itemId,
    labelId: rows.labelId,
    componentId: rows.componentId,
    userId: t.people.m2.id,
    columnId: rows.columnId,
    statusId: rows.statusId,
    pullRequestId: 'cm-no-such-pull-request',
  };
  if (segment === 'id') {
    const family = route.split('/')[2]!;
    return byFamily[family] ?? 'cm-unaddressed';
  }
  return named[segment] ?? 'cm-unaddressed';
}

/** A body shaped like every family's writes, naming real rows, so a leak would land. */
function probeBody() {
  const { V1, V2 } = t.items;
  return {
    id: V1.id,
    workItemId: V1.id,
    issueId: V1.id,
    itemId: V1.id,
    itemIds: [V1.id, V2.id],
    workItemIds: [V1.id, V2.id],
    ids: [V1.id],
    key: V1.identifier,
    parentId: V2.id,
    targetId: V2.id,
    fromId: V1.id,
    toId: V2.id,
    projectId: t.fx.projectId,
    sprintId: t.rows.sprintId,
    labelId: t.rows.labelId,
    componentId: t.rows.componentId,
    columnId: t.rows.columnId,
    toColumnId: t.rows.columnId,
    statusId: t.rows.statusId,
    status: 'done',
    userId: t.people.r2.id,
    gateId: t.gates.onV2,
    planId: t.plans.P2.planId,
    decision: 'approve',
    verdict: 'approved',
    title: 'Visitor was here',
    name: 'Visitor was here',
    bodyMd: 'Visitor was here',
    body: 'Visitor was here',
    text: 'Visitor was here',
    note: 'Visitor was here',
    reason: 'Visitor was here',
    kind: 'task',
    estimate: 3,
    storyPoints: 3,
    minutes: 30,
    private: false,
    hidden: false,
    watch: true,
    labels: ['launch'],
    components: ['Web'],
    beforeId: null,
    afterId: null,
    goal: 'Visitor was here',
  };
}

const REFUSED_STATUS = new Set([401, 403, 404]);
/**
 * Refused on the BODY: the probe's one generic body does not match the route's
 * schema, and the route validates it after authenticating the caller but before
 * asking the project whether they may act. Still a refusal — and the snapshot
 * proves nothing moved — but it is not proof the ACTOR check would have held
 * for a well-formed body; that half is `visitorWriteDoorGuard.test.ts`'s (no
 * write door reaches a Visitor entrance, so the actor check a write door runs
 * is the member check a Visitor never passes).
 */
const BODY_REFUSED = new Set([400, 409, 422]);

describe('every write route in the Visitor-reachable families refuses R0–R3 and changes no row', () => {
  it('drives each handler as each reader', async () => {
    const findings: string[] = [];
    const moved: string[] = [];
    let calls = 0;
    let onBody = 0;
    for (const file of routeFiles) {
      const route =
        '/' +
        rel(file)
          .replace(/^app\//, '')
          .replace(/\/route\.ts$/, '');
      const mod = (await import(file)) as Record<string, unknown>;
      for (const method of MUTATING) {
        const handler = mod[method] as
          | ((req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>)
          | undefined;
        if (typeof handler !== 'function') continue;
        const segments = [...route.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!);
        const params = Object.fromEntries(segments.map((s) => [s, segmentValue(route, s)]));
        const path = route.replace(/\[([^\]]+)\]/g, (_, s: string) => params[s]!);
        for (const who of READERS) {
          as(who);
          const before = await snapshotRows(t.fx.workspaceId);
          let status: number;
          try {
            const res = await handler(
              new Request(`http://localhost:3000${path}`, {
                method,
                headers: {
                  cookie: state.cookie!,
                  [VISITOR_ADDRESS_HEADER]: state.address!,
                  'content-type': 'application/json',
                },
                body: JSON.stringify(probeBody()),
              }),
              { params: Promise.resolve(params) },
            );
            status = res.status;
          } catch (err) {
            // A thrown error is Next's 500 — not a refusal the route owns, but
            // it wrote nothing if the snapshot agrees.
            status = /NEXT_REDIRECT/.test(String(err)) ? 307 : 500;
          }
          calls += 1;
          const changed = changedTables(before, await snapshotRows(t.fx.workspaceId));
          if (changed.length) moved.push(`${who} ${method} ${route} → ${changed.join(', ')}`);
          if (BODY_REFUSED.has(status)) onBody += 1;
          else if (!REFUSED_STATUS.has(status))
            findings.push(`${who} ${method} ${route} → ${status}`);
        }
      }
    }
    // The population it drove, as floors: a walk that silently found nothing fails.
    expect(routeFiles.length).toBeGreaterThanOrEqual(60);
    expect(calls).toBeGreaterThanOrEqual(200);
    expect(onBody).toBeLessThan(calls);
    expect({ moved: moved.sort(), statuses: findings.sort() }).toEqual({
      moved: [...KNOWN_WRITES].sort(),
      statuses: [...NON_REFUSAL_STATUSES].sort(),
    });
  });
});

describe('every server action of the Visitor-rendered pages refuses R0–R3 and changes no row', () => {
  it('calls each exported action as each reader', async () => {
    const moved: string[] = [];
    const served: string[] = [];
    const leaked: string[] = [];
    let calls = 0;
    for (const file of actionFiles) {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn !== 'function') continue;
        for (const who of READERS) {
          as(who);
          const before = await snapshotRows(t.fx.workspaceId);
          let refused = true;
          let out: unknown;
          try {
            out = await (fn as (input: unknown) => Promise<unknown>)(probeBody());
            const r = out as { ok?: boolean; error?: unknown } | null | undefined;
            refused = r == null || r.ok === false || (typeof r === 'object' && 'error' in r);
          } catch {
            refused = true;
          }
          // Whatever an action answered, it carried nothing the reader may not see:
          // no withheld row for anyone, and nothing of this project at all for a
          // reader who was never admitted (R0, R1).
          const text = JSON.stringify(out ?? null);
          // (V1's and V2's ids are the probe's own input, so an echo of them in a
          // refusal is not a leak; their TITLES are.)
          const { E, C1, C2, G } = t.items;
          const forbidden =
            who === 'R0' || who === 'R1'
              ? [
                  ...[...t.visible, ...t.hidden].map((w) => w.title),
                  ...[E, C1, C2, G].map((w) => w.id),
                ]
              : t.withheld;
          for (const f of forbidden) {
            if (text.includes(f)) leaked.push(`${who} ${rel(file)}#${name} carries ${f}`);
          }
          calls += 1;
          const changed = changedTables(before, await snapshotRows(t.fx.workspaceId));
          if (changed.length) moved.push(`${who} ${rel(file)}#${name} → ${changed.join(', ')}`);
          if (!refused) served.push(`${who} ${rel(file)}#${name}`);
        }
      }
    }
    expect(actionFiles.length).toBeGreaterThanOrEqual(11);
    expect(calls).toBeGreaterThanOrEqual(180);
    expect({ moved: moved.sort(), leaked: leaked.sort(), served: served.sort() }).toEqual({
      moved: [],
      leaked: [],
      served: [...ACTIONS_SERVED].sort(),
    });
  });
});

/**
 * Writes the sweep saw LAND in the project's workspace — defects this gate found
 * and reported for filing, not fixed by a test card. Tight both ways: a new one
 * fails, and a fixed one fails until its entry is deleted.
 *
 * (R3's watch/unwatch, which rode the Public level's `project:browse` on the
 * member path, was fixed by MOTIR-6733: a non-entrant holds no key there.)
 */
const KNOWN_WRITES: string[] = [];

/** Statuses outside 401/403/404 (and the body refusals above), each with its reason. Tight. */
const NON_REFUSAL_STATUSES: string[] = [
  // R1 and R2 belong to another organisation, and `POST /api/sprints` creates in
  // the caller's ACTIVE project — their own. The scoped snapshot proves nothing
  // landed in this project; it is their own organisation's write, not a Visitor's.
  'R1 POST /api/sprints → 201',
  'R2 POST /api/sprints → 201',
];

/**
 * Actions that answered a reader with a non-error result. Every one is a READ
 * (and the leak check above ran over its answer), except R1's folder, which —
 * like the sprint — was created in R1's OWN active project.
 */
const ACTIONS_SERVED: string[] = [
  'R0 app/(authed)/plans/_actions.ts#loadMoreSessionsAction',
  'R1 app/(authed)/items/actions.ts#createFolderAction',
  'R1 app/(authed)/items/actions.ts#listArchivedWorkItemsAction',
  'R1 app/(authed)/items/actions.ts#listProjectFoldersAction',
  'R1 app/(authed)/items/actions.ts#listRootIssuesAction',
  'R2 app/(authed)/items/actions.ts#listArchivedWorkItemsAction',
  'R2 app/(authed)/items/actions.ts#listChildIssuesAction',
  'R2 app/(authed)/items/actions.ts#listProjectFoldersAction',
  'R2 app/(authed)/items/actions.ts#listRootIssuesAction',
  'R3 app/(authed)/items/actions.ts#listChildIssuesAction',
  'R3 app/(authed)/items/actions.ts#listRootIssuesAction',
  // (R3's Plans load-more is no longer served its own-project empty page: since
  // MOTIR-6890 it reads the public project as a Visitor, where the probe's body is
  // not a cursor and the read refuses it — as it does for R2.)
];
