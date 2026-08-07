import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCS_REDIRECTS } from '../next.config';

// MOTIR-2316 — a design asset is a REFERRER to the app's addresses, and it is
// the only referrer no other check can see.
//
// ── The defect this guards ──────────────────────────────────────────────────
// ADR `public-api-conventions.md` Amendment 9 Q1 renamed `/api-docs*` to
// `/docs*`, and it enumerated its own cost by grep rather than estimating it:
// the route directory, four in-product link sites, three ADR self-references,
// `lib/apiDocs/guide.ts`, ~14 vitest assertions across four files, eight URL
// waits in the E2E spec, the redirect map. Every one of those was updated.
// `design/api-docs/` was not on the list, and stayed two generations stale
// (Amendment 11 then moved the same pages again, to `/docs/api*`) until the
// next card to trust it as the layout source of truth noticed.
//
// Nothing failed, and nothing could have: a design asset is Markdown and HTML
// that no build resolves and no test opens, so its addresses live only in prose
// and in `href`s. A referrer sweep finds callers by grepping for the OLD name,
// which is precisely the string an asset still contains — the sweep's own
// method is what hides it.
//
// ── Why a test, and not the other two options ───────────────────────────────
// The card weighed three fixes:
//
//   1. THIS ONE — grep `design/**` for addresses that no longer resolve,
//      sourcing "what resolves" from the `app/**` route tree plus
//      `next.config.ts`'s `DOCS_REDIRECTS`.
//   2. A checklist line in the migration-card template. REJECTED: it is the
//      option that already failed. Amendment 9's cost table WAS the checklist,
//      written with more care than a template would get, and the asset still
//      was not on it.
//   3. Widening `plan-rules.md`'s migration limb so a referrer sweep names
//      `design/<area>/` alongside its call sites. REJECTED as the primary fix:
//      a rule has two homes (`plan-rules.md` and motir-ai's
//      `SHARED_PLANNING_RULES`), so it is a two-repo deliverable, and it still
//      depends on a human remembering to apply it at the moment of the rename.
//      `plan-rules.md`'s THIRD TIER prefers the mechanised check wherever the
//      check needs no judgement, and this one does not: an address either
//      resolves or it does not.
//
// ── What "no judgement" costs, and where the judgement went ─────────────────
// One place, deliberately: `KNOWN` below. A design asset is often drawn BEFORE
// the surface exists, so "this address resolves to nothing" is a legitimate
// state for a forward-looking asset — and assets also quote addresses in prose
// that are not links at all (a counterfactual the design rejected, a container
// filesystem path, a historical note about the very rename this guards). Each
// such pair is listed once, with a reason, by a human. The table is asserted
// TIGHT in both directions: an unlisted finding fails, and a listed entry that
// no longer fires fails too, so the list cannot rot into a mute button.

const ROOT = process.cwd();

// ── The address inventory: what the app actually serves ─────────────────────

// Next's routable special files, in the two shapes they take. A directory
// holding a PAGE file serves the directory's own path; everything else under
// `app/` (`_components`, `layout.tsx`, `loading.tsx`) serves nothing.
const PAGE_FILES = new Set(['page.tsx', 'page.ts', 'route.ts', 'route.tsx']);
// A metadata file serves the directory's path plus its OWN name — `explore/`
// with an `opengraph-image.tsx` serves `/explore/opengraph-image`.
const METADATA_FILES = new Set([
  'opengraph-image.tsx',
  'twitter-image.tsx',
  'icon.tsx',
  'apple-icon.tsx',
  'sitemap.ts',
  'robots.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Every address `app/**` serves, as a segment pattern (`['items', '[key]']`). */
function appRoutePatterns(): string[][] {
  const seen = new Set<string>();
  for (const file of walk(join(ROOT, 'app'))) {
    const rel = relative(join(ROOT, 'app'), file).split(sep).join('/');
    const parts = rel.split('/');
    const leaf = parts.pop();
    if (!leaf) continue;
    if (METADATA_FILES.has(leaf)) parts.push(leaf.replace(/\.[a-z]+$/, ''));
    else if (!PAGE_FILES.has(leaf)) continue;
    // Route groups — `(authed)`, `(public)` — organise the tree without
    // appearing in the URL. Parallel/intercepting segments (`@slot`, `(.)x`)
    // are not used in this app.
    seen.add(parts.filter((segment) => !/^\(.*\)$/.test(segment)).join('/'));
  }
  return [...seen].map((path) => (path === '' ? [] : path.split('/')));
}

const APP_ROUTES = appRoutePatterns();
const REDIRECT_SOURCES = DOCS_REDIRECTS.map((rule) => rule.source.replace(/^\//, '').split('/'));

const isDynamic = (segment: string) => /^\[.+\]$/.test(segment) || /^:.+/.test(segment);
const isCatchAll = (segment: string) => /^\[\.\.\..+\]$/.test(segment) || /^:.+\*$/.test(segment);

/**
 * Does `candidate` (an address written in an asset, already split into
 * segments) match `pattern` (a route or redirect source)?
 *
 * A dynamic segment on EITHER side matches: the app writes `[key]` and an
 * asset may write either the placeholder (`/items/[key]`) or a concrete
 * example (`/items/MOTIR-2285`), and both address the same page.
 */
function matchesPattern(pattern: string[], candidate: string[]): boolean {
  let p = 0;
  while (p < pattern.length) {
    const segment = pattern[p]!;
    if (isCatchAll(segment)) return candidate.length > p;
    if (p >= candidate.length) return false;
    if (!isDynamic(segment) && !isDynamic(candidate[p]!) && segment !== candidate[p]) return false;
    p += 1;
  }
  return candidate.length === pattern.length;
}

// ── Reading addresses out of an asset ───────────────────────────────────────

// The four syntaxes an asset writes an address in. Restricting to these is
// what keeps the sweep quiet: bare slashes in prose are overwhelmingly
// alternatives ("green/mint", "a `Card`/`Pill`"), not addresses.
const ADDRESS_SYNTAXES = [
  /(?:href|action|src)=["'](\/[^"'\s]*)/g, // a link in a .mock.html
  /\]\((\/[^)\s]*)/g, //                      a Markdown link in design-notes.md
  /`(\/[^`\s]*)`/g, //                        an address quoted in prose
  /"(\/[a-z0-9][^"\s]*)"/g, //                a JSON string value in a .pen source
];

interface RawAddress {
  raw: string;
  line: number;
}

/** Every address-shaped string in one asset's source, with its line number. */
function addressesIn(source: string): RawAddress[] {
  const found: RawAddress[] = [];
  for (const syntax of ADDRESS_SYNTAXES) {
    for (const match of source.matchAll(syntax)) {
      const line = source.slice(0, match.index).split('\n').length;
      found.push({ raw: match[1]!, line });
    }
  }
  return found;
}

/**
 * Reduce a raw match to the in-product page address it names, or `null` when
 * it is not one. Three exclusions, each mechanical:
 */
function toPageAddress(raw: string): string | null {
  // (1) A placeholder or a regex literal — `/plans/{id}`, `/items/<key>`,
  //     `/https?:\/\/[^\s)]+/`. Tested BEFORE the query strip, so a `?` inside
  //     a regex cannot truncate it into something that looks like an address.
  if (/[<>{}…\\^$|]/.test(raw)) return null;

  let address = raw.split('?')[0]!.split('#')[0]!;
  // A prose glob — `/docs*`, `/settings/project*` — names the family, so check
  // its prefix.
  address = address.replace(/\*+$/, '');
  if (address.length > 1) address = address.replace(/\/+$/, '');
  if (address === '') return null;

  // (2) A file, not a route: `/favicon.ico`, `/api/openapi/v1.json`.
  if (/\.[a-z0-9]+$/i.test(address.split('/').pop()!)) return null;
  // (3) An HTTP endpoint rather than a page. `/api/*` is this app's but is not
  //     in the page tree, and `/v1/*` is motir-ai's — a different service whose
  //     routes this repo cannot inventory.
  if (/^\/(api|v1)(\/|$)/.test(address)) return null;

  return address;
}

type Verdict = 'redirects-away' | 'resolves-to-nothing';

function classify(address: string): Verdict | null {
  const segments = address === '/' ? [] : address.replace(/^\//, '').split('/');
  // A redirect source is checked FIRST: the address resolves, but only by
  // 308ing somewhere else, which is exactly the drift this guards.
  if (REDIRECT_SOURCES.some((pattern) => matchesPattern(pattern, segments)))
    return 'redirects-away';
  if (APP_ROUTES.some((pattern) => matchesPattern(pattern, segments))) return null;
  return 'resolves-to-nothing';
}

interface Finding {
  file: string;
  address: string;
  verdict: Verdict;
  line: number;
}

function sweep(): Finding[] {
  const assets = walk(join(ROOT, 'design')).filter((path) => /\.(md|html|pen)$/.test(path));
  const findings = new Map<string, Finding>();
  for (const path of assets) {
    const file = relative(ROOT, path).split(sep).join('/');
    for (const { raw, line } of addressesIn(readFileSync(path, 'utf8'))) {
      const address = toPageAddress(raw);
      if (address === null) continue;
      const verdict = classify(address);
      if (verdict === null) continue;
      const id = `${file} ${address}`;
      // First occurrence wins, so the reported line is the one to open.
      if (!findings.has(id)) findings.set(id, { file, address, verdict, line });
    }
  }
  return [...findings.values()].sort((a, b) =>
    `${a.file} ${a.address}`.localeCompare(`${b.file} ${b.address}`),
  );
}

// ── The judgement, in one table ─────────────────────────────────────────────
//
// Every (asset, address) pair the sweep finds today, with why it is allowed to
// stay. Adding a row is a deliberate act with a written reason; the tightness
// test below deletes the row for you the moment it stops applying.
//
// Genuinely-stale addresses found by this guard's first run are NOT silenced
// here on the merits — every one is marked STALE and fixed by MOTIR-2340, per
// this card's scope boundary (running the guard IS the audit; what it finds is
// its own card).
const KNOWN: { file: string; address: string; why: string }[] = [
  // ── Prose that names an address without using it ──────────────────────────
  {
    file: 'design/agent-sandbox/design-notes.md',
    address: '/api-docs',
    why: 'A historical note ABOUT this very rename ("the `/api-docs` → `/docs` route move"), not an address the design uses.',
  },
  {
    file: 'design/agent-sandbox/design-notes.md',
    address: '/docs',
    why: 'The same historical note. `/docs` now 308s to `/docs/api` (Amendment 11), which is what makes the note worth keeping.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    address: '/api-docs',
    why: "The asset's own ⚠️ block recording that these addresses moved twice — the correction MOTIR-2316 was filed about, so it must name the old address.",
  },
  {
    file: 'design/api-docs/design-notes.md',
    address: '/docs',
    why: "The ownership table's row for the unbuilt `/docs` area root (MOTIR-2315), which states that `/docs` still 308s to `/docs/api`.",
  },
  {
    file: 'design/roadmap/design-notes.md',
    address: '/roadmap/sprint',
    why: 'A counterfactual the design REJECTED ("a query param on one route, not a distinct /roadmap/sprint path").',
  },
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/API/MCP',
    why: 'Not an address: the line specifies how the header row RENDERS the route name, "`/api/mcp` as `/API/MCP`" — a typographic instruction about small-caps display. The lower-case /api/mcp it names does resolve.',
  },
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/docs',
    why: 'A prose reference to the unbuilt `/docs` area root (MOTIR-2315) in the reopened-by-its-own-trigger note, not an address the design uses. `/docs` 308s to /docs/api (Amendment 11).',
  },
  // ── Slash-prefixed paths that are not addresses ───────────────────────────
  {
    file: 'design/agent-sandbox/agent-sandbox.mock.html',
    address: '/workspace',
    why: 'The devcontainer `workspaceFolder` / bind-mount target in a quoted JSON config — a container filesystem path.',
  },
  {
    file: 'design/agent-sandbox/design-notes.md',
    address: '/workspace',
    why: 'The container working directory a `docker run` drops the reader into — the same filesystem path, in prose.',
  },
  {
    file: 'design/projects/design-notes.md',
    address: '/design/workspaces',
    why: 'The repo folder design/workspaces/, cited as a precedent for a two-state PNG export — a path in this repo, not an address.',
  },
  // ── Forward-looking: the asset is drawn before the surface exists ─────────
  {
    file: 'design/platform-admin/design-notes.md',
    address: '/admin',
    why: 'Forward-looking: the platform-admin console is unbuilt, and this asset proposes both the address and its route group.',
  },
  {
    file: 'design/roadmap/design-notes.md',
    address: '/projects/[key]/direction/[tier]',
    why: 'Forward-looking, and the asset says so inline ("NEW — no shipped route yet"). The tier doc shipped at /direction/[tier].',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/doooo/taq',
    why: 'Forward-looking: the per-project square page (/explore/<org>/<project>) is unbuilt; the shipped project page is /p/[identifier].',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/lumen-labs/aperture-sdk',
    why: 'Forward-looking: same unbuilt /explore/<org>/<project> page.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/moooon/motir',
    why: 'Forward-looking: same unbuilt /explore/<org>/<project> page.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/northwind/atlas-design-system',
    why: 'Forward-looking: same unbuilt /explore/<org>/<project> page.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/seedling/grove-cms',
    why: 'Forward-looking: same unbuilt /explore/<org>/<project> page.',
  },
  // The MCP + CLI documentation assets (MOTIR-2323, MOTIR-2326) merged AFTER
  // this guard, so neither could add its rows and this table could not name
  // assets that did not yet exist. Both green; the composition turned `main`
  // red (MOTIR-2348). Each row below names the card that BUILDS its route and
  // therefore deletes the row — the tightness test enforces that.
  {
    file: 'design/cli-guide/cli-guide.mock.html',
    address: '/docs/cli',
    why: 'Forward-looking: built by MOTIR-2308, whose PR #1910 was open when this landed — that PR adds app/(public)/docs/cli/page.tsx and MUST delete this row, or the tightness test fails.',
  },
  {
    file: 'design/cli-guide/design-notes.md',
    address: '/docs/cli',
    why: 'Forward-looking: same route. Built by MOTIR-2308 (PR #1910), which deletes this row.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/vantage/pulse-analytics',
    why: 'Forward-looking: same unbuilt /explore/<org>/<project> page.',
  },
  // ── Forward-looking, merged AFTER this guard and never listed ─────────────
  //    MOTIR-2370. `design/cli-guide/` (#1905) and `design/mcp-server/` (#1906)
  //    both landed on `main` after the guard did, and neither could see it: the
  //    three PRs were in flight together, so each was green against a base that
  //    did not contain the other. Their composition is what turned `main` red —
  //    the same shape as two fixes that each pass alone.
  //
  //    ⚠️ The two `design/cli-guide` rows are TEMPORARY and belong to
  //    MOTIR-2308, which ships `/docs/cli`. The tightness test below fails on a
  //    listed pair that no longer fires, so that PR DELETES them in the same
  //    commit that adds the route — which is the mechanism working, not a
  //    conflict. Land this PR first; #1910 removes its own two.
  {
    file: 'design/cli-guide/design-notes.md',
    address: '/docs/cli',
    why: 'Forward-looking until MOTIR-2308 ships the route. That PR (#1910) deletes this row.',
  },
  {
    file: 'design/cli-guide/cli-guide.mock.html',
    address: '/docs/cli',
    why: 'Forward-looking until MOTIR-2308 ships the route. That PR (#1910) deletes this row.',
  },
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/docs',
    why: 'The ownership row for the unbuilt `/docs` area root (MOTIR-2315), which states that `/docs` still 308s to `/docs/api` — the same note `design/api-docs/` carries.',
  },
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/API/MCP',
    why: 'Not an address: prose about how the catalogue’s header row RENDERS the string `/api/mcp` in uppercase.',
  },
  // ── STALE — real drift this guard found on its first run. Not silenced on
  //    the merits: MOTIR-2340 corrects every one of them and deletes these
  //    rows, and the tightness test below is what stops it re-allowlisting
  //    them instead. `/issues*` is the work-item rename; `/login` never
  //    shipped (the route is `/sign-in`).
  {
    file: 'design/backlog/backlog-filter.mock.html',
    address: '/issues',
    why: 'STALE — /items since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/backlog/design-notes.md',
    address: '/issues',
    why: 'STALE — /items since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/boards/design-notes.md',
    address: '/issues',
    why: 'STALE — /items since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/import/design-notes.md',
    address: '/issues',
    why: 'STALE — /items since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/org-admin/design-notes.md',
    address: '/issues',
    why: 'STALE — /items since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/ready/design-notes.md',
    address: '/issues',
    why: 'STALE — /items since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/triage/design-notes.md',
    address: '/issues',
    why: 'STALE — /items since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/work-items/design-notes.md',
    address: '/issues',
    why: 'STALE — /items since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/notifications/design-notes.md',
    address: '/issues/[key]',
    why: 'STALE — /items/[key] since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/public-projects/design-notes.md',
    address: '/issues/[key]',
    why: 'STALE — /items/[key] since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/work-items/design-notes.md',
    address: '/issues/[key]',
    why: 'STALE — /items/[key] since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/work-items/design-notes.md',
    address: '/issues/[identifier]',
    why: 'STALE — /items/[key] since the work-item rename; the parameter name is wrong too. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/projects/design-notes.md',
    address: '/issues/[key]/edit',
    why: 'STALE — /items/[key]/edit since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/work-items/archived.mock.html',
    address: '/issues/archived',
    why: 'STALE — /items/archived since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/work-items/design-notes.md',
    address: '/issues/archived',
    why: 'STALE — /items/archived since the work-item rename. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/onboarding-entrance/design-notes.md',
    address: '/login',
    why: 'STALE — the sign-in route is /sign-in; /login never shipped. Fixed by MOTIR-2340, not here.',
  },
  {
    file: 'design/projects/design-notes.md',
    address: '/login',
    why: 'STALE — the sign-in route is /sign-in; /login never shipped. Fixed by MOTIR-2340, not here.',
  },
];

type Entry = { file: string; address: string; why: string };
const idOf = (x: { file: string; address: string }) => `${x.file} ${x.address}`;

/** Findings no `KNOWN` row covers — an asset went stale, or a new one shipped stale. */
function unlisted(findings: Finding[], known: Entry[]): string[] {
  const allowed = new Set(known.map(idOf));
  // The file, the line to open, the address, and what is wrong with it —
  // enough to fix without re-running the sweep by hand.
  return findings
    .filter((finding) => !allowed.has(idOf(finding)))
    .map((finding) => `${finding.file}:${finding.line} — ${finding.address} (${finding.verdict})`);
}

/** `KNOWN` rows that match nothing — the asset was corrected, so the row must go. */
function expired(findings: Finding[], known: Entry[]): string[] {
  const live = new Set(findings.map(idOf));
  return known.map(idOf).filter((id) => !live.has(id));
}

describe('a design asset addresses pages that still exist', () => {
  it('finds no address the app no longer serves', () => {
    expect(
      unlisted(sweep(), KNOWN),
      'A design asset is the layout source of truth for its surface; an address it names that ' +
        'redirects away or resolves to nothing will be believed by the next card that reads it. ' +
        'Correct the asset, or add the pair to KNOWN with a reason if the address is deliberate.',
    ).toEqual([]);
  });

  it('carries no KNOWN entry that has stopped applying', () => {
    // Without this the table would only ever grow, and a row left behind after
    // its asset was corrected would silently pre-approve the SAME address
    // going stale again — an allowlist one edit away from being a mute button.
    expect(
      expired(sweep(), KNOWN),
      'These KNOWN entries no longer match anything — delete them.',
    ).toEqual([]);
  });

  it('lists every KNOWN entry with a reason', () => {
    expect(KNOWN.filter((entry) => entry.why.trim().length < 20)).toEqual([]);
  });

  it('lists each STALE row against the card that clears it', () => {
    // The STALE rows are the guard's own first-run findings, parked rather than
    // fixed here. Each has to name where it IS fixed, or "parked" quietly
    // becomes "accepted".
    const stale = KNOWN.filter((entry) => entry.why.startsWith('STALE'));
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.filter((entry) => !entry.why.includes('MOTIR-2340'))).toEqual([]);
  });
});

describe('the allowlist is checked in both directions', () => {
  const finding = (file: string, address: string): Finding => ({
    file,
    address,
    verdict: 'resolves-to-nothing',
    line: 7,
  });
  const entry = (file: string, address: string): Entry => ({ file, address, why: 'because' });

  it('reports a finding no row covers, with its file, line and verdict', () => {
    expect(unlisted([finding('design/a/notes.md', '/gone')], [])).toEqual([
      'design/a/notes.md:7 — /gone (resolves-to-nothing)',
    ]);
  });

  it('reports a row that matches nothing, so a corrected asset cannot keep its exemption', () => {
    expect(expired([], [entry('design/a/notes.md', '/gone')])).toEqual(['design/a/notes.md /gone']);
  });

  it('scopes a row to ONE asset — the same address going stale elsewhere still fails', () => {
    const rows = [entry('design/a/notes.md', '/gone')];
    expect(unlisted([finding('design/a/notes.md', '/gone')], rows)).toEqual([]);
    expect(unlisted([finding('design/b/notes.md', '/gone')], rows)).toEqual([
      'design/b/notes.md:7 — /gone (resolves-to-nothing)',
    ]);
  });
});

// ── The guard, seen failing ─────────────────────────────────────────────────
//
// A guard that has never been observed to fail is not evidence. These run the
// real extractor and the real classifier over the design asset's own pre-fix
// content — the `href`s and the route table `design/api-docs/` carried between
// Amendment 9 (2026-08-06) and its correction in MOTIR-2311 — and assert the
// sweep would have named them.
describe('the sweep catches the drift it was written for', () => {
  // Verbatim from `git show cfda1e99:design/api-docs/api-docs.mock.html` and
  // `:design/api-docs/design-notes.md`, the last revision before the fix.
  const STALE_MOCK_HTML = [
    '<a class="nav-current" href="/api-docs" aria-current="page">Docs</a>',
    '<a class="navrow is-active" href="/api-docs">API reference</a>',
    '<a class="navrow" href="/api-docs/getting-started">Getting started</a>',
    '<a class="navrow" href="/api-docs/stability">Stability &amp; deprecation</a>',
    '<a class="btn btn-sm btn-primary" href="/docs">API reference</a>',
  ].join('\n');

  const STALE_DESIGN_NOTES = [
    '| `/api-docs`                 | The API reference (catalogue + operation) | none (public) |',
    '| `/api-docs/getting-started` | The five-step guide                       | none (public) |',
    '| `/api-docs/stability`       | The stability & deprecation policy        | none (public) |',
    '',
    '### Panel 1 — `/api-docs`, the default view',
  ].join('\n');

  const verdicts = (source: string) =>
    [
      ...new Set(
        addressesIn(source)
          .map(({ raw }) => toPageAddress(raw))
          .filter((address): address is string => address !== null)
          .map((address) => `${address} ${classify(address) ?? 'ok'}`),
      ),
    ].sort();

  it('reports every address in the pre-fix mockup as redirecting away', () => {
    expect(verdicts(STALE_MOCK_HTML)).toEqual([
      '/api-docs redirects-away',
      '/api-docs/getting-started redirects-away',
      '/api-docs/stability redirects-away',
      '/docs redirects-away',
    ]);
  });

  it('reports the pre-fix route table in the design notes too', () => {
    expect(verdicts(STALE_DESIGN_NOTES)).toEqual([
      '/api-docs redirects-away',
      '/api-docs/getting-started redirects-away',
      '/api-docs/stability redirects-away',
    ]);
  });

  it('passes the corrected asset that shipped in its place', () => {
    const corrected = readFileSync(join(ROOT, 'design/api-docs/api-docs.mock.html'), 'utf8');
    const stillDead = addressesIn(corrected)
      .map(({ raw }) => toPageAddress(raw))
      .filter((address): address is string => address !== null)
      .filter((address) => classify(address) !== null);
    expect([...new Set(stillDead)]).toEqual([]);
  });

  it('accepts an address that a redirect POINTS AT, not just any /docs path', () => {
    expect(classify('/docs/api')).toBeNull();
    expect(classify('/docs/api/getting-started')).toBeNull();
    expect(classify('/docs/sandbox')).toBeNull();
  });
});
