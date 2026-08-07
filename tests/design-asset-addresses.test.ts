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
// Genuinely-stale addresses are NOT silenced here on the merits. This guard's
// first run found 17 of them; they were parked as STALE rows naming MOTIR-2340
// (per MOTIR-2316's scope boundary — running the guard IS the audit, and what
// it finds is its own card), and MOTIR-2340 then corrected the assets and
// deleted the rows. A stale address belongs in a fix, never in this table.
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
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/vantage/pulse-analytics',
    why: 'Forward-looking: same unbuilt /explore/<org>/<project> page.',
  },
  // ── Forward-looking: the MCP + CLI documentation assets ───────────────────
  //    `design/mcp-server/` (#1906, MOTIR-2323) and `design/cli-guide/`
  //    (#1905, MOTIR-2326) both merged AFTER this guard, so neither could add
  //    its rows and this table could not name assets that did not yet exist.
  //    The three PRs were in flight together, so each was green against a base
  //    that did not contain the other, and their composition is what turned
  //    `main` red — the same shape as two fixes that each pass alone.
  //
  //    That shape then repeated one level up: MOTIR-2348 (#1913) and
  //    MOTIR-2370 (#1916) diagnosed the same red `main` in parallel and both
  //    merged, so this table carried TWO rows for each of the eight pairs
  //    below until MOTIR-2372 deduped them. The uniqueness test further down
  //    is what stops that recurring; read it before adding a row.
  //
  //    ⚠️ Every row here is TEMPORARY and belongs to the card that BUILDS its
  //    route — `/docs/cli` to MOTIR-2308 (#1910), `/docs/mcp[/tools]` to
  //    MOTIR-2309 (#1911). `expired()` below fails on a listed pair that no
  //    longer fires, so that PR deletes its rows in the same commit that adds
  //    the route: the mechanism working, not a conflict. There is now exactly
  //    ONE row per pair, so deleting the rows you find is sufficient — before
  //    MOTIR-2372 it was not, and the copy left behind would have re-reddened
  //    `main` pointing at rows you believed you had removed.
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/docs/mcp',
    why: 'Forward-looking: the route this asset DRAWS. Built by MOTIR-2309, which deletes this row.',
  },
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/docs/mcp/tools',
    why: 'Forward-looking: the catalogue route this asset DRAWS. Built by MOTIR-2309, which deletes this row.',
  },
  {
    file: 'design/mcp-server/mcp-server.mock.html',
    address: '/docs/mcp',
    why: 'Forward-looking: the mock renders the address bar of the page it specifies. Built by MOTIR-2309, which deletes this row.',
  },
  {
    file: 'design/mcp-server/mcp-server.mock.html',
    address: '/docs/mcp/tools',
    why: 'Forward-looking: same unbuilt catalogue route, in the mock. Built by MOTIR-2309, which deletes this row.',
  },
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
  // (MOTIR-2316's first run parked 17 STALE pairs here — 13 assets addressing
  //  `/issues*` and `/login`. MOTIR-2340 corrected every one of them in the
  //  assets, so all 17 rows are gone: `expired()` below is what made correcting
  //  them the only way out, rather than re-approving them.)
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

/**
 * `KNOWN` pairs listed more than once. Neither test above can see a duplicate:
 * `unlisted()` matches findings against a `Set`, so the second row is a no-op,
 * and `expired()` only reports a row matching NOTHING, which a duplicate still
 * does. Uniqueness is the third axis, and it is the one a parallel merge
 * attacks — reported once per pair however many copies exist.
 */
function duplicated(known: Entry[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const id of known.map(idOf)) {
    if (seen.has(id)) twice.add(id);
    seen.add(id);
  }
  return [...twice].sort();
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

  it('lists each (asset, address) pair exactly once', () => {
    // MOTIR-2372. MOTIR-2348 (#1913) and MOTIR-2370 (#1916) diagnosed the same
    // red `main` in parallel and both merged, so the SAME eight pairs were
    // listed twice — invisible to both tests above, and green. Every one of
    // these rows exists to be DELETED by the card that builds its route, so a
    // second copy is a trap laid for that card: it removes the pair it finds,
    // the survivor stops matching, and `expired()` reddens `main` naming rows
    // that author believes they already removed.
    expect(
      duplicated(KNOWN),
      'These pairs are listed more than once — delete the extra copies, keeping the ' +
        'reason that reads best. A duplicate silences nothing today and reddens `main` ' +
        'the day the pair is cleared.',
    ).toEqual([]);
  });

  it('lists every KNOWN entry with a reason', () => {
    expect(KNOWN.filter((entry) => entry.why.trim().length < 20)).toEqual([]);
  });

  it('parks no finding as STALE without naming the card that clears it', () => {
    // MOTIR-2316 parked its own first-run findings here rather than fixing
    // them, and asserted each named where it WAS fixed — or "parked" quietly
    // becomes "accepted". MOTIR-2340 cleared all 17, so the table holds none
    // today; the rule outlives them, because parking the NEXT batch is the
    // same temptation. It no longer requires a STALE row to exist (that would
    // oblige the table to keep one forever) — only that any row calling itself
    // STALE cites a card.
    const stale = KNOWN.filter((entry) => entry.why.startsWith('STALE'));
    expect(stale.filter((entry) => !/MOTIR-\d+/.test(entry.why))).toEqual([]);
  });
});

describe('the allowlist is checked in both directions, and for uniqueness', () => {
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

  it('names a pair listed twice, so a parallel merge cannot double a row unseen', () => {
    const a = entry('design/a/notes.md', '/gone');
    expect(duplicated([a, a])).toEqual(['design/a/notes.md /gone']);
    // Reported ONCE per pair however many copies there are, and the reported
    // string is the pair itself — the same id `expired()` prints, so both
    // failures read the same way.
    expect(duplicated([a, a, a])).toEqual(['design/a/notes.md /gone']);
  });

  it('stays silent on rows that share only the file, or only the address', () => {
    const rows = [
      entry('design/a/notes.md', '/gone'),
      entry('design/a/notes.md', '/other'),
      entry('design/b/notes.md', '/gone'),
    ];
    expect(duplicated(rows)).toEqual([]);
    // Uniqueness is per PAIR, not per file or per address: one asset naming two
    // dead addresses, and two assets naming the same one, are both legitimate —
    // the second is exactly what the four /docs/mcp[/tools] rows are.
    expect(duplicated([])).toEqual([]);
  });

  it('the duplicate axis is the one the two tightness tests cannot see', () => {
    // The regression MOTIR-2372 cleaned up, in miniature: two rows for one
    // pair, matched by a single live finding. `unlisted()` is satisfied (the
    // finding is covered) and `expired()` is satisfied (both rows match), so
    // the table is green — while carrying a row that will outlive its pair.
    const a = entry('design/a/notes.md', '/gone');
    const findings = [finding('design/a/notes.md', '/gone')];
    expect(unlisted(findings, [a, a])).toEqual([]);
    expect(expired(findings, [a, a])).toEqual([]);
    expect(duplicated([a, a])).toEqual(['design/a/notes.md /gone']);
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
