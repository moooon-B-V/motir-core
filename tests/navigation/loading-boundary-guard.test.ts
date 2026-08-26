import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3437 — the two guards a coverage percentage cannot see.
//
// Both halves of this story decay silently. A `router.push` on a client-only
// toggle compiles, renders correctly and passes every functional test; its only
// symptom is a wait. And a `loading.tsx` is a file nothing imports, so its
// effect on the routes BENEATH it is invisible to every test that does not
// measure an HTTP status.
//
// ── WHY GUARD 1 IS THE INVERSE OF WHAT THIS CARD FIRST ASKED FOR ───────────
// MOTIR-3437 was written to ratchet loading boundaries UP — "every route group
// carries a `loading.tsx`" — on the assumption that a boundary is free. It is
// not, and the assumption was falsified by experiment on this branch:
//
//   A `loading.tsx` fallback can render as soon as its ancestor layouts
//   resolve, which is BEFORE the page function runs. That flushes the response
//   head, so the status is fixed at 200 — and a `notFound()` reached later in
//   the page renders the not-found BODY under a 200 status. The 404 is gone.
//
// Measured, not reasoned: `tests/e2e/billing-selfhost.spec.ts` asserts
// `/settings/organization/billing` 404s off-cloud. With a `(authed)`-level
// `loading.tsx` it received 200; with the boundary removed and nothing else
// changed, 404. The same A/B held for the cross-workspace isolation assertion
// in `issue-detail-flow.spec.ts`, whose 404 is a documented no-existence-leak
// contract ("it must be indistinguishable from a missing issue").
//
// ⚠️ AND MOVING THE GATE DOES NOT HELP. The obvious repair — hoist the
// `notFound()` into a `layout.tsx` above the page so it runs "before" the
// stream — was BUILT AND TESTED on the billing route and still returned 200.
// A layout is an ancestor of the boundary, so resolving it is what RELEASES
// the fallback. There is no gate placement that recovers the status; the only
// fix is not to put a boundary above a segment that decides existence.
//
// ── WHAT IS SAFE ───────────────────────────────────────────────────────────
// An IN-PAGE `<Suspense>` is safe and is the right instrument for a page that
// must both 404 and stream: it renders after the page's own gate, so the
// status is already settled. `app/(authed)/items/[key]/page.tsx` (MOTIR-3436)
// does exactly this, and `issue-detail-flow.spec.ts` passes 16/16 with it.
//
// A ROUTE GROUP is the other safe instrument, and it is the one to reach for
// when a frame is worth keeping for the SIBLINGS of a deciding route. A group
// adds no URL segment but does own its own `loading.tsx`, so putting the safe
// page and the boundary inside it excludes the decider without moving either
// route. `app/(public)/explore/(square)/` (MOTIR-3491) is the worked example.
//
// So this guard now enforces the rule that actually holds, and it is stated as
// a prohibition rather than a ratchet: NO `loading.tsx` may sit above a page
// that calls `notFound()`. The prose half is `motir-core/CLAUDE.md`
// § *A `loading.tsx` may not sit above a route that decides existence*.
// A rule with no guard is a comment.
const ROOT = process.cwd();
const APP = join(ROOT, 'app');

const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

function walk(dir: string, out: { pages: string[]; loading: Set<string> }) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry === 'page.tsx' || entry === 'page.ts') out.pages.push(dir);
    else if (entry === 'loading.tsx') out.loading.add(dir);
  }
  return out;
}

/** The nearest ancestor (inclusive) carrying a `loading.tsx`, or null. */
function nearestBoundary(pageDir: string, loading: Set<string>): string | null {
  let cur = pageDir;
  for (;;) {
    if (loading.has(cur)) return cur;
    if (cur === APP) return null;
    const next = join(cur, '..');
    if (next === cur) return null;
    cur = next;
  }
}
// ── The debt list — EMPTY as of MOTIR-3491, and it only ever shrinks ───────
//
// This list exists so the guard can be GREEN on a true statement of the tree
// rather than red on a defect that belongs to another story. It carried exactly
// one entry when it was written: `app/(public)/explore/loading.tsx` sat above
// `app/(public)/explore/topic/[slug]/page.tsx`, so a missing topic answered 200.
//
// MOTIR-3491 retired it, and HOW is worth recording, because the obvious repair
// — delete the boundary — would have cost `/explore` its pending frame. The
// square's page and its `loading.tsx` moved together into a
// `app/(public)/explore/(square)/` route group instead. A route group adds no URL
// segment, so `/explore` is unchanged and still framed; but `topic/[slug]` sits
// OUTSIDE the group, so the boundary is no longer its ancestor and its 404
// survives. Measured on a production build: 200 before, 404 after.
//
// So the general remedy is three-way, not two-way: drop the boundary, move the
// frame INTO the page as a `<Suspense>` after the gate, or SCOPE the boundary
// into a route group that excludes the deciding route.
//
// A new entry here is a defect being parked, not a rule being bent: it needs a
// filed bug, a reproduction, and a reason. Both assertions below stay tight
// against it — the day a listed route stops applying, the list must shrink or
// the suite fails.
const KNOWN_STATUS_DEBT: { page: string; boundary: string; why: string }[] = [];

describe('no loading boundary sits above a route that decides existence (MOTIR-3437)', () => {
  const { pages, loading } = walk(APP, { pages: [], loading: new Set<string>() });

  /** Pages whose own source calls `notFound()` — i.e. whose status is load-bearing.
   *
   *  A plain substring search, so a page that merely NAMES the call in a comment
   *  counts as a decider. That is the safe direction — the guard over-reports and
   *  fails loudly rather than quietly clearing a route whose status is real — but
   *  it is worth knowing before you argue with it: MOTIR-3491's own framed page
   *  tripped this by explaining, in a comment, why its deciding sibling must stay
   *  outside the boundary. Name the call indirectly in a framed page's prose. */
  const deciders = pages.filter((dir) => {
    for (const name of ['page.tsx', 'page.ts']) {
      try {
        if (readFileSync(join(dir, name), 'utf8').includes('notFound()')) return true;
      } catch {
        /* not this extension */
      }
    }
    return false;
  });

  const offenders = deciders
    .map((dir) => ({ dir, boundary: nearestBoundary(dir, loading) }))
    .filter((r): r is { dir: string; boundary: string } => r.boundary !== null);

  it('has a non-empty population to rule on — the walk actually found the tree', () => {
    expect(pages.length).toBeGreaterThan(50);
    expect(deciders.length).toBeGreaterThan(5);
  });

  it('no page that calls notFound() resolves to a loading boundary', () => {
    const listed = new Set(KNOWN_STATUS_DEBT.map((d) => d.page));
    const unlisted = offenders
      .map((o) => ({
        page: rel(join(o.dir, 'page.tsx')),
        line: `${rel(join(o.dir, 'page.tsx'))}  ← boundary at ${rel(o.boundary)}`,
      }))
      .filter((o) => !listed.has(o.page))
      .map((o) => o.line);

    expect(
      unlisted,
      'A `loading.tsx` above these routes flushes a 200 shell before the page runs, so their ' +
        '`notFound()` renders under a 200 and the 404 is lost. Move the frame INTO the page as a ' +
        '<Suspense> placed after the gate, or drop the boundary. Hoisting the gate into a layout ' +
        'does NOT work — that was built and measured.',
    ).toEqual([]);
  });

  it('carries no KNOWN_STATUS_DEBT entry that has stopped applying — the list only shrinks', () => {
    const live = new Set(offenders.map((o) => rel(join(o.dir, 'page.tsx'))));
    const stale = KNOWN_STATUS_DEBT.filter((d) => !live.has(d.page)).map((d) => d.page);
    expect(
      stale,
      'These entries no longer describe the tree — the boundary or the notFound() is gone. Delete them.',
    ).toEqual([]);
  });

  it('every debt entry states a REASON, not just a path', () => {
    for (const d of KNOWN_STATUS_DEBT) expect(d.why.length).toBeGreaterThan(40);
  });

  it('FIRES on a boundary placed above a decider — demonstrated, not assumed', () => {
    // The guard is only worth its lines if it actually catches the shape. Put a
    // synthetic boundary at the app root and every decider becomes an offender.
    const sabotaged = new Set(loading);
    sabotaged.add(APP);
    const caught = deciders.map((dir) => nearestBoundary(dir, sabotaged)).filter((b) => b !== null);
    expect(caught.length).toBe(deciders.length);
  });
});

// ── Guard 2 — a client-only view toggle does not navigate ──────────────────
//
// SCOPED TO A NAMED LIST, deliberately. Four other switches use the same
// `Segmented` primitive and legitimately call `router.push`, because each
// changes what the SERVER must fetch. A guard that could not tell them apart
// would either fail on correct code or be widened until it asserted nothing —
// so the discriminator is stated here, per file, rather than inferred from a
// pattern.
const CLIENT_ONLY_SWITCHES: { file: string; param: string; why: string }[] = [
  {
    file: 'components/planning/PlanDetail.tsx',
    param: '?view=list|canvas',
    why: 'Both bodies render from the `review` the island already holds in useState.',
  },
  {
    file: 'app/(authed)/items/[key]/_components/ChildPanel.tsx',
    param: '?children=list|graph',
    why: 'The list body IS the already-rendered `children` prop; the graph mounts a client canvas that fetches its own level.',
  },
  {
    file: 'components/planning/RoadmapView.tsx',
    param: '?scope=project|sprint',
    why: 'The canvas refetches on its `key={scope}` remount — the file’s own comment says the navigation is not what drives it.',
  },
];

const LEGITIMATE_NAVIGATORS: { file: string; why: string }[] = [
  {
    file: 'app/(authed)/items/_components/IssueViewSwitcher.tsx',
    why: 'Tree ↔ list is a different query and a different pagination — a real server read.',
  },
  {
    file: 'app/(authed)/plans/_components/PlanStatusTabs.tsx',
    why: 'Each tab is its own paged read.',
  },
  {
    file: 'app/(authed)/items/[key]/_components/ActivitySection.tsx',
    why: 'The server fetches only the active tab’s first page, so switching tabs must reach it.',
  },
  {
    file: 'app/(authed)/settings/workspace/_components/ProviderSwitch.tsx',
    why: 'Changes ROUTE (/settings/workspace/<provider>), not a search param — two pages, two reads.',
  },
];

describe('a client-only view switch does not ask the server (MOTIR-3437)', () => {
  const read = (p: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:fs').readFileSync(join(ROOT, p), 'utf8') as string;
  };

  it.each(CLIENT_ONLY_SWITCHES)('$file writes $param shallowly', ({ file, why }) => {
    const src = read(file);
    expect(
      /router\.(push|replace)\(/.test(src),
      `${file} must not navigate: ${why} Use \`shallowPush\` from lib/navigation/shallowUrl.`,
    ).toBe(false);
    expect(src).toContain('shallowPush');
  });

  it('the excluded switches still exist — the exclusion list is not stale', () => {
    // If one of these is deleted or renamed, its reason stops being checkable
    // and the list quietly becomes fiction.
    for (const { file } of LEGITIMATE_NAVIGATORS) {
      expect(() => read(file), `${file} is on the exclusion list but is gone`).not.toThrow();
    }
  });

  it('every excluded switch states WHY it may navigate', () => {
    expect(LEGITIMATE_NAVIGATORS.filter((e) => e.why.trim().length < 20)).toEqual([]);
  });

  it('history.pushState resolves to exactly ONE module', () => {
    const hits: string[] = [];
    const scan = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir))) {
        const p = join(dir, entry);
        if (statSync(join(ROOT, p)).isDirectory()) scan(p);
        else if (/\.tsx?$/.test(entry)) {
          if (/history\.pushState\(/.test(read(p))) hits.push(p.split(sep).join('/'));
        }
      }
    };
    scan('app');
    scan('components');
    scan('lib');
    expect(
      hits,
      'The shallow-URL mechanism lives in ONE place so the three call sites cannot drift from it. ' +
        'A second copy is how `shallowPush` stayed trapped in IssueQuickView for a year.',
    ).toEqual(['lib/navigation/shallowUrl.ts']);
  });

  it('FIRES when a switch reintroduces router.push — demonstrated, not assumed', () => {
    // The same predicate the guard applies, against a synthetic source.
    const offending = 'const go = (n) => router.push(`${pathname}?view=${n}`, { scroll: false });';
    const correct = 'const go = (n) => shallowPush(`${pathname}?view=${n}`);';
    expect(/router\.(push|replace)\(/.test(offending)).toBe(true);
    expect(/router\.(push|replace)\(/.test(correct)).toBe(false);
  });
});
