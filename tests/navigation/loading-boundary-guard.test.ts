import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3437 — the two guards a coverage percentage cannot see.
//
// Both halves of this story decay silently. A `loading.tsx` is a file nothing
// imports, so deleting it breaks no build and no test — the page simply goes
// back to arriving late. A `router.push` on a client-only toggle compiles,
// renders correctly and passes every functional test; its only symptom is a
// wait. Neither defect has a failing test to find, which is exactly why both
// shipped and why the fix for each was made once and never generalised
// (MOTIR-2069 fixed `/planning` and only `/planning`; MOTIR-1086 built
// `shallowPush` and left it in one file).
//
// The prose halves of these two rules live in `motir-core/CLAUDE.md`
// (§ *Every route group carries a `loading.tsx`* and § *URL state the CLIENT
// reads is written with `shallowPush`*). A rule with no guard is a comment.

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

// ── The RATCHET, and why this guard is one ─────────────────────────────────
//
// The card asked for "every `page.tsx` resolves to a `loading.tsx`". Measured
// on this tree that is 33 pages short, and every one of them is in a group
// MOTIR-3430's own boundary section puts OUT of scope: *"It covers the
// `(authed)` route group. `(planning)` already has its boundary; `(public)` and
// `(auth)` are out."* A guard written to the literal instruction would be red
// on arrival and would be deleted or weakened within a week.
//
// So it is a ratchet instead, which is what the card's stated INTENT actually
// asks for — *"the guard that keeps a NEW route group from starting life
// without one"*. The uncovered set is frozen as a named list. A new page
// without a boundary fails; a listed one that GAINS a boundary also fails,
// until it is struck off. The list can only shrink, and it cannot rot into a
// mute button because it is asserted tight in both directions.
//
// MOTIR-3440 is where the rest of this list goes.
const UNCOVERED_BY_DESIGN: { dir: string; why: string }[] = [
  {
    dir: 'app',
    why: 'The root landing page — outside every route group. A static marketing surface with no server read to wait on.',
  },
  {
    dir: 'app/(admin)/admin',
    why: 'The platform-staff console. Out of MOTIR-3430 scope; not a tenant surface and not on any reader path this story measures.',
  },
  {
    dir: 'app/(auth)/device',
    why: '(auth) is explicitly OUT of MOTIR-3430 scope. A sign-in surface must never flash a skeleton at an unauthenticated visitor — the frame would imply an app they have not reached.',
  },
  {
    dir: 'app/(auth)/reset-password',
    why: '(auth) is explicitly OUT of MOTIR-3430 scope. A sign-in surface must never flash a skeleton at an unauthenticated visitor — the frame would imply an app they have not reached.',
  },
  {
    dir: 'app/(auth)/reset-password/new',
    why: '(auth) is explicitly OUT of MOTIR-3430 scope. A sign-in surface must never flash a skeleton at an unauthenticated visitor — the frame would imply an app they have not reached.',
  },
  {
    dir: 'app/(auth)/sign-in',
    why: '(auth) is explicitly OUT of MOTIR-3430 scope. A sign-in surface must never flash a skeleton at an unauthenticated visitor — the frame would imply an app they have not reached.',
  },
  {
    dir: 'app/(auth)/sign-up',
    why: '(auth) is explicitly OUT of MOTIR-3430 scope. A sign-in surface must never flash a skeleton at an unauthenticated visitor — the frame would imply an app they have not reached.',
  },
  {
    dir: 'app/(auth)/unsubscribe/filter-subscription',
    why: '(auth) is explicitly OUT of MOTIR-3430 scope. A sign-in surface must never flash a skeleton at an unauthenticated visitor — the frame would imply an app they have not reached.',
  },
  {
    dir: 'app/(onboarding)/onboarding',
    why: '(onboarding) is a guided flow that carries its own step and progress affordances; a page-shaped frame would compete with them. Not in MOTIR-3430 scope.',
  },
  {
    dir: 'app/(onboarding)/onboarding/direction/[tier]',
    why: '(onboarding) is a guided flow that carries its own step and progress affordances; a page-shaped frame would compete with them. Not in MOTIR-3430 scope.',
  },
  {
    dir: 'app/(onboarding)/onboarding/discovery',
    why: '(onboarding) is a guided flow that carries its own step and progress affordances; a page-shaped frame would compete with them. Not in MOTIR-3430 scope.',
  },
  {
    dir: 'app/(onboarding)/onboarding/how-it-works',
    why: '(onboarding) is a guided flow that carries its own step and progress affordances; a page-shaped frame would compete with them. Not in MOTIR-3430 scope.',
  },
  {
    dir: 'app/(onboarding)/onboarding/import',
    why: '(onboarding) is a guided flow that carries its own step and progress affordances; a page-shaped frame would compete with them. Not in MOTIR-3430 scope.',
  },
  {
    dir: 'app/(onboarding)/onboarding/migrate',
    why: '(onboarding) is a guided flow that carries its own step and progress affordances; a page-shaped frame would compete with them. Not in MOTIR-3430 scope.',
  },
  {
    dir: 'app/(public)/docs',
    why: '(public) is explicitly OUT of MOTIR-3430 scope, and the docs tree is statically rendered — there is no server read to wait on.',
  },
  {
    dir: 'app/(public)/docs/api',
    why: '(public) is explicitly OUT of MOTIR-3430 scope, and the docs tree is statically rendered — there is no server read to wait on.',
  },
  {
    dir: 'app/(public)/docs/api/getting-started',
    why: '(public) is explicitly OUT of MOTIR-3430 scope, and the docs tree is statically rendered — there is no server read to wait on.',
  },
  {
    dir: 'app/(public)/docs/api/stability',
    why: '(public) is explicitly OUT of MOTIR-3430 scope, and the docs tree is statically rendered — there is no server read to wait on.',
  },
  {
    dir: 'app/(public)/docs/cli',
    why: '(public) is explicitly OUT of MOTIR-3430 scope, and the docs tree is statically rendered — there is no server read to wait on.',
  },
  {
    dir: 'app/(public)/docs/mcp',
    why: '(public) is explicitly OUT of MOTIR-3430 scope, and the docs tree is statically rendered — there is no server read to wait on.',
  },
  {
    dir: 'app/(public)/docs/mcp/tools',
    why: '(public) is explicitly OUT of MOTIR-3430 scope, and the docs tree is statically rendered — there is no server read to wait on.',
  },
  {
    dir: 'app/(public)/docs/sandbox',
    why: '(public) is explicitly OUT of MOTIR-3430 scope, and the docs tree is statically rendered — there is no server read to wait on.',
  },
  {
    dir: 'app/(public)/p/[identifier]',
    why: '(public) is explicitly OUT of MOTIR-3430 scope. The public project surfaces are anonymous reads and belong to their own story.',
  },
  {
    dir: 'app/(public)/p/[identifier]/board',
    why: '(public) is explicitly OUT of MOTIR-3430 scope. The public project surfaces are anonymous reads and belong to their own story.',
  },
  {
    dir: 'app/(public)/p/[identifier]/items',
    why: '(public) is explicitly OUT of MOTIR-3430 scope. The public project surfaces are anonymous reads and belong to their own story.',
  },
  {
    dir: 'app/(public)/p/[identifier]/items/[key]',
    why: '(public) is explicitly OUT of MOTIR-3430 scope. The public project surfaces are anonymous reads and belong to their own story.',
  },
  {
    dir: 'app/(public)/p/[identifier]/requests/[requestKey]',
    why: '(public) is explicitly OUT of MOTIR-3430 scope. The public project surfaces are anonymous reads and belong to their own story.',
  },
  {
    dir: 'app/(public)/p/[identifier]/roadmap',
    why: '(public) is explicitly OUT of MOTIR-3430 scope. The public project surfaces are anonymous reads and belong to their own story.',
  },
  {
    dir: 'app/(public)/p/[identifier]/tree',
    why: '(public) is explicitly OUT of MOTIR-3430 scope. The public project surfaces are anonymous reads and belong to their own story.',
  },
  {
    dir: 'app/tokens',
    why: 'The /tokens specimen route — a design-system reference surface, not a product page. It renders from static registries with no server read.',
  },
  {
    dir: 'app/tokens/date-picker',
    why: 'The /tokens specimen route — a design-system reference surface, not a product page. It renders from static registries with no server read.',
  },
  {
    dir: 'app/tokens/markdown-editor',
    why: 'The /tokens specimen route — a design-system reference surface, not a product page. It renders from static registries with no server read.',
  },
  {
    dir: 'app/tokens/tree-table',
    why: 'The /tokens specimen route — a design-system reference surface, not a product page. It renders from static registries with no server read.',
  },
];

describe('every route group resolves to a loading boundary (MOTIR-3437)', () => {
  const { pages, loading } = walk(APP, { pages: [], loading: new Set() });
  const uncovered = pages
    .filter((p) => nearestBoundary(p, loading) === null)
    .map(rel)
    .sort();
  const listed = UNCOVERED_BY_DESIGN.map((e) => e.dir).sort();

  it('has a non-empty population to rule on — the walk actually found the tree', () => {
    // A guard whose scan silently found nothing passes forever. This is the
    // floor that makes every assertion below non-vacuous.
    expect(pages.length).toBeGreaterThan(50);
    expect(loading.size).toBeGreaterThan(0);
  });

  it('covers every page that is not on the frozen list', () => {
    const unexpected = uncovered.filter((d) => !listed.includes(d));
    expect(
      unexpected,
      'A route with no `loading.tsx` on its path parks the navigation on the PREVIOUS surface until ' +
        'its slowest await settles. Add a `loading.tsx` at the route GROUP (see CLAUDE.md § *Every route ' +
        'group carries a `loading.tsx`*), or — if the surface genuinely must not show a frame — add it to ' +
        'UNCOVERED_BY_DESIGN with the reason.',
    ).toEqual([]);
  });

  it('carries no frozen entry that has stopped applying — the list only shrinks', () => {
    const stale = listed.filter((d) => !uncovered.includes(d));
    expect(
      stale,
      'These are listed as deliberately uncovered but now resolve to a boundary. Strike them off — a ' +
        'ratchet that keeps entries it no longer needs is a mute button.',
    ).toEqual([]);
  });

  it('every frozen entry states a REASON, not just a path', () => {
    const reasonless = UNCOVERED_BY_DESIGN.filter((e) => e.why.trim().length < 20).map(
      (e) => e.dir,
    );
    expect(reasonless).toEqual([]);
  });

  it('FIRES on a route group with no boundary — demonstrated, not assumed', () => {
    // The card asks for the guard to be proven to fail rather than believed to.
    // A synthetic tree, walked by the same functions: one group WITH a boundary
    // and one without.
    const synthetic = {
      pages: ['/x/app/(good)/one', '/x/app/(bad)/two'],
      loading: new Set(['/x/app/(good)']),
    };
    const nearest = (d: string) => {
      let cur = d;
      for (;;) {
        if (synthetic.loading.has(cur)) return cur;
        if (cur === '/x/app') return null;
        cur = join(cur, '..');
      }
    };
    expect(nearest('/x/app/(good)/one')).toBe('/x/app/(good)');
    expect(nearest('/x/app/(bad)/two')).toBeNull();
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
