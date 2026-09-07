import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-2306 — the shape-swap LINT guard, RADIUS axis.
//
// The sibling of `swapLayerLint.test.ts`, one axis over. That guard enforces
// "colour flows through `--el-*`, never Tier-0 `--color-*`"; this one enforces
// the SHAPE half of the same contract (motir-core/CLAUDE.md, "Shape (radius +
// spacing + sizing) flows through element-semantic shape tokens"): a surface's
// own radius must name one of the seven element-semantic ROLES —
// `--radius-{btn,card,input,modal,badge,control,kbd}` — because a `[data-style]`
// block overrides those and nothing else.
//
// ── Why this needs a guard and not a code review ────────────────────────────
// Measured on packages/design-system/theme.css: NINE of the TEN bare
// `[data-style]` token blocks also override the Tier-0 `--radius-xs/sm/md/lg/xl`
// scale. So a surface that escaped to `rounded-md` still *moves* when the style
// changes — it just moves to the container radius instead of the control radius.
// Only `soft-playful` leaves the generic scale alone, which is the single style
// where the seam is visible to the eye. A reviewer flipping styles sees the
// screen reshape and concludes it works. The escape is mechanically detectable
// and visually not, which is exactly the case a lint owns.
//
// ── WHAT THIS GUARD DOES NOT COVER ─────────────────────────────────────────
// Only a surface's own RADIUS. `CLAUDE.md`'s shape rule also covers a surface's
// own PADDING and HEIGHT, and this guard is deliberately silent on them — its
// silence is NOT permission. That axis is MOTIR-2335: it cannot be enforced yet
// because the token set has one value per role (`--spacing-card-padding` is
// 24px) while the code uses a scale against each (5 of 145 card surfaces are at
// 24px), so there is nothing correct to route the other 140 to until
// MOTIR-2336 decides a density scale. When it lands, the own-box check belongs
// in THIS file, beside the radius one.
//
// ── The own-box / layout distinction the shape rule turns on ────────────────
// A surface's OWN box — its radius, its own padding, its own height — is SHAPE
// and must flow through a token, because a style swap redefines how chrome is
// shaped. Spacing BETWEEN siblings — `gap-2`, a one-off `mb-1`, a page gutter —
// is LAYOUT and correctly stays raw: it describes composition, not the surface.
// Radius is unambiguously the first kind, which is the other reason this axis
// can be guarded today and the padding axis cannot.
//
// ── Why the check strips comments first ────────────────────────────────────
// Same reason as swapLayerLint (notes.html #195): migration comments quote the
// class they replaced ("was a raw `rounded-md`; routes through
// `--radius-control` now"), and a guard that had to be deleted on its first run
// because it matched its own paper trail would be worse than none. The scan
// strips block + line comments and asserts against CODE.

const REPO = process.cwd();

/**
 * Every TRACKED source file that can put a shaped surface on screen. The same
 * set `swapLayerLint` scans, and for the same reason: the contract is not
 * "components are clean", it is "nothing shapes past the layer".
 */
function renderedSources(): string[] {
  return execFileSync(
    'git',
    [
      'ls-files',
      'components/*.tsx',
      'components/**/*.tsx',
      'components/**/*.ts',
      'app/**/*.tsx',
      'app/**/*.ts',
      'lib/**/*.tsx',
      'lib/**/*.ts',
      'packages/design-system/src/**/*.tsx',
      'packages/design-system/src/**/*.ts',
    ],
    { cwd: REPO, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

/** Drop block comments and line comments, keeping `https://` intact. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * A radius utility that does NOT route through the swap layer.
 *
 * Matches `rounded`, `rounded-md`, `rounded-t-lg`, `rounded-(--radius-sm)`,
 * `rounded-[6px]` — anything whose suffix is not an element-semantic role.
 * Two suffixes pass:
 *   • `-full` / `(--radius-pill)` — a genuinely circular thing (spinner, avatar,
 *     status dot, switch track) is not style-dependent; CLAUDE.md says so.
 *   • `(--radius-{btn,card,input,modal,badge,control,kbd})` — the roles a
 *     `[data-style]` block actually overrides.
 * A bare `rounded` (no suffix at all) is Tailwind's 0.25rem default and is
 * flagged: it is the quietest form of the same escape.
 */
const ROLES = ['btn', 'card', 'input', 'modal', 'badge', 'control', 'kbd', 'pill'];

/**
 * Any radius utility at all, with its corner scope and its value split out:
 * `rounded` · `rounded-md` · `rounded-t-(--radius-card)` · `rounded-[6px]`.
 *
 * The match is deliberately permissive and the VERDICT is taken in code below.
 * Encoding "…but not a semantic role" as a negative lookahead inside the pattern
 * looks equivalent and is not: on `rounded-t-(--radius-card)` the engine
 * backtracks out of the corner group and re-reads the whole tail as an opaque
 * suffix, flagging a correct usage. The negative-control test below is what
 * caught that; keep the split.
 */
const RADIUS_UTIL = new RegExp(
  `(?<=^|[\\s"'\`])rounded(?:-(?:[trbl][lr]?|[se]{1,2}))?(?:-(\\(--radius-[a-z0-9-]+\\)|\\[[^\\]]*\\]|[a-z0-9]+))?(?=$|[\\s"'\`])`,
  'g',
);

/** Does this radius utility's value reach the swap layer? */
function reachesSwapLayer(value: string | undefined): boolean {
  if (value === undefined) return false; // bare `rounded` — Tailwind's 0.25rem default
  if (value === 'full') return true; // a genuine circle is not style-dependent
  const role = /^\(--radius-([a-z-]+)\)$/.exec(value);
  return role !== null && ROLES.includes(role[1]!);
}

/**
 * A line is CLASS CONTEXT when it carries at least one unambiguous utility.
 *
 * Needed because `rounded` is also an English word, and the style registry
 * describes its own styles in prose — "Soft, rounded glass tiles", "Pill buttons
 * (fully rounded)". Those lines carry no utility class, so they are skipped;
 * every real `className` line carries several. Scanning per LINE rather than per
 * string literal also keeps multi-line template literals in view.
 */
const CLASS_CONTEXT =
  /(?:^|[\s"'`{])(?:flex|inline-flex|grid|block|inline-block|absolute|relative|fixed|sticky|border|truncate|shadow-|(?:bg|text|border|ring|fill|stroke|divide)-\(--|(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|w|h|size|min-w|max-w|min-h|max-h)-[\d.]|hover:|focus|group|shrink-|grow|items-|justify-|overflow-|animate-|cursor-|select-|transition|rounded-\(--radius-)/;

const SOURCES = renderedSources();

/** Every `file → token` pair whose radius does not reach the swap layer. */
function inertRadiusOffenders(): string[] {
  const found = new Set<string>();
  for (const file of SOURCES) {
    const source = stripComments(readFileSync(join(REPO, file), 'utf8'));
    for (const line of source.split('\n')) {
      if (!CLASS_CONTEXT.test(line)) continue;
      for (const match of line.matchAll(RADIUS_UTIL)) {
        if (!reachesSwapLayer(match[1])) found.add(`${file} → ${match[0]}`);
      }
    }
  }
  return [...found].sort();
}

describe('shape-swap lint — no surface shapes its radius past the token layer', () => {
  it('scans a real, non-empty set of rendered sources', () => {
    // notes.html #195: the guard has to be the search that was actually run.
    expect(SOURCES.length).toBeGreaterThan(1000);
    expect(SOURCES).toContain('components/issues/StatusPicker.tsx');
    expect(SOURCES).toContain('packages/design-system/src/components/ui/Pill.tsx');
    expect(SOURCES).toContain('app/(authed)/items/[key]/_components/ChildList.tsx');
  });

  it('names an element-semantic radius role everywhere outside the documented exceptions', () => {
    // The `/tokens` specimen route is exempt as a DIRECTORY, not file-by-file —
    // the same exemption swapLayerLint grants it for `--color-*`, and for the
    // same reason: its whole job is to render the Tier-0 scale as labelled
    // swatches, inside mock chrome built from Tier-0 utilities. Listing its
    // current radii instead would go stale the day a swatch is added.
    const ALLOWED_PREFIXES = ['app/tokens/'];

    // Entries are `file → token`, not bare filenames, so a NEW escape in a file
    // that already has a documented one cannot hide behind it.
    const ALLOWED = [
      // A PICTOGRAM, not a surface. These are the 4px-wide bars that draw the
      // column-count icon inside the layout picker; the BUTTON around them
      // already uses `--radius-control`. A 1px nub on a 4px bar is icon
      // geometry — routing it to the 6px control radius would round it into a
      // pill and destroy the glyph. Icons do not reshape with the style.
      'app/(authed)/dashboard/_components/DashboardGrid.tsx → rounded-[1px]',
      // Deliberately NO shape: the attachment lightbox passes this to `Modal`
      // to strip the panel's entire chrome (`rounded-none border-0
      // bg-transparent p-0 shadow-none`) so the image floats on a bare overlay.
      // There is no surface left to shape, and `--radius-modal` would put a
      // corner on a transparent stage. The neighbouring `border-0` /
      // `shadow-none` are the same override in the other axes.
      'app/(authed)/items/[key]/_components/AttachmentPreview.tsx → rounded-none',
      // The same case, one surface over (MOTIR-3895): the RUN MODAL is a
      // `size="full"` dialog, so it IS the viewport. `--radius-modal` would draw
      // a corner where the screen's own edge is, and the panel border it pairs
      // with would frame the whole display. `border-0` beside it is that same
      // override in the other axis, exactly as the lightbox's is.
      'app/(authed)/runs/_components/RunModal.tsx → rounded-none',
      // And the same case once more (MOTIR-4729): the planning workspace is a
      // `size="full"` dialog too, and for the same reason — an OVERLAY covers the
      // screen it opens over, so the panel IS the viewport and its corner is the
      // display's own. The design measured it edge to edge (0px radius, 0px
      // border) precisely so nothing draws a frame around the page underneath;
      // `border-0 p-0` beside it are that decision in the other axes.
      'components/planning/PlanningWorkspaceOverlay.tsx → rounded-none',
      // A value DERIVED from a semantic token: the inner pill of a segmented
      // control fits its shell only at `--radius-btn` minus the shell's 2px
      // border, and `calc()` over the role token is how that stays true under
      // every style. This SWAPS correctly — it is the rule being followed, not
      // escaped, and there is no role token for "the inside of a segment".
      'packages/design-system/src/components/theme/AppearancePickers.tsx → rounded-[calc(var(--radius-btn)-2px)]',
      'packages/design-system/src/components/ui/Segmented.tsx → rounded-[calc(var(--radius-btn)-2px)]',
    ];

    const offenders = inertRadiusOffenders().filter(
      (entry) => !ALLOWED_PREFIXES.some((prefix) => entry.startsWith(prefix)),
    );
    expect(offenders).toEqual([...ALLOWED].sort());

    // The prefix must still be earning its keep — if `/tokens` ever stops
    // rendering Tier-0 radii, delete the exemption rather than leave it standing.
    expect(SOURCES.some((file) => file.startsWith('app/tokens/'))).toBe(true);
  });

  it('recognises the semantic roles and rejects the inert forms (the guard, negative-controlled)', () => {
    const flag = (line: string) =>
      CLASS_CONTEXT.test(line)
        ? [...line.matchAll(RADIUS_UTIL)].filter((m) => !reachesSwapLayer(m[1])).map((m) => m[0])
        : [];

    // The seven roles a [data-style] block overrides, plus circles, all pass.
    for (const role of ['btn', 'card', 'input', 'modal', 'badge', 'control', 'kbd', 'pill']) {
      expect(flag(`flex items-center rounded-(--radius-${role}) px-2`)).toEqual([]);
    }
    expect(flag('flex h-2 w-2 rounded-full bg-(--el-accent)')).toEqual([]);
    expect(flag('flex rounded-t-(--radius-card) border')).toEqual([]);

    // Every inert form is caught, including the bare and the corner-scoped ones.
    expect(flag('flex items-center rounded-md px-2')).toEqual(['rounded-md']);
    expect(flag('flex items-center rounded px-2')).toEqual(['rounded']);
    expect(flag('flex rounded-(--radius-sm) border')).toEqual(['rounded-(--radius-sm)']);
    expect(flag('flex rounded-t-lg border')).toEqual(['rounded-t-lg']);
    expect(flag('flex rounded-[6px] border')).toEqual(['rounded-[6px]']);
    expect(flag('flex rounded-none border')).toEqual(['rounded-none']);

    // Prose is not code: the style registry describes its own styles in English
    // and must not be flagged for saying the word.
    expect(flag('tagline: "More energy — rounded, generous, gently animated."')).toEqual([]);
    expect(flag('silhouette: "Pill buttons (fully rounded) and large 24px card radii."')).toEqual(
      [],
    );
  });
});

describe('shape-swap lint — the roles exist and every style actually flips them', () => {
  const THEME = readFileSync(join(REPO, 'packages/design-system/theme.css'), 'utf8');
  const ROLE_TOKENS = ['btn', 'card', 'input', 'modal', 'badge', 'control', 'kbd'];

  it('defines every element-semantic radius role in the @theme base', () => {
    for (const role of ROLE_TOKENS) {
      expect(THEME).toMatch(new RegExp(`--radius-${role}\\s*:`));
    }
  });

  it('overrides every role in every bare [data-style] token block', () => {
    // This is the invariant the whole axis rests on: a role a style forgets to
    // redefine does not flip, so a component that obeyed the rule still looks
    // unstyled. Descendant-selector blocks (`[data-style='x'] [data-surface=…]`,
    // the glassmorphism/aurora material layer) are not token blocks and are
    // excluded — see CLAUDE.md's surface-material exception.
    const blocks = [...THEME.matchAll(/\[data-style='([a-z0-9-]+)'\]\s*\{([\s\S]*?)\n\}/g)];
    expect(blocks.length).toBeGreaterThan(5);

    for (const block of blocks) {
      const style = block[1]!;
      const body = block[2]!;
      const missing = ROLE_TOKENS.filter((role) => !new RegExp(`--radius-${role}\\s*:`).test(body));
      expect({ style, missing }).toEqual({ style, missing: [] });
    }
  });
});
