import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-4687 — a design mock's STYLESHEET and its MARKUP are two hand-maintained
// lists that are supposed to be in correspondence, and until this spec nothing
// checked that they were, in either direction.
//
// ── The two directions, and why they are one guard ──────────────────────────
// A `*.mock.html` is static HTML with a hand-written "utility shims" `<style>`
// block. It is not Tailwind output, so an arbitrary-value utility exists only
// if that block spells it out. Two things then go wrong, and they are exact
// inverses:
//
//   (A) INERT — an element carries a class that no rule declares. The class
//       does nothing and the element renders at whatever it inherits.
//       MOTIR-4687's own population: 115 occurrences of 12 un-prefixed
//       arbitrary-value utilities across 8 assets on `origin/main` `cd77d0225`,
//       among them a section heading asking for `text-[19px]` and getting the
//       UA's `1.5em`, and a rail close button asking for `text-(--el-text-muted)`
//       whose `hover:text-(--el-text)` IS declared — so the hover was the only
//       state it ever painted.
//   (B) DEAD — a rule is declared that no element carries. MOTIR-4150: three
//       assets ship `.max-w-md { max-width: 28rem; }` and not one element
//       references it, and a card read that measure off the stylesheet and
//       called it "the value the asset draws".
//
// (A) silently un-styles the ASSET; (B) misleads a READER. One cause, opposite
// costs — which is why fixing one alone leaves the pair half-done.
//
// ── Why no existing guard sees either ───────────────────────────────────────
// `design-ink-contrast` and `design-state-ink-contrast` read the ink a rule
// NAMES; `design-token-layer` rules on the token block; `design-dark-parity` on
// the dark scope. All of them ask what a rule SAYS, and none asks whether any
// rule APPLIES. Worse, the direction of the risk is inverted: an un-styled
// element usually inherits `--el-text`, which PASSES contrast, so direction (A)
// makes those guards greener rather than redder.
//
// ── Same mould as its neighbours ────────────────────────────────────────────
// `design-token-layer.test.ts` (MOTIR-4353) and `design-three-file-set.test.ts`
// (MOTIR-3069): a pure core over a LISTING of `{ path, source }`, so the
// negative path is exercised on fixtures rather than only by the real tree
// passing, plus hold-it-tight tables that can only shrink.

const ROOT = process.cwd();
const DESIGN_DIR = join(ROOT, 'design');
const MOCK_SUFFIX = '.mock.html';

export type MockSource = { path: string; source: string };

// ── Reading the two lists ───────────────────────────────────────────────────

/** CSS with `/* … *\/` comments removed. */
const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * An HTML comment, `<!--` to `-->`.
 *
 * ⚠️ STRIPPING THESE BEFORE ANYTHING ELSE IS LOAD-BEARING, and it is the fourth
 * false positive this check produced — MOTIR-4811, on the population MOTIR-4687
 * pinned. Every mock opens with a banner naming its provenance, and several of
 * them say `<style>` in prose: `design/billing/ci-line.mock.html` documents that
 * its base asset's *"`<style>` token block and lucide sprite are spliced into
 * this file"*. `STYLE_BLOCK` matched at THAT `<style>`, so the "stylesheet" began
 * inside the banner and ran on until the real block's `</style>` — and
 * `declaredClasses` then read the banner's own prose as selectors. It reports
 * `.mock` and `.html` (from `billing.mock.html`), `.tsx` (from a filename) and
 * `.1` / `.3` / `.5` (from `§7.1`, `8.1.3`) as declared classes NO element
 * carries, which is true and useless: they are not rules, so there is nothing to
 * delete and no disposition to take. 34 of MOTIR-4811's 365 rows were this.
 *
 * The HTML parser never had this problem — markup inside a comment is not
 * markup — so the fix is to read the DOCUMENT the browser reads.
 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** The document with its HTML comments removed — what the parser actually sees. */
const uncommented = (html: string): string => html.replace(HTML_COMMENT, ' ');

/**
 * A `<style>` / `<script>` element, opening tag to closing tag.
 *
 * ⚠️ THE END TAG IS `<\/style\b[^>]*>`, NOT `<\/style>` AND NOT `<\/style\s*>`.
 * HTML's tokenizer ends the element at the tag NAME: whatever sits between the
 * name and the `>` is consumed as (ignored) attribute junk, so `</style >`,
 * `</style\t\n foo>` and `</script bar="baz">` all close the element. A filter
 * that stops short of that stops at the wrong place — the "stylesheet" would
 * run on into the document, so `declaredClasses` would read selectors out of
 * prose and `markupOf` would hand a stylesheet to the attribute scan.
 *
 * `\b` is what keeps it honest in the other direction: there is no word
 * boundary inside `</styles>`, so a longer tag name does not match.
 *
 * (CodeQL `js/bad-tag-filter`, twice — it rejected `\s*` for exactly the
 * attribute-junk case. The input here is the repository's own design tree
 * rather than anything hostile, but a hand-written shim block is precisely
 * where a stray space ends up.)
 */
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\b[^>]*>/gi;
const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi;

/**
 * The CSS a document DECLARES: every `<style>` block, comments stripped.
 *
 * ⚠️ `style="…"` attributes are deliberately NOT included, unlike
 * `design-token-layer.test.ts`'s `styleSourceOf`. That spec is looking for
 * custom-property DECLARATIONS, which an inline style can carry; this one is
 * looking for CLASS SELECTORS, which an inline style cannot express at all.
 */
export function stylesheetOf(html: string): string {
  const blocks: string[] = [];
  for (const match of uncommented(html).matchAll(STYLE_BLOCK)) blocks.push(match[1]!);
  return stripCssComments(blocks.join('\n'));
}

/**
 * The document with its `<style>` AND `<script>` blocks removed — the text in
 * which a `class="…"` attribute is a real class attribute.
 *
 * ⚠️ DROPPING `<script>` IS LOAD-BEARING, and it is the first false positive
 * this check produced. `design/ai-chat/planning-workspace.mock.html` builds
 * markup at runtime from a template literal —
 * `` `<span class="pill ${n.pill[0]}">` `` — and a scanner reading the raw file
 * reports `${n.pill[0]}` as an undeclared arbitrary-value utility. It is not a
 * class; it is an expression that produces one. (MOTIR-4687's own command
 * suppressed it by excluding any token containing `$`, which is a spelling
 * rather than a reason, and would still have reported a template literal that
 * happened not to use `$`.)
 */
export function markupOf(html: string): string {
  return uncommented(html).replace(STYLE_BLOCK, ' ').replace(SCRIPT_BLOCK, ' ');
}

/**
 * The text of every `<script>` block — the markup a mock builds at RUNTIME.
 *
 * `markupOf` drops these and must keep doing so (see its own note): direction
 * (A) asks whether an element's class has a rule, and `${n.pill[0]}` is not a
 * class. Direction (B) asks the opposite question — does ANY element carry this
 * rule's class — and there the same block is evidence, because a mock that
 * writes `el.className = 'mininode'` carries `.mininode` on a real element the
 * moment it runs. The two directions need different views of the same block,
 * which is why this is a second reader rather than a change to the first.
 */
export function scriptOf(html: string): string {
  const blocks: string[] = [];
  for (const match of uncommented(html).matchAll(SCRIPT_BLOCK)) blocks.push(match[1]!);
  return blocks.join('\n');
}

/**
 * A CSS class selector: `.` followed by a run of identifier characters or
 * backslash escapes.
 *
 * The escape half is the whole point. Every arbitrary-value utility carries
 * characters CSS forbids unescaped, so the shim block spells them
 * `.text-\[19px\]`, `.text-\(--el-link\)`,
 * `.transition-\[transform\,background-color\]`. The alternation stops the
 * match at an UNESCAPED `.` (a compound selector), `:` (a pseudo-class) or a
 * space, which a naive `[^\s{,]+` pattern does not — it would read
 * `.rounded-\(--radius-control\).justify-center` as one class named after both.
 */
const CLASS_SELECTOR = /\.((?:\\.|[A-Za-z0-9_\u00a0-\uffff-])+)/g;

/** `\[19px\]` → `[19px]`: the class name as an HTML `class` attribute spells it. */
const unescapeCss = (selector: string): string => selector.replace(/\\(.)/g, '$1');

/**
 * The SELECTOR text of every rule in a stylesheet — what sits between a brace
 * boundary and the next `{`.
 *
 * ⚠️ SCANNING THE WHOLE STYLESHEET INSTEAD IS THE SECOND FALSE POSITIVE, and it
 * is a flood rather than a curiosity: `letter-spacing: .03em` and
 * `opacity: .55` match a class-selector pattern exactly, so a whole-file scan
 * reports `.03em` and `.55` as declared classes. Reading only the preludes is
 * what makes direction (B) a statement about SELECTORS rather than about every
 * decimal in the file.
 */
export function selectorPreludes(css: string): string[] {
  const preludes: string[] = [];
  let buffer = '';
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') {
      preludes.push(buffer);
      buffer = '';
      depth += 1;
    } else if (ch === '}') {
      buffer = '';
      depth = Math.max(0, depth - 1);
    } else if (ch === ';' && depth > 0) {
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return preludes;
}

/** Every class name a stylesheet declares a rule for, un-escaped. */
export function declaredClasses(html: string): Set<string> {
  const names = new Set<string>();
  for (const prelude of selectorPreludes(stylesheetOf(html)))
    for (const match of prelude.matchAll(CLASS_SELECTOR)) names.add(unescapeCss(match[1]!));
  return names;
}

/** The named character references an HTML `class` attribute realistically carries. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/**
 * `&amp;` → `&`: the entity forms an HTML `class` attribute may legally use.
 *
 * ⚠️ ONE PASS, DELIBERATELY. Chaining `.replace(/&amp;/g, '&')` before
 * `.replace(/&lt;/g, '<')` DOUBLE-unescapes: the first pass turns `&amp;lt;`
 * into `&lt;`, which the second then turns into `<`, so a class attribute
 * written to contain the literal text `&lt;` decodes to a different string than
 * the browser gives the CSS engine — and this guard's whole job is to compare
 * the two lists the way the browser sees them. A single scan replaces each
 * entity from the ORIGINAL text and never re-reads what it produced.
 * (CodeQL `js/double-escaping`.)
 */
const decodeEntities = (value: string): string =>
  value.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (whole, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      return NAMED_ENTITIES[name!] ?? whole;
    },
  );

/**
 * Every class an element CARRIES, with its occurrence count.
 *
 * ⚠️ DECODING ENTITIES IS THE THIRD FALSE POSITIVE, and it was the largest:
 * seven shell assets write `class="… [&amp;_svg]:h-[18px] …"`, which the HTML
 * parser hands the CSS engine as `[&_svg]:h-[18px]`, and the stylesheet
 * declares `.\[\&_svg\]\:h-\[18px\]`. Compared raw, the two never match and the
 * check reports 536 findings that are not findings. Compared decoded,
 * `design/shell/rail-bottom-section.mock.html` drops out entirely — it declares
 * the rule — and the seven that genuinely do not are what remain.
 */
export function usedClasses(html: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of markupOf(html).matchAll(/\sclass\s*=\s*"([^"]*)"/g))
    for (const token of decodeEntities(match[1]!).split(/\s+/).filter(Boolean))
      counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/**
 * A quoted string literal in a script, without escapes or newlines — the form a
 * class name is written in.
 */
const STRING_LITERAL = /'([^'\n\\]*)'|"([^"\n\\]*)"/g;

/**
 * Every class a mock's SCRIPTS put on an element at runtime.
 *
 * ⚠️ WITHOUT THIS, DIRECTION (B) REPORTS A LIVE RULE AS DEAD — the one
 * false-negative the header's `markupOf` note names, seen from the other side,
 * and the largest single source of wrong rows in MOTIR-4811's population: 25 of
 * its 365, seventeen of them in `design/roadmap/roadmap.mock.html` alone, which
 * builds its whole canvas from `.onode` / `.otile` / `.opill` / `.youhere` in a
 * script and carries none of them in static markup. Deleting those rules is the
 * one edit in this sweep that would actually have changed what an asset paints.
 *
 * TWO forms, because the tree uses both and neither subsumes the other: the
 * class ATTRIBUTE inside a template literal (`` `<span class="pill reviewed">` ``)
 * and a bare string literal assigned or joined (`el.className = 'mininode'`,
 * `cls(['onode', …])`, `n.border === 'skippable' ? 'skippable' : ''`). The second
 * over-approximates — every whitespace-delimited token of every short string
 * literal counts as carried — and that direction is the deliberate one: a missed
 * dead rule costs a reader nothing, while a wrongly-reported one costs whoever
 * acts on it a live rule. The scan is bounded to the eight mocks that have a
 * script at all.
 */
export function scriptCarriedClasses(html: string): Set<string> {
  const carried = new Set<string>();
  const source = scriptOf(html);
  if (!source) return carried;
  for (const match of source.matchAll(/\sclass\s*=\s*["']([^"']*)["']/g))
    for (const token of match[1]!.split(/\s+/).filter(Boolean)) carried.add(token);
  for (const match of source.matchAll(STRING_LITERAL))
    for (const token of (match[1] ?? match[2]!).split(/\s+/).filter(Boolean)) carried.add(token);
  return carried;
}

/**
 * A CSS comment that never OPENED, or one a banner closed EARLY — reported as
 * the position and kind of each structural break.
 *
 * ⚠️ THIS IS A DEFECT IN THE ASSET, NOT IN THE READER, AND IT SILENTLY DROPS A
 * RULE. Everything after the break is LIVE CSS, so the parser reads the prose as
 * a selector prelude and runs on to the next `{` — which belongs to the next real
 * rule. That rule’s prelude is then invalid and the browser drops the WHOLE
 * rule, block and all. FIVE assets shipped this (MOTIR-4811), and it is why 5
 * of that card’s rows were prose rather than rules:
 *
 *   • `design/settings/appearance.mock.html` and its copy in
 *     `design/ai-chat/onboarding.mock.html` opened an `AXIS 3 (TYPE)` banner with
 *     no `/*` at all — 24 lines of prose as live CSS, eating the
 *     `[data-type=‘motir-sans’]` rule after it.
 *   • `design/project-square/project-square.mock.html` wrote `rounded-*\/p-*` in a
 *     banner, whose `*\/` closed it early and ate `.sq-head`.
 *   • `design/github/github.mock.html` and `design/gitlab/gitlab.mock.html` wrote
 *     `--el-*\/shape tokens` and `design\/*\/*.mock.html`, each closing the banner
 *     early and eating `* { box-sizing: border-box }` — which is why repairing
 *     them MOVED both `.png` exports.
 *
 * ⚠️ COUNTING LEFTOVER `*\/` IS NOT ENOUGH, AND THAT WEAKER CHECK WAS WRITTEN
 * FIRST AND MISSED TWO OF THE FIVE. A banner that closes early leaves its real
 * terminator stray, so the tally is off by one — unless a LATER `/*` re-opens and
 * absorbs it, which is exactly what happens in a file with many banners. The
 * parities then balance and the file reads clean while its pairing is shifted
 * throughout. So the scan is SEQUENTIAL, and it also reports an unterminated
 * STRING: a `’` in prose (`primitive’s`) opens one the moment the prose goes
 * live, and CSS forbids a newline inside a string, so that is a structural break
 * too. An ESCAPED quote is not one — `.before\:content-\[\’\’\]` is an ordinary
 * selector, and the first draft of this scan reported all four of its quotes.
 */
export function cssStructureFindings(html: string): { kind: string; at: number }[] {
  const blocks: string[] = [];
  for (const match of uncommented(html).matchAll(STYLE_BLOCK)) blocks.push(match[1]!);
  const css = blocks.join('\n');
  const findings: { kind: string; at: number }[] = [];
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) {
        findings.push({ kind: 'unclosed-comment', at: i });
        break;
      }
      i = end + 2;
      continue;
    }
    if (ch === '*' && css[i + 1] === '/') {
      findings.push({ kind: 'stray-terminator', at: i });
      i += 2;
      continue;
    }
    if ((ch === '"' || ch === "\'") && css[i - 1] !== '\\') {
      let j = i + 1;
      while (j < css.length && css[j] !== '\n' && !(css[j] === ch && css[j - 1] !== '\\')) j++;
      if (j >= css.length || css[j] === '\n') {
        findings.push({ kind: 'unterminated-string', at: i });
        i++;
        continue;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return findings;
}

// ── The two predicates ──────────────────────────────────────────────────────

/**
 * An ARBITRARY-VALUE utility — one carrying `[…]` or `(…)`.
 *
 * These are the ones the shim block has to spell out. A plain `.flex` may
 * legitimately be missing from a mock that inherits a stylesheet; an
 * arbitrary-value utility has no such fallback, because nothing generates it.
 */
export const isArbitrary = (token: string): boolean => token.includes('[') || token.includes('(');

/**
 * A VARIANT-prefixed token — `hover:`, `focus-visible:`, `data-[state=…]:`,
 * `[&_svg]:`.
 *
 * Split out because the two halves are DIFFERENT SIZED problems and this card
 * fixed one of them (see `INERT_VARIANT_DEBT`), not because a variant is less
 * of a defect. `[&_svg]:h-[18px]` is a descendant rule with no state in it at
 * all: it applies unconditionally, so an undeclared one is exactly as inert as
 * an un-prefixed class, and the seven shell assets carrying it render every nav
 * icon at the `<svg width="24" height="24">` attribute instead of 18px.
 */
export const isVariant = (token: string): boolean => token.includes(':') || token.includes('&');

/** DIRECTION (A): arbitrary-value classes an asset carries and does not declare. */
export function inertUtilities(mock: MockSource): { token: string; count: number }[] {
  const declared = declaredClasses(mock.source);
  return [...usedClasses(mock.source)]
    .filter(([token]) => isArbitrary(token) && !declared.has(token))
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
}

/**
 * DIRECTION (B): classes a mock declares that NO element in ANY mock carries.
 *
 * ⚠️ THE POPULATION IS THE WHOLE TREE, DELIBERATELY, and the per-file form was
 * measured before this one was chosen. Per file the count is 1493 declarations
 * across 89 assets, because these shim blocks are COPIED between assets: a rule
 * an asset does not use is usually a rule its sibling does, which is the block
 * doing its job rather than a defect. Globally dead is the predicate MOTIR-4150
 * is actually about — `.max-w-md` is in three assets and referenced by none —
 * and it is derived from the tree rather than pinned to a spelling, the same
 * move `design-token-layer.test.ts` makes when it reads the legitimate token
 * names out of `theme.css` instead of allowing a `--color-*` prefix.
 */
export function deadUtilities(mocks: MockSource[]): Map<string, string[]> {
  const carried = new Set<string>();
  for (const mock of mocks) {
    for (const token of usedClasses(mock.source).keys()) carried.add(token);
    for (const token of scriptCarriedClasses(mock.source)) carried.add(token);
  }
  const dead = new Map<string, string[]>();
  for (const mock of mocks)
    for (const name of [...declaredClasses(mock.source)].sort())
      if (!carried.has(name)) dead.set(name, [...(dead.get(name) ?? []), mock.path]);
  return dead;
}

/** How many globally-dead rules each mock declares. */
export function deadCountByFile(mocks: MockSource[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [, paths] of deadUtilities(mocks))
    for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
  return counts;
}

// ── Inherited debt — COUNTS that have to reach zero, each with a card ────────
// Neither table below is an exemption. Both are asserted EXACT in both
// directions, so an asset cannot absorb one more finding and a row cannot
// outlive its fix — the same treatment `design-token-layer.test.ts` gives
// `UNSWEPT_ASSETS`, and for the same reason: the difference between these
// tables and an allowlist is the difference between a countdown and a mute
// button.
//
// EMPTY IS THE INTENDED RESTING STATE for both.

/**
 * DIRECTION (A), variant-prefixed half — MOTIR-4810 (structural) and
 * MOTIR-4813 (state).
 *
 * MOTIR-4687 took the UN-PREFIXED half to zero: 11 utility groups declared
 * across 7 assets, each read at its use site to tell a wanted style from a
 * vestigial class. The variant half is 636 occurrences of 14 utilities across
 * these 11 assets — 532 structural, 104 stateful — and it is NOT the same size
 * of job, for two reasons those cards measured rather than assumed:
 *
 *   • Declaring `[&_svg]:h-[18px]` in the seven shell assets RESIZES every nav
 *     icon in them from 24px to 18px — a visible change to seven approved
 *     assets, each needing a re-export and a look, which is a design pass and
 *     not a mechanical fix.
 *   • Declaring an ink variant makes it visible to `design-state-ink-contrast`
 *     for the first time, so the remedy can turn an ink guard RED and the
 *     answer is then which token is right — a design decision, and the one
 *     MOTIR-4812 exists to stop being answered by re-pointing the utility.
 *
 * The counts are OCCURRENCES, not distinct utilities, so the table measures how
 * much of each asset is inert. A file whose two halves belong to different
 * cards names both, and the first of them to land DECREMENTS the row rather
 * than deleting it.
 */
const INERT_VARIANT_DEBT: { file: string; count: number; card: string }[] = [
  { file: 'design/ai-chat/plan-change-run-live.mock.html', count: 88, card: 'MOTIR-4813' },
  { file: 'design/ai-planning/peek-proposal-mode.mock.html', count: 2, card: 'MOTIR-4813' },
  { file: 'design/projects/public-page.mock.html', count: 60, card: 'MOTIR-4810' },
  { file: 'design/settings/arrival.mock.html', count: 48, card: 'MOTIR-4810' },
  { file: 'design/shell/3d-immersive-shell.mock.html', count: 84, card: 'MOTIR-4810' },
  { file: 'design/shell/account-menu.mock.html', count: 8, card: 'MOTIR-4813' },
  { file: 'design/shell/help-menu.mock.html', count: 34, card: 'MOTIR-4810 / MOTIR-4813' }, // structural 28, state 6
  { file: 'design/shell/navigation-pending.mock.html', count: 96, card: 'MOTIR-4810' },
  { file: 'design/shell/top-bar.mock.html', count: 28, card: 'MOTIR-4810' },
  { file: 'design/work-items/child-panel-graph.mock.html', count: 48, card: 'MOTIR-4810' },
  { file: 'design/workbench/workbench.mock.html', count: 140, card: 'MOTIR-4810' },
];

/**
 * DIRECTION (B) — MOTIR-4814 (the two compiled builds). ⚠️ MOTIR-4811 SWEPT THE
 * HAND-WRITTEN HALF AND ITS 87 ROWS ARE GONE; what stands below is the residue
 * this table was always meant to shrink to.
 *
 * ⚠️ AND THE POPULATION IT SWEPT WAS SMALLER THAN THE ONE PINNED HERE, because
 * 66 of the 365 hand-written rows were not rules a sweep could dispose of. They
 * are recorded at the three readers that produced them — `uncommented`
 * (34 rows of banner PROSE, read as selectors because a mock says `<style>` in
 * its own header), `scriptCarriedClasses` (27 rows of LIVE classes a script puts
 * on an element at runtime) and `cssStructureFindings` (5 rows behind a
 * broken CSS comment, in FIVE assets where the browser was silently dropping a
 * whole rule). The remaining 299 were vestigial and were deleted; the two
 * compiled rows below moved 255 → 249 and stayed at 873 for the same reason.
 *
 * **A pinned count is a measurement, not a fact**, and the cheapest thing a
 * sweep can do is re-derive it before acting on it — the count agreed exactly
 * with `origin/main` and 17% of what it counted still could not be deleted.
 *
 * The two mocks that embed a COMPILED Tailwind build
 * (`design/shell/context-row.mock.html` 873, `design/ai-chat/onboarding.mock.html`
 * 249) are what is left. For those two, unused rules
 * are the normal and correct state of machine output — nobody chose them and no
 * sweep can remove them without hand-editing generated CSS. They are held here
 * rather than excused by a rule so the count still cannot grow, and MOTIR-4814
 * is the card that decides between a predicate keyed on the build's own
 * fingerprint and a sweep. That judgement is deliberately NOT made here: this
 * card measured the population, and choosing how a guard treats generated CSS
 * is a decision somebody should make on the record.
 *
 * ⚠️ THIS TABLE IS A COUNT AND NOT A NAME LIST, and the weakness is worth
 * stating: swapping one dead rule for another inside a file passes. The name
 * list was 1276 rows, and a 1300-line data block in a spec is read by nobody,
 * which is a worse guard than a count somebody maintains. What the count DOES
 * buy is the ratchet the pair of cards was filed for: no asset can gain a dead
 * rule, and the 172 mocks absent from this table are held at zero outright.
 */
const DEAD_UTILITY_DEBT: { file: string; count: number; card: string }[] = [
  { file: 'design/ai-chat/onboarding.mock.html', count: 249, card: 'MOTIR-4814' },
  { file: 'design/shell/context-row.mock.html', count: 873, card: 'MOTIR-4814' },
];

// ── The real tree ───────────────────────────────────────────────────────────

/** Every file under `design/`, as a repo-relative POSIX path. */
function designTree(dir: string = DESIGN_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) designTree(path, out);
    else out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out;
}

const MOCKS: MockSource[] = designTree()
  .filter((path) => path.endsWith(MOCK_SUFFIX))
  .map((path) => ({ path, source: readFileSync(join(ROOT, path), 'utf8') }));

const inertBudget = new Map(INERT_VARIANT_DEBT.map((row) => [row.file, row.count]));
const deadBudget = new Map(DEAD_UTILITY_DEBT.map((row) => [row.file, row.count]));

describe("a design mock's stylesheet and its markup correspond (MOTIR-4687)", () => {
  it('walks a design tree that actually has mocks with stylesheets in it', () => {
    // Without this every assertion below passes vacuously if the walk breaks or
    // the folder moves — the failure mode a tree-walk guard is most exposed to.
    expect(MOCKS.length).toBeGreaterThan(150);
    expect(MOCKS.every(({ source }) => source.includes('<style'))).toBe(true);
  });

  it('reads escaped, entity-carrying and prelude-only class names correctly', () => {
    // The three false positives named in the header, each pinned on a fixture so
    // the parser cannot quietly regress into the naive form. A guard that has
    // never been shown to read its input correctly is a guard reporting on
    // something else.
    const fixture = [
      '<style>',
      '  .text-\\[19px\\] { font-size: 19px; letter-spacing: .03em; }',
      '  .\\[\\&_svg\\]\\:h-\\[18px\\] { & svg { height: 18px; } }',
      '  .rounded-\\(--radius-control\\).justify-center { justify-content: center; }',
      '</style>',
      '<span class="text-[19px] [&amp;_svg]:h-[18px]"></span>',
      '<script>const s = `<span class="pill ${n.pill[0]}">`;</script>',
    ].join('\n');
    const declared = declaredClasses(fixture);
    expect(declared.has('text-[19px]')).toBe(true);
    expect(declared.has('[&_svg]:h-[18px]')).toBe(true);
    // The compound selector is TWO classes, and the decimal in a value is none.
    expect(declared.has('rounded-(--radius-control)')).toBe(true);
    expect(declared.has('justify-center')).toBe(true);
    expect(declared.has('03em')).toBe(false);
    // The entity decodes, and the template literal in the script is not markup.
    expect([...usedClasses(fixture).keys()].sort()).toEqual(['[&_svg]:h-[18px]', 'text-[19px]']);
    expect(inertUtilities({ path: 'fixture', source: fixture })).toEqual([]);
  });

  it('closes a `<style>` / `<script>` whose end tag carries attribute junk', () => {
    // CodeQL `js/bad-tag-filter`, pinned in the HARDEST form it names. HTML ends
    // the element at the tag NAME, so `</style\t\n foo>` and `</script bar="baz">`
    // both close it; a filter that misses them runs the "stylesheet" on into the
    // document — the class scan would read selectors out of prose, and `markupOf`
    // would hand a stylesheet to the attribute scan. The last line is the other
    // direction: `</styles>` is a DIFFERENT tag and must not close this one.
    const fixture = [
      '<style>.declared { color: red; }</style\t\n foo>',
      '<span class="declared undeclared-[9px]"></span>',
      '<script>const s = `class="from-[script]"`;</script bar="baz">',
    ].join('\n');
    // A FRESH non-global copy: `.test()` on a `/g` regex advances `lastIndex`,
    // and `matchAll` reads `lastIndex` off the regex it is given — so probing
    // the shared constant directly would be a trap for whoever edits this next.
    expect(new RegExp(STYLE_BLOCK.source, 'i').test('<style>a</styles>')).toBe(false);
    expect([...declaredClasses(fixture)]).toEqual(['declared']);
    expect([...usedClasses(fixture).keys()].sort()).toEqual(['declared', 'undeclared-[9px]']);
    expect(inertUtilities({ path: 'fixture', source: fixture })).toEqual([
      { token: 'undeclared-[9px]', count: 1 },
    ]);
  });

  it('decodes each entity from the ORIGINAL text, never from its own output', () => {
    // CodeQL `js/double-escaping`, pinned. Chained replaces turn `&amp;lt;` into
    // `&lt;` and then into `<`; one pass leaves it as the literal `&lt;`, which
    // is what the browser hands the CSS engine.
    const fixture = '<span class="a&amp;lt;b [&amp;_svg]:h-[18px] c&#65;d"></span>';
    expect([...usedClasses(fixture).keys()].sort()).toEqual(['[&_svg]:h-[18px]', 'a&lt;b', 'cAd']);
  });

  it('reports an inert utility when one is actually there', () => {
    // The negative path, on a fixture — the real tree is at zero for direction
    // (A), so nothing else in this file ever exercises the reporting branch.
    const broken = '<style>.text-\\[19px\\] { font-size: 19px; }</style><h2 class="text-[15px]">';
    expect(inertUtilities({ path: 'fixture', source: broken })).toEqual([
      { token: 'text-[15px]', count: 1 },
    ]);
  });

  it('reads a mock that names `<style>` in its own HTML comment banner', () => {
    // MOTIR-4811's fourth false positive. Several mocks document their provenance
    // in prose that says `<style>`; matching there makes the "stylesheet" start
    // inside the banner, and the banner's own words are then read as selectors.
    const fixture = [
      '<!-- BASE ASSET: billing.mock.html — its <style> token block is spliced in',
      '     verbatim; see docs/decisions/thing.md section 7.1. -->',
      '<style>.real { color: red; }</style>',
      '<p class="real"></p>',
    ].join('\n');
    expect([...declaredClasses(fixture)]).toEqual(['real']);
    // Without the strip these are `.mock`, `.html`, `.md` and `.1` — declared by
    // nothing, carried by nothing, and impossible to delete.
    expect([...deadUtilities([{ path: 'a.mock.html', source: fixture }])]).toEqual([]);
  });

  it('counts a class a SCRIPT puts on an element as carried', () => {
    // The other side of `markupOf`'s dropped `<script>`: direction (A) must not
    // read a template literal as markup, and direction (B) must not call a rule
    // dead because the only element carrying it is built at runtime. Both forms
    // the tree uses — the class attribute inside a template literal, and a bare
    // string literal assigned or joined.
    const fixture = [
      '<style>.onode { color: red; } .youhere { color: blue; } .gone { color: teal; }</style>',
      '<div id="canvas"></div>',
      '<script>',
      "  const cls = ['onode'].join(' ');",
      '  el.innerHTML = `<span class="youhere">here</span>`;',
      '</script>',
    ].join('\n');
    expect([...scriptCarriedClasses(fixture)].sort()).toEqual(['onode', 'youhere']);
    expect([...deadUtilities([{ path: 'a.mock.html', source: fixture }])]).toEqual([
      ['gone', ['a.mock.html']],
    ]);
  });

  it('every mock closes every CSS comment it opens, and every string', () => {
    // The five assets MOTIR-4811 repaired. Asserted on the real tree because it
    // is an ASSET defect, not a reader one: the break makes prose live CSS, and
    // the browser then drops the whole rule that follows it.
    const findings = MOCKS.flatMap(({ path, source }) =>
      cssStructureFindings(source).map(
        ({ kind, at }) =>
          `${path} — ${kind} at offset ${at} in its stylesheet: everything after it is live CSS, ` +
          `so the next rule's prelude is invalid and the browser drops that rule whole`,
      ),
    ).sort();
    expect(findings).toEqual([]);

    // The reader itself, on fixtures — the two spellings that shipped, and the
    // escaped quote that must NOT be read as one.
    const kinds = (css: string) =>
      cssStructureFindings(`<style>${css}</style>`).map(({ kind }) => kind);
    expect(kinds('.a { color: red; }')).toEqual([]);
    expect(kinds('  no opener here */ .a { color: red; }')).toEqual(['stray-terminator']);
    expect(kinds('/* no raw rounded-*/p-* */ .a { color: red; }')).toEqual(['stray-terminator']);
    // The github/gitlab shape: a banner closed early, and the prose it releases
    // opens a string that no newline closes. In a file with a LATER `/*` the
    // banner's own terminator is absorbed and the `*/` tally balances, which is
    // why the leftover-terminator count could not see those two.
    expect(
      kinds("/* ONLY --el-*/shape tokens.\n   a primitive's mapping */ .a { color: red; }"),
    ).toEqual(['unterminated-string', 'stray-terminator']);
    // An escaped quote inside a selector is not a string.
    expect(kinds(".before\\:content-\\[\\'\\'\\] { color: red; }")).toEqual([]);
  });

  it('reports a dead utility when one is actually there', () => {
    // Direction (B)'s negative path, and MOTIR-4150's own shape: a rule present
    // in the stylesheet that no element in the tree carries.
    const mocks = [
      {
        path: 'a.mock.html',
        source: '<style>.max-w-md { max-width: 28rem; }</style><p class="p">',
      },
      { path: 'b.mock.html', source: '<style>.p { margin: 0; }</style><p class="p">' },
    ];
    expect([...deadUtilities(mocks)]).toEqual([['max-w-md', ['a.mock.html']]]);
  });

  it('direction (A) — no un-prefixed arbitrary-value utility is inert', () => {
    // MOTIR-4687's own population, at zero. 115 occurrences of 12 utilities
    // across 8 assets on `origin/main` `cd77d0225`; every group was read at its
    // use site and DECLARED, none was vestigial.
    const findings = MOCKS.flatMap(({ path, source }) =>
      inertUtilities({ path, source })
        .filter(({ token }) => !isVariant(token))
        .map(
          ({ token, count }) =>
            `${path} carries \`${token}\` ${count}× and declares no rule for it — ` +
            `add the rule to this file's utility-shim block, taking any value from ` +
            `packages/design-system/theme.css, or delete the class from the attribute`,
        ),
    ).sort();
    expect(findings).toEqual([]);
  });

  it('direction (A) — the variant half stays inside its pinned budget', () => {
    const findings = MOCKS.map(({ path, source }) => ({
      path,
      count: inertUtilities({ path, source })
        .filter(({ token }) => isVariant(token))
        .reduce((total, { count }) => total + count, 0),
    })).filter(({ path, count }) => count !== (inertBudget.get(path) ?? 0));
    expect(
      findings,
      'a variant utility went inert, or a fix landed without dropping its INERT_VARIANT_DEBT row',
    ).toEqual([]);
  });

  it('holds `INERT_VARIANT_DEBT` tight — a row that no longer fires fails', () => {
    // The half that stops the table becoming a mute button. The exact-count
    // assertion above already fails a row whose file was fixed; this fails a row
    // whose FILE was deleted or renamed, which that one cannot see.
    const paths = new Set(MOCKS.map(({ path }) => path));
    for (const row of INERT_VARIANT_DEBT) {
      expect(paths.has(row.file), `${row.file} is gone — drop its row`).toBe(true);
      expect(row.count, row.file).toBeGreaterThan(0);
    }
  });

  it('direction (B) — no mock declares a rule the whole tree never carries', () => {
    const counts = deadCountByFile(MOCKS);
    const findings = MOCKS.map(({ path }) => ({ path, count: counts.get(path) ?? 0 }))
      .filter(({ path, count }) => count !== (deadBudget.get(path) ?? 0))
      .map(
        ({ path, count }) =>
          `${path} declares ${count} rule(s) no element in any mock carries ` +
          `(pinned: ${deadBudget.get(path) ?? 0}) — delete the rule, or carry the class on the ` +
          `element that wanted it; a rule nothing matches is what MOTIR-4150 read a measure off`,
      )
      .sort();
    expect(findings).toEqual([]);
  });

  it('holds `DEAD_UTILITY_DEBT` tight — a row that no longer fires fails', () => {
    const paths = new Set(MOCKS.map(({ path }) => path));
    for (const row of DEAD_UTILITY_DEBT) {
      expect(paths.has(row.file), `${row.file} is gone — drop its row`).toBe(true);
      expect(row.count, row.file).toBeGreaterThan(0);
    }
  });

  it('holds the two tables to a shrinking total', () => {
    // The number a reader checks in one line, and the one that says whether the
    // four follow-up cards are making progress. The ceilings may only be lowered:
    // direction (A)'s is the population measured on `origin/main` `cd77d0225`,
    // direction (B)'s came down 1493 -> 1122 when MOTIR-4811 swept the
    // hand-written half, and 1122 is now the two compiled builds alone.
    expect(INERT_VARIANT_DEBT.reduce((n, row) => n + row.count, 0)).toBeLessThanOrEqual(636);
    expect(DEAD_UTILITY_DEBT.reduce((n, row) => n + row.count, 0)).toBeLessThanOrEqual(1122);
  });
});
