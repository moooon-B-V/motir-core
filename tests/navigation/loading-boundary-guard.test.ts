import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

// ══════════════════════════════════════════════════════════════════════════
// Guard 3 — THE SERIAL-READ RATCHET (MOTIR-3449)
// ══════════════════════════════════════════════════════════════════════════
//
// Guard 1 asserts no route resolves to a `loading.tsx` above a decider. This is
// its streaming twin and asserts the other half: that no page ARRIVES SERIAL.
// They live in one file deliberately — both rule on the same walk of `app/`, and
// a second harness would mean two populations that could disagree about what a
// page is.
//
// ── WHAT IT COUNTS, and why the definition is the interesting part ─────────
// Per page: the `await`s in the DEFAULT-EXPORTED function's own body that are
// not inside a concurrency helper. Three deliberate exclusions, each of which
// changes the number a lot:
//
//   1. Only the PAGE FUNCTION's body. Awaits inside a `…PaneBody` helper are
//      BELOW the boundary and do not delay the first flush — counting them would
//      punish exactly the restructuring this story performed.
//   2. A `Promise.all` / `allSettledOrThrow` argument block collapses to ONE.
//      That is the whole point: six reads in one wave is one round trip.
//   3. REQUEST-LOCAL resolutions are not reads. `params`, `searchParams`,
//      `getTranslations`, `getFormatter`, `getLocale`, `cookies()`, `headers()`
//      resolve from the request or a per-request cache and cost no round trip.
//      Counting them inflated every gated page by two to four and moved the
//      ceiling above the thing it is supposed to catch — measured, and the
//      reason this list exists rather than a simpler rule.
//
// ── THE CEILING IS 4, AND HERE IS THE MEASUREMENT ─────────────────────────
// Taken on `parent/MOTIR-3440-remaining-pages-stream` at ffdcd835, over the 87
// pages under `app/` that carry a default export:
//
//     reads  0   1   2   3   4   5   6
//     pages 10   9  13  28  19   7   1
//
// The mode is 3 — `getSession` → `getActiveProject` → `guardSettingsPage`, the
// gate floor a permission-gated page cannot go below. 4 is that floor plus one
// genuine read. Everything at 5 or 6 is either a decider whose chain is real or
// a page outside this story, and each is listed below with which.
//
// After this story's sweep all thirteen settings panes sit at 3 or 4. Before it,
// the same pages carried their reads one after another; the number moved because
// the reads did, not because the counter is lenient.
const SERIAL_READ_CEILING = 4;

/** Awaits that resolve from the request or a per-request cache — not round trips. */
const REQUEST_LOCAL = new Set([
  'params',
  'searchParams',
  'getTranslations',
  'getFormatter',
  'getLocale',
  'cookies',
  'headers',
]);

/** Source with comments stripped — a claim in prose is not a claim in code. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * The default-exported page function's own body, bounded by the next TOP-LEVEL
 * declaration.
 *
 * ⚠️ NOT bounded by the first `\n}`: these pages destructure their props with a
 * multi-line type annotation, so that closes the PARAMETER object and yields an
 * empty body — silently, as a zero count that passes.
 */
function defaultExportBody(src: string): string | null {
  const i = src.indexOf('export default async function');
  if (i === -1) return null;
  const rest = src.slice(i);
  const n = rest.slice(1).search(/\n(?:export |async function|function |const |\/\*\*)/);
  return n === -1 ? rest : rest.slice(0, n + 1);
}

/** Replace each concurrency helper's ARGUMENT block with a single await. */
function collapseWaves(body: string): string {
  const re = /(?:Promise\.all|Promise\.allSettled|allSettledOrThrow)\s*\(\s*\[/g;
  let out = '';
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m.index < i) continue;
    out += body.slice(i, m.index) + 'await __WAVE__()';
    let depth = 1;
    let j = re.lastIndex;
    while (j < body.length && depth > 0) {
      if (body[j] === '[') depth++;
      else if (body[j] === ']') depth--;
      j++;
    }
    i = j;
    re.lastIndex = j;
  }
  return out + body.slice(i);
}

/** The page's serial READ count, by the definition above. */
export function serialReadCount(src: string): number | null {
  const body = defaultExportBody(withoutComments(src));
  if (body === null) return null;
  const calls = [...collapseWaves(body).matchAll(/\bawait\s+([A-Za-z_$][\w$.]*)/g)].map(
    (x) => x[1]!,
  );
  return calls.filter((c) => !REQUEST_LOCAL.has(c.split('.')[0]!)).length;
}

// ── The debt list, and it only ever SHRINKS ───────────────────────────────
//
// Every page above the ceiling, with WHICH of the two reasons applies. A new
// entry is a serial chain being parked, not a rule being bent.
const SERIAL_READ_DEBT: { page: string; count: number; why: string }[] = [
  {
    page: 'app/(authed)/items/[key]/page.tsx',
    count: 6,
    why: 'A genuine chain on a DECIDER. `getIssueDetail` needs the key from the params, `resolveAliasedIssueKey` runs only when that misses (a 308 alias), and `getPermissions` is about the item the detail just returned. MOTIR-3436 already collapsed the twenty-nine reads that COULD be one wave; what is left is the part that cannot be.',
  },
  {
    page: 'app/(authed)/items/[key]/edit/page.tsx',
    count: 5,
    why: 'The same chain as the detail page it edits, one read shorter, and for the same reason: the detail read decides the notFound() and the alias resolution only runs when it misses. MOTIR-3444 made its two post-gate reads one wave, which is the whole of what was available here.',
  },
  {
    page: 'app/(authed)/settings/project/ai-planning/lessons/[lessonId]/page.tsx',
    count: 5,
    why: 'ALL GATE. Two permission gates run here rather than one — the settings area guard and `guardLessonLibrary` — and the read that follows them decides the notFound(). MOTIR-3559 measured this page and specified a zero diff: there is nothing after the gate to make concurrent, which is also why it earns no frame.',
  },
  {
    page: 'app/(authed)/roadmap/page.tsx',
    count: 5,
    why: 'A concurrency change was BUILT here and deliberately REVERTED (MOTIR-3445). `getActiveSprint` sits after an early return for the empty/onboarding branch, and `tests/planning/roadmapPageStreaming.test.tsx` asserts it is never called on that branch — a third read on a first-run project is a cost this surface was measured to avoid paying.',
  },
  {
    page: 'app/(authed)/plans/page.tsx',
    count: 5,
    why: 'Measured by MOTIR-3445 and left undiffed. The capabilities read gates which tab strip renders and `buildPlanRowViews` consumes the wave that follows it, so the order is a dependency rather than a habit.',
  },
  {
    page: 'app/(authed)/settings/workspace/page.tsx',
    count: 5,
    why: 'OUT OF THIS STORY. `resolveWorkspaceTierDisclosure` decides whether this route exists at all (below the reveal threshold it 404s and `/settings/organization` hosts its sections instead), so it precedes the context and summary reads. Not among the twenty-six heavy surfaces this story swept.',
  },
  {
    page: 'app/(onboarding)/onboarding/page.tsx',
    count: 5,
    why: 'OUT OF THIS STORY — the onboarding group is not in the authed sweep. Its chain threads a workspace service context through the migrate read and the pending-idea read, which is a dependency, but it has not been measured by anyone and should be before it is called one.',
  },
  {
    page: 'app/(onboarding)/onboarding/discovery/page.tsx',
    count: 5,
    why: 'OUT OF THIS STORY, and the same chain as its sibling above — the two share a shape and would be measured together whenever the onboarding group is swept.',
  },
];

describe('no page arrives SERIAL — the ratchet (MOTIR-3449)', () => {
  const { pages } = walk(APP, { pages: [], loading: new Set<string>() });
  const counted = pages
    .map((dir) => {
      const file = ['page.tsx', 'page.ts'].map((n) => join(dir, n)).find((f) => existsSync(f))!;
      return { page: rel(file), count: serialReadCount(readFileSync(file, 'utf8')) };
    })
    .filter((r): r is { page: string; count: number } => r.count !== null);

  it('has a non-empty population to rule on — the walk actually found the tree', () => {
    expect(counted.length).toBeGreaterThan(50);
  });

  it('no page exceeds the ceiling except the ones listed, with their reasons', () => {
    const listed = new Set(SERIAL_READ_DEBT.map((d) => d.page));
    const offenders = counted
      .filter((r) => r.count > SERIAL_READ_CEILING && !listed.has(r.page))
      .map((r) => `${r.page} (${r.count} serial reads, ceiling ${SERIAL_READ_CEILING})`);
    expect(offenders).toEqual([]);
  });

  it('carries no debt entry that has stopped applying — the list only shrinks', () => {
    // The day a listed page comes back under the ceiling, the entry must go or
    // this fails. That is what makes the list a ratchet rather than a graveyard.
    const now = new Map(counted.map((r) => [r.page, r.count]));
    const stale = SERIAL_READ_DEBT.filter(
      (d) => !now.has(d.page) || now.get(d.page)! <= SERIAL_READ_CEILING,
    ).map((d) => d.page);
    expect(stale).toEqual([]);
  });

  it('records each listed page’s count accurately — the list cannot drift from the tree', () => {
    const now = new Map(counted.map((r) => [r.page, r.count]));
    const drifted = SERIAL_READ_DEBT.filter((d) => now.get(d.page) !== d.count).map(
      (d) => `${d.page}: listed ${d.count}, measured ${now.get(d.page)}`,
    );
    expect(drifted).toEqual([]);
  });

  it('every debt entry states a REASON, not just a path', () => {
    for (const d of SERIAL_READ_DEBT) expect(d.why.length).toBeGreaterThan(80);
  });

  it('the debt list may not GROW — adding to it is a reviewed act', () => {
    // Pinned exactly. A card that needs a ninth entry has to change this number
    // in the same diff, which is the review this guard exists to force.
    expect(SERIAL_READ_DEBT).toHaveLength(8);
  });

  it('FIRES on a page carrying a fresh serial chain — demonstrated, not assumed', () => {
    // A guard nobody has seen fire is indistinguishable from one that cannot.
    //
    // ⚠️ The fixtures below are joined line arrays rather than template literals,
    // so their top-level declarations sit at column 0 the way a real file's do.
    // An indented fixture silently defeats `defaultExportBody`'s bound — it looks
    // for the NEXT top-level declaration — and the helper-component case then
    // reads the helper's awaits as the page's and passes for the wrong reason.
    const fixture = [
      'export default async function SabotagedPage() {',
      '  const session = await getSession();',
      '  const ctx = await getActiveProject();',
      '  const a = await serviceOne.read(ctx);',
      '  const b = await serviceTwo.read(ctx);',
      '  const c = await serviceThree.read(ctx);',
      '  return null;',
      '}',
    ].join('\n');
    expect(serialReadCount(fixture)).toBe(5);
    expect(serialReadCount(fixture)!).toBeGreaterThan(SERIAL_READ_CEILING);
  });

  it('and does NOT fire when the same reads are ONE wave — the fix must clear it', () => {
    // The mirror of the test above: the guard has to be satisfiable by the
    // restructuring it is asking for, or it is a tax rather than a ratchet.
    const fixed = [
      'export default async function FixedPage() {',
      '  const session = await getSession();',
      '  const ctx = await getActiveProject();',
      '  const [a, b, c] = await allSettledOrThrow([',
      '    serviceOne.read(ctx),',
      '    serviceTwo.read(ctx),',
      '    serviceThree.read(ctx),',
      '  ]);',
      '  return null;',
      '}',
    ].join('\n');
    expect(serialReadCount(fixed)).toBe(3);
    expect(serialReadCount(fixed)!).toBeLessThanOrEqual(SERIAL_READ_CEILING);
  });

  it('counts a helper component’s reads as BELOW the flush, not on the page', () => {
    // The restructuring this story performed moves reads into a `…PaneBody`
    // below the boundary. If those counted, the guard would punish the fix.
    const streamed = [
      'export default async function StreamedPage() {',
      '  const session = await getSession();',
      '  const ctx = await getActiveProject();',
      '  return null;',
      '}',
      '',
      'async function Body({ ctx }) {',
      '  const a = await serviceOne.read(ctx);',
      '  const b = await serviceTwo.read(ctx);',
      '  const c = await serviceThree.read(ctx);',
      '  return null;',
      '}',
    ].join('\n');
    expect(serialReadCount(streamed)).toBe(2);
  });

  it('does not count request-local resolutions as reads', () => {
    const local = [
      'export default async function LocalPage({ params }) {',
      '  const session = await getSession();',
      "  const t = await getTranslations('x');",
      '  const { id } = await params;',
      '  const sp = await searchParams;',
      '  const f = await getFormatter();',
      '  const c = await cookies();',
      '  return null;',
      '}',
    ].join('\n');
    // Only `getSession` is a round trip.
    expect(serialReadCount(local)).toBe(1);
  });
});

// ── The /items NON-REGRESSION — the story's one deliberate absence ─────────
//
// `/items` renders its header and `[Filter] · [Tree ▾] · [+ New]` toolbar
// synchronously and streams only its table, behind
// `<Suspense fallback={<IssueTreeSkeleton/>}>`. A `loading.tsx` at
// `app/(authed)/items/` would sit ABOVE that and replace a toolbar the reader
// can already use with a skeleton — a page made WORSE by being swept.
//
// Nothing else in the repository explains why that directory has no boundary,
// so without this the next person sweeping for missing boundaries adds one and
// quietly undoes it. Guard 1 cannot catch it: `/items` does not call
// `notFound()`, so a boundary there is legal by that rule and wrong by this one.
describe('/items keeps its toolbar in the first flush (MOTIR-3449)', () => {
  it('has NO loading.tsx of its own', () => {
    expect(existsSync(join(APP, '(authed)', 'items', 'loading.tsx'))).toBe(false);
  });

  it('and no ancestor gives it one either', () => {
    const { loading } = walk(APP, { pages: [], loading: new Set<string>() });
    expect(nearestBoundary(join(APP, '(authed)', 'items'), loading)).toBeNull();
  });

  it('renders its toolbar ABOVE its only boundary, from the gate', () => {
    const src = withoutComments(readFileSync(join(APP, '(authed)', 'items', 'page.tsx'), 'utf8'));
    const boundary = src.indexOf('<Suspense');
    expect(boundary).toBeGreaterThan(-1);
    // The table's skeleton is the fallback; the toolbar is not inside it.
    expect(src).toMatch(/fallback=\{<IssueTreeSkeleton/);
    expect(src.slice(boundary)).not.toMatch(/IssueToolbar|<Filter/);
  });
});
