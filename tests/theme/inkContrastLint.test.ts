import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DANGER_TOKEN,
  FAINT_CLASS,
  MUTED_CLASS,
  SAFE_SURFACE_TOKENS,
  SAFE_SURFACE_VALUES,
  TINTED_SURFACE_TOKENS,
  TINTED_SURFACE_VALUES,
  formatFinding,
  scanSource,
  violations,
} from './inkContrastScan';
import { contrast, deltaE2000, flattenColorMix } from './colorMetrics';
import { loadTokenLayer, resolveToken } from './paletteCascade';

/** The ink every swept danger site was sent to — MOTIR-3663. */
const DANGER_INK = '--el-danger-on-surface';

/** The accent used AS TEXT on a surface, rather than as a fill — MOTIR-3745. */
const ACCENT_INK = '--el-accent-on-surface';
const ACCENT_CLASS = `text-(${ACCENT_INK})`;

/**
 * The accent family's own tint — the ONE tinted surface the tree deliberately
 * pairs the accent ink with. Named here because the pairing is guarded below.
 */
const ACCENT_TINT = '--el-tint-lavender';

/** The base palette, which ships no `[data-palette]` block of its own. */
const BASE_PALETTE = 'motir';

// MOTIR-2475 / MOTIR-2477 — the repo-wide INK-CONTRAST guard, pointed at the
// tree by the two sweeps that made it passable: the faint arm below is
// MOTIR-2475's, the muted arm MOTIR-2477's.
//
// MOTIR-2455 measured `--el-text-faint` at 2.37–2.61:1 on all four surfaces in
// both themes: it clears AA on none of them. That leaves it exactly two
// legitimate jobs — a decorative glyph whose meaning lives in a label, and
// disabled / inactive text, which WCAG 1.4.3 exempts. Both are STRUCTURE, which
// is why the check is the MOTIR-2459 parser rather than a grep: the parser sees
// the element the class lands on and can say which of the three cases it is.
//
// ── Why this guard has no allowlist ─────────────────────────────────────────
// `swapLayerLint` (the mould this follows) enumerates its exceptions, because
// a Tier-0 hex in an email template is genuinely correct and there is nowhere
// else to put it. Here there is no such case: every faint site is either text,
// which takes `--el-text-secondary` (6.18–6.80:1 everywhere, in both themes),
// or a glyph, which is fixed by SAYING SO on the element — `aria-hidden`, or a
// labelled `role="img"`. Both fixes cost one edit, so an exemption would only
// ever be a defect with a comment attached. A file-scoped escape hatch is also
// what would make the rule optional: the sweep covered the whole tree at once
// precisely so that nobody has to wonder whether their surface is in scope.
//
// ── The MUTED arm, and the half of the tree it CANNOT rule on ───────────────
// MOTIR-2477 swept the 130 muted findings that stood here and turned its arm
// on. That ink is a different shape of defect: `--el-text-muted` is 4.54:1 on
// the white page/card — legal, by 0.04 — and 4.12–4.34:1 on `--el-surface`,
// `--el-surface-soft` and `--el-muted`. No site is a defect on its own; the
// verdict is a property of the ink AND the background under it.
//
// ⚠️ SO THIS ARM'S GREEN IS NARROWER THAN THE FAINT ARM'S, and the difference is
// structural, not a backlog item. The remaining boundary is the CROSS-MODULE one
// and nothing else: an element whose background is painted by a `<Card>`, a
// `<Popover.Content>` or a layout in ANOTHER module reads as "no surface found
// here" and the rule ABSTAINS — it does not rule the site safe, it declines to
// rule at all. Resolving that needs the import graph, which this walk does not
// build. So a green muted arm means "no muted ink over a tint THIS MODULE can
// prove", never "no muted ink over a tint".
//
// ── How that boundary got to be the only one (MOTIR-3523 · MOTIR-3711) ──────
// HISTORY, not a live caveat. This note used to draw the fence at the FILE and
// the walk actually stopped one step short of it, at the root of the COMPONENT
// the ink is written in: a file writing the ink in a local `Th` and painting the
// tint on the `<thead>` that USES it abstained, with both halves in one AST.
// Sixteen sites lived in the gap between the two fences — eight column labels at
// 4.17:1 on the operator jobs dashboard (MOTIR-3523), and eight more across the
// swimlane board, the filters directory, billing, the board-config editor and
// both planning review surfaces (MOTIR-3711) — every one of them under a green
// lint, and every reader who checked the note concluded correctly that their
// site was out of reach.
//
// MOTIR-3523 built the second walk (`surfacesAtUseSites`) and left it behind an
// opt-in flag; MOTIR-3711 swept the eight sites it reported and removed the flag
// in the same change. The split existed only to keep the sweep and the switch in
// one pull request, which is the ordering this repo has twice paid for getting
// wrong (MOTIR-2496 — two widened-ink PRs merged 37 seconds apart, each green on
// its own base, their composition red). There is no longer a switch: `scanSource`
// resolves use sites unconditionally, and `inkContrastScan.test.ts` pins what it
// still declines to resolve — an exported component with no local use site, and a
// nested helper, where the innermost enclosing function decides.
//
// The general lesson is the one worth carrying past this arm: a guard's stated
// boundary is a claim about the guard, and it decays exactly like any other
// claim in a comment. This one read as wider than it was for the whole life of a
// file — including through the reviews that looked straight at the failing
// header.
//
// Two narrower edges of the same boundary, for whoever widens this later:
//   • A CONDITIONAL background (`selected && 'bg-(--el-surface-soft)'`) reads as
//     tinted for every branch, because the surface lookup matches the className
//     blob and cannot correlate a branch with the ink beside it. That direction
//     over-reports, which is the safe way to be wrong; MOTIR-2477 fixed those
//     sites rather than teaching the walk to correlate.
//   • The walk stops at the first ancestor that paints ANY background, so a
//     white `--el-card` nested inside a tinted panel correctly ends the search.
//   • The SAFE half of that walk is deliberately stricter than the tinted half:
//     it matches only an UNPREFIXED `bg-(--el-card|--el-page-bg)`, because a
//     `hover:` white paints the element in one render and the tint in every
//     other, and clearing the ink on that basis would be a false NEGATIVE
//     (MOTIR-2497). Over-reporting a conditional TINT stays the safe way to be
//     wrong; under-reporting a conditional WHITE is not.
//   • A USE-SITE surface is taken from the caller in THIS module, one hop, and a
//     use site whose own surface is unresolved is not chased through a second
//     component. Where the caller hands the element to a PORTAL that repaints
//     the surface elsewhere — `Popover.Content` is `bg-(--el-page-bg)` — the hop
//     reports the caller's tint and is over-reporting again, on the safe side.
//     `BoardConfigEditor.tsx`'s add-status menu is the standing instance and
//     says so at the line (MOTIR-3711).
// Widening the surface resolution across module boundaries needs the import
// graph, not this walk. (MOTIR-2489 was the card on the scanner's element
// resolution — a different axis from this one, and closed since; a citation of
// it as "the open card" is stale.)

const REPO = process.cwd();

/**
 * Every TRACKED source file that can put ink on screen. The same four roots
 * `swapLayerLint` scans, for the same reason: the contract is not "components
 * are clean", it is "nothing paints unreadable text anywhere".
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

const SOURCES = renderedSources();

/**
 * Every scanned file's text, read ONCE. Both describes below need it, and a
 * second `readFileSync` pass over 1703 files is pure cost.
 */
const TEXT_BY_FILE = new Map(SOURCES.map((file) => [file, readFileSync(join(REPO, file), 'utf8')]));

/**
 * The files worth PARSING, per ink. `scanSource` can only report a finding for
 * a file whose text contains the class, so a substring pre-filter is not a
 * sampling of the tree — it is the same answer without building 1600 ASTs that
 * cannot produce one. It matters: parsing every file took the whole 15s test
 * budget on a loaded CI shard, and a guard that times out is a guard that
 * teaches people to rerun it.
 *
 * The two arms carry SEPARATE sets rather than one union: each arm's file set
 * is what its own "reads files that carry the ink" check proves, and a union
 * would let a muted-only tree satisfy the faint check (and the reverse).
 */
const FAINT_CARRIERS = SOURCES.filter((file) => TEXT_BY_FILE.get(file)!.includes(FAINT_CLASS));
const MUTED_CARRIERS = SOURCES.filter((file) => TEXT_BY_FILE.get(file)!.includes(MUTED_CLASS));
/**
 * The danger arm's pre-filter keys on the bare TOKEN, not on a class — the arm
 * rules on an inline `style` and on a `cva` variants string as well as on a
 * utility, and a class-shaped filter would drop both file sets before the
 * parser ever saw them (MOTIR-3663).
 */
const DANGER_CARRIERS = SOURCES.filter((file) => TEXT_BY_FILE.get(file)!.includes(DANGER_TOKEN));
/**
 * The ACCENT arm's carriers. Keyed on the TEXT class rather than on the bare
 * token: `--el-accent-on-surface` is also written as `border-(…)` and as a
 * `ring-(…)`, and a border is a GRAPHIC — WCAG 1.4.11 asks 3:1 of it, not the
 * 4.5:1 this arm measures. Keying on the token would put those sites inside a
 * text assertion they were never subject to.
 */
const ACCENT_CARRIERS = SOURCES.filter((file) => TEXT_BY_FILE.get(file)!.includes(ACCENT_CLASS));

describe('ink-contrast lint — the scanned set is the set that was searched', () => {
  // notes.html #195: a guard is only worth what its file set is. A `ls-files`
  // glob that silently matches nothing reports a clean tree, which is the one
  // failure mode this check exists to make impossible — so each ROOT has to
  // prove it is present, not just the total.
  it('scans a real, non-empty set of rendered sources', () => {
    expect(SOURCES.length).toBeGreaterThan(1000);
  });

  it.each([
    ['app', 'app/(authed)/backlog/_components/BacklogRow.tsx'],
    ['components', 'components/issues/EstimateBadge.tsx'],
    ['lib', 'lib/workflows/statusColor.ts'],
    ['packages/design-system/src', 'packages/design-system/src/components/ui/Segmented.tsx'],
  ])('reaches into %s', (_root, file) => {
    expect(SOURCES).toContain(file);
  });

  it.each([
    ['--el-text-faint', FAINT_CARRIERS],
    ['--el-text-muted', MUTED_CARRIERS],
    ['--el-danger-text', DANGER_CARRIERS],
    ['--el-accent-on-surface', ACCENT_CARRIERS],
  ])('reads files that actually carry %s', (_ink, carriers) => {
    // The counterpart to the check above: a file set can be real and still be
    // the wrong one. If NOTHING in the scanned tree mentions the token, the
    // guard is watching a tree the ink does not live in — and the pre-filter
    // below would then make it pass by scanning nothing at all. Asserted per
    // INK, because the muted arm survives a sweep that empties the tree of the
    // faint one and would otherwise inherit its proof.
    expect(carriers.length).toBeGreaterThan(0);
  });
});

const THEME_CSS = readFileSync(join(REPO, 'packages/design-system/theme.css'), 'utf8');

/**
 * Every `--el-*: <value>;` declaration in the token layer, name → values,
 * with ALL WHITESPACE COLLAPSED OUT of the value.
 *
 * ⚠️ The collapse is load-bearing, and it was missing (MOTIR-3693). Prettier
 * wraps a long declaration, so `--el-sidebar-item-bg-active` is written across
 * three lines and this map used to record it as
 * `var(\n    --color-background\n  )` — which is not the string
 * `var(--color-background)`, so the token never joined `WHITE_TOKENS` and the
 * check below could not report it missing. A derivation written to stop a list
 * being a list of SPELLINGS was matching on a spelling itself.
 */
const DECLARED = new Map<string, Set<string>>();
for (const [, name, value] of THEME_CSS.matchAll(/(--el-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  const values = DECLARED.get(name!) ?? new Set<string>();
  values.add(value!.replace(/\s+/g, ''));
  DECLARED.set(name!, values);
}

describe('ink-contrast lint — the SAFE surface set is derived from the token table', () => {
  // MOTIR-2497. The muted arm's verdict is "is this background the white
  // page/card?", and the scanner answers it from a LIST OF TOKEN NAMES. That
  // list started as one name while the colour had two — `--el-page-bg` and
  // `--el-card` are both `var(--color-background)` — so an element painting the
  // second spelling was walked past and its ink attributed to a tint further up.
  //
  // The list is only as good as the fact underneath it, which lives in
  // `theme.css`, so this check reads it back from there in BOTH directions: no
  // white background may be missing from the safe set, and nothing in the safe
  // set may have stopped being white. A third alias then cannot reopen the hole
  // by being added quietly — it fails here, on the day it is first used.
  //
  // What this cannot reach, for whoever widens it: a background painted from a
  // stylesheet rather than a `bg-(--el-…)` class. The scanner never opens a
  // `.css` file (see the JSX-only premise at the top of `inkContrastScan.ts`),
  // so a token used only there is outside both the guard and this derivation.
  /** The `--el-*` names that resolve to the untinted page white. */
  const WHITE_TOKENS = [...DECLARED]
    .filter(([, values]) => values.size === 1 && SAFE_SURFACE_VALUES.includes([...values][0]!))
    .map(([name]) => name);

  /** …of those, the ones the tree actually uses AS A BACKGROUND. */
  const WHITE_BACKGROUNDS = WHITE_TOKENS.filter((token) =>
    SOURCES.some((file) => TEXT_BY_FILE.get(file)!.includes(`bg-(${token})`)),
  );

  it('reads a real token table — the declarations are there to be checked', () => {
    // The counterpart to notes.html #195 one layer down: a regex that matched
    // nothing would make every assertion below vacuously true.
    expect(DECLARED.size).toBeGreaterThan(100);
    expect(WHITE_BACKGROUNDS.length).toBeGreaterThan(1);
  });

  it('names every --el-* background that resolves to --color-background', () => {
    expect(
      WHITE_BACKGROUNDS.filter((token) => !SAFE_SURFACE_TOKENS.includes(token)).join(', '),
      'These `--el-*` tokens are `var(--color-background)` — the same white as ' +
        `${SAFE_SURFACE_TOKENS.join(' and ')} — and the tree paints backgrounds with them. ` +
        'Add each to `SAFE_SURFACE_TOKENS` in `inkContrastScan.ts`, or the surface walk will ' +
        'sail past an element that already paints white and attribute its ink to a tint ' +
        'further up (MOTIR-2497).',
    ).toBe('');
  });

  it('holds nothing in the safe set that has stopped being that white', () => {
    // The other direction. A token retargeted to a tint would otherwise keep
    // clearing muted ink that now genuinely fails on it.
    expect(
      SAFE_SURFACE_TOKENS.filter((token) => !WHITE_TOKENS.includes(token)).join(', '),
      'These are treated as the safe white surface by `inkContrastScan.ts` but are no longer ' +
        'declared `var(--color-background)` in `theme.css`. Re-measure the pair before ' +
        'deciding which side to change.',
    ).toBe('');
  });
});

describe('ink-contrast lint — the TINTED surface set is derived from the token table', () => {
  // MOTIR-3693, and the exact counterpart of the describe above — written three
  // months later because the two halves of one question were modelled
  // differently. MOTIR-2497 derived the SAFE list from `theme.css` and left the
  // TINTED one three hand-written names, on the arm where being wrong is
  // SILENT: a missing safe alias over-reports and someone argues with it, a
  // missing tinted alias reports nothing and reads as a clean tree.
  //
  // `--el-sidebar-bg` is `var(--color-surface)` — the identical `#f6f5f4` as
  // `--el-surface` — and was on neither guard's list. Every ink on the rail was
  // unmeasured: 242 sub-AA pairs across 18 design assets, plus the docs
  // catalogue's empty state, for as long as the rail has existed. Twelve more
  // `--el-*` names resolve to one of the three measured tints and were equally
  // invisible.
  //
  // The membership rule differs from the safe set's ON PURPOSE. That one is
  // filtered to tokens the tree actually paints with, because listing a
  // surface as safe CLEARS ink and narrowness is the conservative direction.
  // Here it inverts: listing a tint REPORTS, over-reporting is what this guard
  // already calls the safe way to be wrong, and a usage filter would mean a
  // token becomes measured only once somebody paints with it — i.e. exactly one
  // asset too late. So the list is total over the token table, unconditionally.
  const TINTED_TOKENS = [...DECLARED]
    .filter(([, values]) => [...values].every((value) => TINTED_SURFACE_VALUES.includes(value)))
    .map(([name]) => name);

  it('reads a real token table — the tinted declarations are there to be checked', () => {
    // The counterpart to notes.html #195, as above: a regex that matched
    // nothing would make both assertions below vacuously true, which is the
    // failure mode this whole describe exists to remove.
    expect(TINTED_TOKENS.length).toBeGreaterThan(3);
    expect(TINTED_TOKENS).toContain('--el-surface');
  });

  it('names every --el-* that resolves to one of the measured tints', () => {
    expect(
      TINTED_TOKENS.filter((token) => !TINTED_SURFACE_TOKENS.includes(token)).join(', '),
      'These `--el-*` tokens resolve to one of `TINTED_SURFACE_VALUES` — the three fills ' +
        'MOTIR-2455 measured `--el-text-muted` at 4.12–4.34:1 on — so text on them fails AA ' +
        'exactly as it does on `--el-surface`. Add each to `TINTED_SURFACE_TOKENS` in ' +
        '`inkContrastScan.ts` (both guards read it from there), or the surface walk will ' +
        'resolve a background it has no verdict for and report nothing (MOTIR-3693).',
    ).toBe('');
  });

  it('holds nothing in the tinted set that has stopped being one of those fills', () => {
    // The other direction, and the one that catches a RETARGET: a token moved
    // onto the page white would otherwise keep failing ink that now clears on
    // it — a false positive whose cheapest fix is to swap the token for its
    // twin, which changes no pixels and leaves a colour chosen for a parser.
    expect(
      TINTED_SURFACE_TOKENS.filter((token) => !TINTED_TOKENS.includes(token)).join(', '),
      'These are treated as a tinted surface by `inkContrastScan.ts` but no longer resolve ' +
        'to one of `TINTED_SURFACE_VALUES` in `theme.css`. Re-measure the pair before ' +
        'deciding which side to change.',
    ).toBe('');
  });
});

describe('ink-contrast lint — --el-text-faint carries no active informational text', () => {
  it('leaves no faint violation anywhere in the scanned tree', () => {
    // Derived over the scanned set, never compared to a frozen count: the sweep
    // that made this pass measured 132 defects, and writing 132 down here would
    // turn every new file into a reason to edit the assertion.
    const offenders = FAINT_CARRIERS.flatMap((file) =>
      violations(scanSource(file, TEXT_BY_FILE.get(file)!)),
    ).filter((finding) => finding.ink === 'faint');

    expect(
      offenders.map(formatFinding).join('\n'),
      'Every one of these paints text at 2.37–2.61:1. Give it `--el-text-secondary` ' +
        '(6.18–6.80:1 on every surface, both themes); if the element is really a glyph, ' +
        'say so with `aria-hidden` or a labelled `role="img"` and the guard will agree.',
    ).toBe('');
  });
});

describe('ink-contrast lint — --el-text-muted carries no text over a TINTED surface', () => {
  it('leaves no muted violation the scanner can resolve a surface for', () => {
    // Derived over the scanned set, never compared to a frozen count: the sweep
    // that made this pass measured 130 defects across 75 files, and the one that
    // widened it to use-site surfaces 8 more across 6 (MOTIR-3711). Writing
    // either number down here would turn every new file into a reason to edit
    // the assertion.
    //
    // Read the name of this test literally. It is "no violation the scanner can
    // resolve a surface for", not "no violation" — the abstention documented at
    // the top of this file is the whole difference, and a rename that drops it
    // would be claiming coverage this arm does not have.
    const offenders = MUTED_CARRIERS.flatMap((file) =>
      violations(scanSource(file, TEXT_BY_FILE.get(file)!)),
    ).filter((finding) => finding.ink === 'muted');

    expect(
      offenders.map(formatFinding).join('\n'),
      '`--el-text-muted` clears AA on the white page/card by 0.04 and fails on every tint ' +
        '(4.12–4.34:1). Give each of these `--el-text-secondary`, which is 6.18–6.80:1 on all ' +
        'four surfaces in both themes and so is right whichever surface the element lands on. ' +
        'Moving the element onto `--el-card` also fixes the pair, but it changes layout intent — ' +
        'reach for the ink first.',
    ).toBe('');
  });
});

describe('ink-contrast lint — --el-danger-text carries ink ONLY on a danger fill', () => {
  // MOTIR-3663. The third arm, and the cheapest of the three to state: the
  // other two ask "is this ink legal on THAT background", which needs a surface
  // walk and a measured table. This one asks "is the fill this ink exists for
  // actually under it", which is one lexical test, because no other background
  // makes the pairing legal.
  //
  // MOTIR-1553 fixed exactly this defect at two row menus in June and wrote the
  // rest of the sweep down in its own body as "worth auditing" — a deferral
  // with no card behind it, which is the same as no deferral. Fourteen months
  // and fourteen sites later, three of them `role="alert"`, this arm is what
  // replaces the sentence. Note what the tree looked like in between: three
  // OTHER sites carry comments correctly warning about this bug, so the
  // knowledge was present, distributed, and load-bearing nowhere — which is the
  // argument for a guard over a sweep, and the reason this arm exists at all
  // rather than a second round of edits.
  it('leaves no danger violation anywhere in the scanned tree', () => {
    const offenders = DANGER_CARRIERS.flatMap((file) =>
      violations(scanSource(file, TEXT_BY_FILE.get(file)!)),
    ).filter((finding) => finding.ink === 'danger');

    expect(
      offenders.map(formatFinding).join('\n'),
      '`--el-danger-text` is `--color-destructive-foreground` — the ink FOR a bright danger ' +
        'fill, which every palette defines as whatever contrasts with that fill. On a page it ' +
        'is 1.00:1 in the light theme of ALL TEN palettes and 1.00:1 in six of the ten dark ' +
        'ones; in the other four it renders near-white, so the danger SIGNAL is lost rather ' +
        'than the text. Give each of these `--el-danger-on-surface`, which is AA on every ' +
        'surface in all 20 palette × theme combinations (the table below). Its ONE legal use ' +
        'is `bg-(--el-danger) text-(--el-danger-text)` — the Button danger variant.',
    ).toBe('');
  });
});

/**
 * The AA bar for normal-size text (WCAG 1.4.3). Shared by the two MEASURED
 * arms below — danger and accent — which ask the same question of two inks.
 */
const AA = 4.5;

const { rules: TOKEN_RULES } = loadTokenLayer();

/** One `--el-*` token's concrete colour under one palette × theme. */
const resolve = (palette: string, theme: 'light' | 'dark', token: string) =>
  flattenColorMix(resolveToken(TOKEN_RULES, { palette, theme }, token).value);

/**
 * The palettes, READ OUT OF `theme.css` rather than imported from
 * `@/lib/theme/palettes`.
 *
 * ⚠️ Not a stylistic preference — a lane constraint. `lib/theme/palettes.ts`
 * re-exports `@motir/design-system`, and the `structural-guards` CI job
 * installs without building that package (`ci.yml` — `pnpm install` then
 * `pnpm test:guards`, no `--filter @motir/design-system build`). Importing it
 * here resolves locally, where a build has usually happened, and fails the
 * lane on a clean runner with "Failed to resolve entry for package".
 *
 * Reading the stylesheet is also the more honest source for THIS assertion:
 * the thing being measured is what `theme.css` declares, so the matrix and
 * the values come from one file and cannot drift apart.
 */
const PALETTES = [
  BASE_PALETTE,
  ...new Set(
    [...loadTokenLayer().css.matchAll(/\[data-palette=['"]([a-z0-9-]+)['"]\]/g)].map(
      (match) => match[1]!,
    ),
  ),
].filter((palette, index, all) => all.indexOf(palette) === index);

const PAIRS = PALETTES.flatMap((palette) =>
  (['light', 'dark'] as const).map((theme) => ({ palette, theme })),
);

describe('ink-contrast lint — --el-danger-on-surface is AA in all 20 palette × theme pairs', () => {
  // MOTIR-3663. The replacement the arm above sends every site to, measured
  // rather than asserted once — and measured HERE rather than in a comment,
  // because the numbers depend on values ten palettes are free to change.
  //
  // ⚠️ The reason this is a computed table and not a spot check: the defect it
  // replaces was invisible for fourteen months precisely because the DEFAULT
  // palette is one of the four where the ink renders (near-white, wrong, but
  // rendering). Checking the palette you happen to be looking at is what let
  // that stand. So the assertion is total over `PALETTE_IDS` — a new palette is
  // covered on the day it is added, not on the day somebody remembers to
  // extend a list.
  //
  // The surfaces are every background a danger message actually lands on in
  // this tree, which is wider than the grey arms' four: the swept sites sit on
  // the page, on `--el-surface`, on `--el-surface-soft`, on `--el-tint-rose`
  // (the billing cancelled banner, the DraftWithAi rose Card) and on
  // `--el-danger-surface` (the WorkItemNode cross-blocked chip, whose label
  // measured 1.14–1.29:1 for as long as it has existed). An ink that clears all
  // six is right whichever surface the element lands on — the same property
  // that makes `--el-text-secondary` the answer on the grey arms.
  const SURFACES = [
    '--el-page-bg',
    '--el-card',
    '--el-surface',
    '--el-surface-soft',
    '--el-muted',
    '--el-tint-rose',
    '--el-danger-surface',
  ];

  it('measures the whole matrix it claims to (every palette, both themes)', () => {
    // The counterpart to notes.html #195 again: a matrix that silently went
    // empty — a regex that stopped matching, a palette list that shrank — would
    // make every assertion below vacuously true. The floor is `>=`, never `===`:
    // the point of deriving the list is that an eleventh palette is measured on
    // the day it is added, and an equality here would make it a test to edit.
    expect(PAIRS).toHaveLength(PALETTES.length * 2);
    expect(PALETTES).toContain(BASE_PALETTE);
    expect(PALETTES).toContain('spectrum'); // the palette the defect was reported on
    expect(PALETTES.length).toBeGreaterThanOrEqual(10);
  });

  it('resolves to a real colour in every pair — never an unresolved var()', () => {
    // A `color-mix` over two tokens is only as good as both tokens resolving.
    // An unresolved one folds to an empty string, and `contrast()` would then
    // throw rather than fail — a guard that throws measures nothing.
    const broken = PAIRS.filter(
      ({ palette, theme }) => !/^#[0-9a-f]{6}$/i.test(resolve(palette, theme, DANGER_INK)),
    ).map(({ palette, theme }) => `${palette}/${theme} → "${resolve(palette, theme, DANGER_INK)}"`);
    expect(broken.join(', ')).toBe('');
  });

  it('clears AA on every surface a danger message lands on, in all 20 pairs', () => {
    const failures: string[] = [];
    for (const { palette, theme } of PAIRS) {
      const ink = resolve(palette, theme, DANGER_INK);
      for (const surface of SURFACES) {
        const ratio = contrast(ink, resolve(palette, theme, surface));
        if (ratio < AA) {
          failures.push(`${palette}/${theme}: ${ink} on ${surface} = ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(
      failures.join('\n'),
      `\`${DANGER_INK}\` must clear ${AA}:1 on every surface in every palette and theme — that ` +
        'is the whole reason it exists rather than `--el-danger`, which is 4.25 / 4.11 / 4.24:1 ' +
        'on the DARK page in the base, cobalt and graphite palettes. If a palette moved its ' +
        'danger hue or its page, re-measure the PAIR before changing either side; if the mix ' +
        'ratio in `theme.css` needs to move, move it there — never darken a hue at a call site.',
    ).toBe('');
  });

  it('stays distinguishable from the body ink — the danger SIGNAL, not just the text', () => {
    // The half of this bug that is NOT a contrast failure, and the half the
    // report actually described ("the error text is white"). In four dark
    // palettes `--el-danger-text` cleared 18.59–19.44:1 against the page and
    // was still the defect, because it was the same near-white as `--el-text`.
    // A replacement that merely passed AA could reintroduce exactly that, so
    // the arm asserts SEPARATION from the body ink as well as contrast with the
    // page. 10:1 apart in CIEDE2000 is a comfortable floor; the measured range
    // is 23.8–39.2.
    const tooClose: string[] = [];
    for (const { palette, theme } of PAIRS) {
      const distance = deltaE2000(
        resolve(palette, theme, DANGER_INK),
        resolve(palette, theme, '--el-text'),
      );
      if (distance < 10) tooClose.push(`${palette}/${theme}: ΔE ${distance.toFixed(1)}`);
    }
    expect(
      tooClose.join('\n'),
      'These pairs paint danger text in something a reader cannot tell from ordinary body ink. ' +
        'That is the half of MOTIR-3663 that is not a contrast failure — on four dark palettes ' +
        'the old token cleared 18.59–19.44:1 against the page and was still the bug.',
    ).toBe('');
  });
});

describe('ink-contrast lint — --el-accent-on-surface is AA in all 20 palette × theme pairs', () => {
  // MOTIR-3745. The FOURTH ink, and the first one added because of what the
  // guard did NOT say rather than because of what it did.
  //
  // ── The hole ────────────────────────────────────────────────────────────────
  // The three arms above were each written after a defect in THAT ink was found:
  // faint (MOTIR-2455), muted (MOTIR-2455), danger-text (MOTIR-3663). Each time
  // the lint went green afterwards, and a green lint reads as *the inks are
  // measured*. It never was — it is *the three inks somebody has been bitten by
  // are measured*. `--el-accent-on-surface` is how the product says **you are
  // here** (an active nav item, a selected row, a count badge) and it had never
  // been in any matrix, in any palette, in either theme.
  //
  // What was standing under that silence, on `origin/main`, base palette, DARK:
  //
  //   --el-accent-on-surface #7b6ce5 on --el-surface      #1a1a1a   4.24:1
  //                                  on --el-surface-soft #161616   4.41:1
  //                                  on --el-muted        #1a1a1a   4.24:1
  //
  // `app/(public)/explore/_components/ExploreTopBar.tsx` paints its header
  // `bg-(--el-surface-soft)` and its current-page nav item
  // `text-[13.5px] font-semibold text-(--el-accent-on-surface)`. 13.5px semibold
  // is not WCAG large text (large is ≥24px, or ≥18.66px bold), so 1.4.3 asks
  // 4.5:1 and it missed by 0.09 — on `/explore` and `/docs`, both public and
  // both reachable signed out, for as long as either has shipped.
  //
  // ── Why this arm is a MATRIX and not an AST scan ────────────────────────────
  // The three arms above scan CALL SITES because their inks are, by design, not
  // AA everywhere: faint clears AA on nothing, muted only on the white page/card,
  // and `--el-danger-text` only on the danger fill. Each site therefore has to be
  // ruled on individually — is it a glyph, is it disabled, what is under it.
  //
  // `--el-accent-on-surface` is the opposite kind of token. Its whole job is to
  // be the accent that is LEGIBLE as ink, on whatever surface it lands on — the
  // Tier-3 comment says so, and it is why the token exists apart from
  // `--el-accent` (the fill). So the honest question is not *which site is
  // wrong*, it is *is the ink AA on every surface the app paints under it*, in
  // every palette and both themes. That is a computed table, exactly like the
  // `--el-danger-on-surface` one above, and for the same stated reason: the
  // numbers depend on values ten palettes are free to change.
  //
  // ── The surface set is DERIVED, not remembered ──────────────────────────────
  // The two describes near the top of this file already read the surface
  // vocabulary back out of `theme.css` in both directions — `SAFE_SURFACE_TOKENS`
  // (every `--el-*` that IS the page white) and `TINTED_SURFACE_TOKENS` (every
  // `--el-*` that resolves to one of the three measured tints, total over the
  // token table). This arm measures that union rather than a hand-written list,
  // so an alias added tomorrow is measured the day it lands. That is the whole
  // MOTIR-3693 lesson applied one ink over: `--el-sidebar-bg` was unmeasured for
  // the life of the rail because a list of three names was written by hand.
  //
  // ── …PLUS the one pastel tint the tree pairs this ink with (MOTIR-3774) ─────
  // The derivation above is the NEUTRAL vocabulary — the page white and the
  // three greys. `--el-tint-lavender` is not in it, and when this arm shipped
  // the pair was left OUT of the matrix and tracked in prose at the bottom of
  // this file instead, because four palettes failed it in LIGHT and no dark-only
  // override could reach them. That prose is now a measurement: the pair is a
  // member of `SURFACES`, so every palette × theme is asserted on it by the same
  // table as everything else, and the tint stops being the one surface this
  // arm's green does not cover.
  const SURFACES = [...SAFE_SURFACE_TOKENS, ...TINTED_SURFACE_TOKENS, ACCENT_TINT];

  it('measures the whole matrix it claims to (every palette, both themes)', () => {
    // Same floor, and the same reason, as the danger arm's: a matrix that
    // silently went empty would make every assertion below vacuously true, and
    // `>=` rather than `===` is what makes an eleventh palette measured on the
    // day it is added instead of a test to edit.
    expect(PAIRS).toHaveLength(PALETTES.length * 2);
    expect(PALETTES).toContain(BASE_PALETTE); // the palette the defect was reported on
    expect(PALETTES.length).toBeGreaterThanOrEqual(10);
    expect(SURFACES.length).toBeGreaterThan(3);
    expect(SURFACES).toContain('--el-surface-soft'); // ExploreTopBar's own header
    expect(SURFACES).toContain(ACCENT_TINT); // the accent family's own tint — MOTIR-3774
  });

  it('resolves to a real colour in every pair — never an unresolved var()', () => {
    // As on the danger arm: an unresolved `var()` folds to an empty string and
    // `contrast()` would then THROW rather than fail, and a guard that throws
    // measures nothing. It matters more here than there, because the fix for
    // this ink is a `color-mix` over two tokens in the dark block — if either
    // input stopped resolving, the assertion below would stop being a test.
    const broken = PAIRS.filter(
      ({ palette, theme }) => !/^#[0-9a-f]{6}$/i.test(resolve(palette, theme, ACCENT_INK)),
    ).map(({ palette, theme }) => `${palette}/${theme} → "${resolve(palette, theme, ACCENT_INK)}"`);
    expect(broken.join(', ')).toBe('');
  });

  it('clears AA on every surface in the vocabulary, in all 20 pairs', () => {
    const failures: string[] = [];
    for (const { palette, theme } of PAIRS) {
      const ink = resolve(palette, theme, ACCENT_INK);
      for (const surface of SURFACES) {
        const ratio = contrast(ink, resolve(palette, theme, surface));
        if (ratio < AA) {
          failures.push(`${palette}/${theme}: ${ink} on ${surface} = ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(
      failures.join('\n'),
      `\`${ACCENT_INK}\` is the accent used AS TEXT, so it owes 4.5:1 on whatever surface the ` +
        'element lands on — that is the property that separates it from `--el-accent`, the ' +
        'FILL. In the DARK theme the base palette painted it at 4.24–4.41:1 on the three ' +
        "tints, which is what `[data-theme='dark']` in `theme.css` now lifts by mixing the " +
        "palette's own `--color-primary` toward that theme's body ink. If a palette moved its " +
        'primary or its surfaces, re-measure the PAIR before changing either side; if the mix ' +
        'ratio needs to move, move it in `theme.css` — never darken or lighten the accent at a ' +
        'call site, which is what the token exists to make unnecessary.',
    ).toBe('');
  });

  it('stays distinguishable from the body ink — the ACCENT signal, not just the text', () => {
    // Borrowed wholesale from the danger arm, and for the same reason: the fix
    // for a contrast failure is to pull the hue toward the body ink, and pulled
    // far enough that stops being an accent at all. An accent nobody can tell
    // from ordinary copy has lost the thing it was painted for, so the floor is
    // asserted rather than left to whoever next tunes the mix. 10:1 in CIEDE2000
    // is the same comfortable floor; the measured range here is 22.6–54.5.
    const tooClose: string[] = [];
    for (const { palette, theme } of PAIRS) {
      const distance = deltaE2000(
        resolve(palette, theme, ACCENT_INK),
        resolve(palette, theme, '--el-text'),
      );
      if (distance < 10) tooClose.push(`${palette}/${theme}: ΔE ${distance.toFixed(1)}`);
    }
    expect(
      tooClose.join('\n'),
      'These pairs paint the you-are-here accent in something a reader cannot tell from ' +
        'ordinary body ink. Raising contrast by mixing further toward `--el-text` eventually ' +
        'does that, so this is the floor that stops the fix from eating the signal.',
    ).toBe('');
  });

  it('leaves --el-tint-lavender a TINT — never within ΔE 3 of its own page', () => {
    // The other half of MOTIR-3774, and the reason the fix moved the INK rather
    // than the tint. Clearing 4.5:1 on a pastel has exactly two levers: darken
    // the ink, or lighten the tint until it is nearly the page. The second one
    // passes the arm above while costing `--el-tint-lavender` the job it exists
    // for — it is also `--el-vote-bg`, `--el-roadmap-planned` and a label tint,
    // and a chip you cannot see is not a quieter chip.
    //
    // Measured before it was asserted: the tightest pair in the tree is
    // sienna/light at ΔE 4.2, because its lavender is a warm cream on a warm
    // ivory page (`#ece6d6` on `#fffaeb`) — which is precisely why sienna had no
    // room to lighten and its ink had to move. Candy is the worked counter-
    // example: lifting its Violet-4 lavender to Violet-3 would have cleared AA
    // at 4.71 and landed the tint at ΔE 6.0 from the page with 1.10:1 of
    // separation, against 1.28:1 for the base palette's. Legal, and washed out.
    const tooPale: string[] = [];
    for (const { palette, theme } of PAIRS) {
      const distance = deltaE2000(
        resolve(palette, theme, ACCENT_TINT),
        resolve(palette, theme, '--el-page-bg'),
      );
      if (distance < 3) tooPale.push(`${palette}/${theme}: ΔE ${distance.toFixed(1)}`);
    }
    expect(
      tooPale.join('\n'),
      'These palettes have lightened the accent tint until it is the page. That is the ' +
        'cheap way to pass the AA assertion above and it removes the tint instead of fixing ' +
        'the ink — raise `--color-primary` contrast in the palette block instead.',
    ).toBe('');
  });

  it('keeps the DARK half where MOTIR-3745 put it — the 82% mix, not the 84% one', () => {
    // MOTIR-3774 changes LIGHT declarations only, so this is the assertion that
    // says so rather than the pull request saying so. The arm above would still
    // pass at 4.5, and 4.5 is not where the dark half was left: MOTIR-3745
    // measured 84% as the largest primary share that clears this same pair
    // (4.57:1) and chose 82% for headroom (4.68:1). A floor of 4.6 is exactly
    // the difference between those two choices, so a later re-tune that walks
    // the mix back toward the palette's raw primary fails HERE, with the number
    // that was reasoned about, instead of passing an AA check by 0.07.
    const regressed: string[] = [];
    for (const palette of PALETTES) {
      const ratio = contrast(
        resolve(palette, 'dark', ACCENT_INK),
        resolve(palette, 'dark', ACCENT_TINT),
      );
      if (ratio < 4.6) regressed.push(`${palette}/dark: ${ratio.toFixed(2)}`);
    }
    expect(
      regressed.join('\n'),
      'The dark accent-on-lavender pair has fallen below the headroom the 82% mix was ' +
        'sized for (4.68:1 at its worst, on the base palette). Re-read the ' +
        "`[data-theme='dark']` block's `Why 82%` note before moving it.",
    ).toBe('');
  });

  it('pairs the ink with exactly one --el-tint-*, and it is the accent family’s own', () => {
    // ⚠️ THIS PAIRING IS NOW MEASURED, NOT TRACKED HERE. `ACCENT_TINT` is a
    // member of `SURFACES` above, so `--el-tint-lavender` is asserted in all
    // twenty palette × theme pairs by the same table as the page white and the
    // three greys. What this assertion still buys is the OTHER half, which no
    // table can supply: that the set of pastel tints the tree pairs this ink
    // with is still exactly the one the table measures.
    //
    // The tree paints accent ink on `--el-tint-lavender` — the accent family's
    // own — in ten files, mostly as a rounded glyph tile (`ProjectsEmptyState`,
    // `PasskeyManager`, `TwoFactorManager`) but also as real text
    // (`IssueFilterBar`'s saved-filter count badge, `ProposalQuickView`'s badge,
    // `Sidebar`'s active row). Pair it with a SECOND tint and this goes red,
    // because that tint is a surface nobody has measured the ink on — add it to
    // `SURFACES` and measure it, rather than assuming it behaves like this one.
    //
    // ── What it used to say, and why the change is the point ────────────────
    // Until MOTIR-3774 this comment carried the MEASUREMENT itself — five failing
    // pairs out of twenty, four of them in LIGHT (evergreen 4.19, amber 4.00,
    // sienna 4.13, candy 4.29) — as prose, because the fix needed those four
    // palettes' accent inks to move and MOTIR-3745 was explicitly told not to
    // touch a light value. A number in a comment is not a guard: it cannot go
    // red, and nothing re-derives it. The four inks moved in `theme.css` and the
    // pair joined the table, so the paragraph that stood in for the assertion is
    // gone rather than updated.
    const paired = new Set<string>();
    for (const file of ACCENT_CARRIERS) {
      for (const [, , blob] of TEXT_BY_FILE.get(file)!.matchAll(
        /(['"`])((?:[^\\]|\\[\s\S])*?)\1/g,
      )) {
        if (!blob!.includes(ACCENT_CLASS)) continue;
        for (const [, token] of blob!.matchAll(/(?:^|\s|:)bg-\((--el-tint-[a-z0-9-]+)\)/g)) {
          paired.add(token!);
        }
      }
    }
    // Non-empty first: a regex that stopped matching would make the equality
    // below pass by measuring nothing, which is this file's standing failure
    // mode (notes.html #195).
    expect([...paired]).toContain(ACCENT_TINT);
    expect(
      [...paired].filter((token) => token !== ACCENT_TINT).join(', '),
      'The accent ink is painted on a pastel tint this arm does not measure. ' +
        `Only ${ACCENT_TINT} is measured (it is in \`SURFACES\` above); a second one is a new ` +
        'surface nobody has measured the ink on. Add it to `SURFACES` so the pair is asserted ' +
        'across all 20 palette × theme combinations, and fix whatever that turns red.',
    ).toBe('');
  });
});
