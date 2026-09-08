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
//       does nothing and the element renders at whatever it inherits. The
//       predicate is ARBITRARY-VALUE **or** VARIANT-PREFIXED (MOTIR-4890
//       widened it from the first alone; `isArbitrary`'s note carries why, and
//       where the widening stops).
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
//   (C) MIS-DECLARED — a rule exists, an element carries it, and it paints a
//       DIFFERENT token from the one its own name promises (MOTIR-4812). Five
//       assets declared `.text-\(--el-text-faint\)` as
//       `color: var(--el-text-secondary)`.
//
// (A) silently un-styles the ASSET; (B) misleads a READER; (C) survives both,
// because the class exists and the rule exists and they are in correspondence —
// the rule is simply not what it says. One cause, three costs, which is why
// fixing one alone leaves the set incomplete.
//
// ── Why no existing guard sees any of them ──────────────────────────────────
// `design-ink-contrast` and `design-state-ink-contrast` read the ink a rule
// NAMES; `design-token-layer` rules on the token block; `design-dark-parity` on
// the dark scope. All of them ask what a rule SAYS, and none asks whether any
// rule APPLIES. Worse, the direction of the risk is inverted: an un-styled
// element usually inherits `--el-text`, which PASSES contrast, so direction (A)
// makes those guards greener rather than redder.
//
// (C) is invisible to them for a different reason, and it is worth stating
// exactly because MOTIR-4812's title states it the other way round. The ink
// guards do NOT read the declaration for a class-carried ink: `inkVia`
// (`tests/theme/inkContrastMockScan.ts`) returns `'class'` the moment an
// element carries `text-(--el-text-faint)`, and only falls through to the
// stylesheet for an element that does not. So a re-pointed utility does not
// hand the guard a greener answer — it makes the guard's verdict and the
// asset's pixels describe different colours, in either direction, with nothing
// anywhere comparing the two. That is what this direction restores.
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
 * ⚠️ THE REASON THIS PREDICATE WAS GIVEN IS FALSE HERE, AND IT IS CORRECTED
 * RATHER THAN DELETED BECAUSE IT IS THE KIND OF SENTENCE A READER RE-DERIVES
 * (MOTIR-4890). It used to read: *"a plain `.flex` may legitimately be missing
 * from a mock that inherits a stylesheet; an arbitrary-value utility has no
 * such fallback, because nothing generates it."* That is true of APPLICATION
 * code, where a plain utility does come from a shared Tailwind build. **A
 * `*.mock.html` inherits no stylesheet** — it is a single self-contained
 * document whose only CSS is its own hand-written shim block, which is the
 * premise this whole guard is built on, stated at the top of this file. So the
 * exemption had no referent, and a plain class an asset carries and never
 * declares is exactly as inert as an arbitrary-value one.
 *
 * ⚠️ SO DIRECTION (A) NO LONGER FILTERS ON IT — `inertUtilities` reports a
 * token that is arbitrary OR variant-prefixed. What the predicate still does is
 * SPLIT the two arms below, which are different sized problems, and it is the
 * measurement rather than the argument that decides where the guard stops. Over
 * `git ls-tree -r origin/main design/` at `a5b443e00`, 176 mocks:
 *
 *   • `isVariant` (arbitrary or plain) — **93 occurrences, 6 distinct, 1
 *     asset**, all of them plain, because the arbitrary half is already at
 *     zero. Tractable, and dispositioned by MOTIR-4890 (see
 *     `INERT_VARIANT_DEBT`).
 *   • EVERY undeclared class — **4512 occurrences, 167 distinct, 46 assets**,
 *     of which **4116 are `lucide` / `lucide-*`**: the class names Lucide's own
 *     SVG output stamps on an icon (`class="lucide lucide-menu h-5 w-5"`). They
 *     are an identity marker, not a utility, and no shim block should ever
 *     declare one. The residue is **303 occurrences of 50 across 36 assets**
 *     and does not resolve to a single disposition either — it mixes genuinely
 *     inert Tailwind utilities (`underline` 24, `underline-offset-2` 24,
 *     `size-3` 8, `items-stretch` 9) with more hook names (`nl` 21, `ic` 20,
 *     `seg-ic` 20, `brand-glyph` 19, `ProseMirror` 7, `tiptap` 7).
 *
 * **A predicate whose population is 91% one library's identity namespace is not
 * a widening this guard can hold at zero**, and the honest form of the
 * remainder is a class test that separates a STYLE utility from a HOOK — which
 * is its own card, not a filter to guess at here. That is MOTIR-4921, with this
 * measurement and its command.
 */
export const isArbitrary = (token: string): boolean => token.includes('[') || token.includes('(');

/**
 * A VARIANT-prefixed token — `hover:`, `focus-visible:`, `data-[state=…]:`,
 * `[&_svg]:`.
 *
 * ⚠️ SINCE MOTIR-4890 THIS IS THE PREDICATE DIRECTION (A) IS ABOUT, not a
 * sub-filter of `isArbitrary`: a variant is reported whether or not it carries
 * `[` or `(`, so `disabled:opacity-50` is a finding on the same terms as
 * `hover:text-(--el-text)`.
 *
 * Split out because the two halves are DIFFERENT SIZED problems and MOTIR-4687
 * fixed one of them (see `INERT_VARIANT_DEBT`), not because a variant is less
 * of a defect. `[&_svg]:h-[18px]` is a descendant rule with no state in it at
 * all: it applies unconditionally, so an undeclared one is exactly as inert as
 * an un-prefixed class, and the seven shell assets carrying it rendered every
 * nav icon at the `<svg width="24" height="24">` attribute instead of 18px
 * until MOTIR-4810 declared it in each of them.
 */
export const isVariant = (token: string): boolean => token.includes(':') || token.includes('&');

/**
 * DIRECTION (A): arbitrary-value OR variant-prefixed classes an asset carries
 * and does not declare.
 *
 * ⚠️ THE `||` IS MOTIR-4890's WIDENING. It was `isArbitrary(token)` alone, and
 * that filter could not see a PLAIN inert variant at all — 93 occurrences of 6
 * survived the arbitrary half reaching zero, on the argument corrected at
 * `isArbitrary` above. The two arms below then split this set on `isVariant`,
 * so the un-prefixed arm is unchanged (`isArbitrary && !isVariant`) and the
 * variant arm is every variant.
 */
export function inertUtilities(mock: MockSource): { token: string; count: number }[] {
  const declared = declaredClasses(mock.source);
  return [...usedClasses(mock.source)]
    .filter(([token]) => (isArbitrary(token) || isVariant(token)) && !declared.has(token))
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

// ── DIRECTION (C): the rule agrees with its own NAME (MOTIR-4812) ───────────
//
// The two directions above both ask about EXISTENCE — does this class have a
// rule, does this rule have a class. Neither asks whether the rule DOES what
// its name says, and an arbitrary-value utility's name is a promise about
// exactly one thing: `.text-\(--el-text-faint\)` paints `--el-text-faint`.
//
// Nothing forces that, because the shim block is hand-written. Five assets
// declared `.text-\(--el-text-faint\)` as `color: var(--el-text-secondary)`,
// and the four elements carrying it in
// `design/ai-planning/plan-detail-refined.mock.html` were therefore marked
// faint in the markup — which is what a reader and every later card reads —
// while painting secondary. `--el-text-faint` clears AA on no surface and is
// enforced at zero, so re-pointing the utility is the cheapest way to make an
// asset go green, and it is indistinguishable afterwards from having decided
// which ink the element should carry.
//
// ⚠️ THE DISCRIMINATOR IS THE PROPERTY THE UTILITY OWNS, not the shape of the
// rule. MOTIR-4812 proposed scoping this to single-PROPERTY declarations, on
// the grounds that a `[data-style]` / `@scope` block legitimately hangs a
// `box-shadow` off `.rounded-\(--radius-card\)`. That scoping does not
// discriminate its own example: those 18 overrides ARE single-property rules
// (`@scope ([data-style='3d-immersive']) … { .rounded-\(--radius-card\) {
// box-shadow: var(--shadow-card) } }`), so they would be reported, while the
// two-property rules `.shadow-\(--shadow-card\)` and
// `.duration-\(--transition-duration\)` — which DO carry the promise — would
// not be checked. What separates an override from a mis-declaration is that an
// override sets a property the utility does not name. So the map below records
// the property each prefix owns, and a declaration of anything else on the same
// selector is left alone.
export type UtilityRule = {
  className: string;
  prefix: string;
  token: string;
  declarations: string[];
};

type CssBlock = { prelude: string; declarations: string[]; children: CssBlock[] };

/**
 * A stylesheet as a tree of blocks, each with its OWN declarations.
 *
 * `selectorPreludes` above flattens to prelude text because direction (B) only
 * needs the names; this direction needs the body that goes with one, and it
 * needs nesting: `.divide-\(--el-border\)` declares nothing itself and puts
 * `border-color: var(--el-border)` inside a nested
 * `:where(& > :not(:last-child))`, and `@scope` / `@media` wrap real rules one
 * or two levels down.
 */
export function parseBlocks(css: string): CssBlock[] {
  const roots: CssBlock[] = [];
  const stack: CssBlock[] = [];
  let buffer = '';
  const flush = () => {
    const block = stack[stack.length - 1];
    if (block && buffer.trim()) block.declarations.push(buffer.trim());
    buffer = '';
  };
  for (const ch of css) {
    if (ch === '{') {
      const block: CssBlock = { prelude: buffer.trim(), declarations: [], children: [] };
      (stack[stack.length - 1]?.children ?? roots).push(block);
      stack.push(block);
      buffer = '';
    } else if (ch === '}') {
      flush();
      stack.pop();
    } else if (ch === ';') {
      flush();
    } else {
      buffer += ch;
    }
  }
  return roots;
}

/** A prelude that is exactly ONE class selector — no compound, no combinator. */
const LONE_CLASS_SELECTOR = /^\.((?:\\.|[A-Za-z0-9_-])+)$/;

/** `text-(--el-text-faint)` → prefix `text`, token `--el-text-faint`. */
const ARBITRARY_UTILITY = /^([a-z][a-z-]*)-\((--[a-z0-9-]+)\)$/;

/** A value that is a bare token reference, and nothing else. */
const BARE_VAR = /^var\(\s*(--[a-z0-9-]+)\s*\)$/;

/**
 * The property each arbitrary-value utility PREFIX sets — the promise its name
 * makes. Derived from the tree rather than from Tailwind's documentation: every
 * prefix below occurs in `design/**`, and the totality assertion in the spec
 * fails if a prefix appears that this map does not carry, so a new utility
 * family cannot be added and silently left unchecked.
 *
 * The `--tw-*` entries are not an oversight: Tailwind's own output writes the
 * token into a custom property and then composes the real one out of several
 * (`box-shadow: var(--tw-inset-shadow), …, var(--tw-shadow)`), so the
 * declaration that carries the promise is the custom property, and the composed
 * one is not a bare `var()` at all.
 *
 * ⚠️ TEN PREFIXES LEFT THIS MAP WITH MOTIR-4814, and the map is derived rather
 * than curated precisely so that they had to: `gap`, `inset-ring`, `min-h`, `mx`,
 * `outline`, `pb`, `pt`, `rounded-b`, `rounded-t` and `space-y` occurred in the
 * tree ONLY inside the two swept assets' dead rules, so a sweep that emptied
 * `DEAD_UTILITY_DEBT` also took the last rule each of them had. The totality arm
 * caught every one — which is what a map that may only grow could never do.
 */
export const UTILITY_PROPERTIES: Record<string, readonly string[]> = {
  bg: ['background-color'],
  border: ['border-color'],
  decoration: ['text-decoration-color'],
  divide: ['border-color'],
  duration: ['transition-duration', '--tw-duration'],
  fill: ['fill'],
  h: ['height'],
  mb: ['margin-bottom'],
  'min-w': ['min-width'],
  mt: ['margin-top'],
  p: ['padding'],
  pl: ['padding-left'],
  pr: ['padding-right'],
  px: ['padding-inline', 'padding-left', 'padding-right'],
  py: ['padding-block', 'padding-bottom', 'padding-top'],
  ring: ['--tw-ring-color'],
  'ring-offset': ['--tw-ring-offset-color'],
  rounded: ['border-radius'],
  shadow: ['--tw-shadow'],
  size: ['width', 'height'],
  stroke: ['stroke'],
  text: ['color'],
  w: ['width'],
};

/** Every declaration a block owns, its nested blocks' included. */
function declarationsWithin(block: CssBlock, out: string[] = []): string[] {
  out.push(...block.declarations);
  for (const child of block.children) declarationsWithin(child, out);
  return out;
}

/** Every rule in a mock whose selector is one arbitrary-value utility class. */
export function utilityRules(html: string): UtilityRule[] {
  const rules: UtilityRule[] = [];
  const walk = (blocks: CssBlock[]) => {
    for (const block of blocks) {
      const selector = LONE_CLASS_SELECTOR.exec(block.prelude);
      const utility = selector && ARBITRARY_UTILITY.exec(unescapeCss(selector[1]!));
      if (selector && utility) {
        rules.push({
          className: unescapeCss(selector[1]!),
          prefix: utility[1]!,
          token: utility[2]!,
          declarations: declarationsWithin(block),
        });
      }
      walk(block.children);
    }
  };
  walk(parseBlocks(stylesheetOf(html)));
  return rules;
}

/**
 * DIRECTION (C): a rule whose selector names one token and whose declaration of
 * the property that utility OWNS references a different one — plus a rule whose
 * prefix this file has no property for, which is reported rather than skipped so
 * the check cannot pass vacuously on a family nobody mapped.
 */
export function misdeclaredUtilities(mock: MockSource): string[] {
  const findings: string[] = [];
  for (const rule of utilityRules(mock.source)) {
    const owned = UTILITY_PROPERTIES[rule.prefix];
    if (!owned) {
      findings.push(
        `${mock.path} declares \`.${rule.className}\` and UTILITY_PROPERTIES has no entry for ` +
          `\`${rule.prefix}\` — add the property that prefix sets, so the rule is checked against ` +
          `its own name rather than skipped`,
      );
      continue;
    }
    for (const declaration of rule.declarations) {
      const colon = declaration.indexOf(':');
      if (colon === -1) continue;
      const property = declaration.slice(0, colon).trim();
      const value = declaration.slice(colon + 1).trim();
      if (!owned.includes(property)) continue;
      const referenced = BARE_VAR.exec(value)?.[1];
      if (referenced && referenced !== rule.token) {
        findings.push(
          `${mock.path} declares \`.${rule.className}\` as \`${property}: ${value}\` — a utility ` +
            `named for \`${rule.token}\` must declare \`${rule.token}\`. If the other token is the ` +
            `ink you want, change the CLASS on the element; re-pointing the rule makes two assets ` +
            `mean different things by one name, and hands every ink guard the answer it reports`,
        );
      }
    }
  }
  return findings;
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
 * DIRECTION (A), variant-prefixed half — MOTIR-4813 (state). The STRUCTURAL
 * half was MOTIR-4810 and is at zero.
 *
 * MOTIR-4687 took the UN-PREFIXED half to zero: 11 utility groups declared
 * across 7 assets, each read at its use site to tell a wanted style from a
 * vestigial class. The variant half was 636 occurrences of 14 utilities across
 * these 11 assets — 532 structural, 104 stateful — and it was NOT the same size
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
 * ── What MOTIR-4810 did with those two, and why only one of them arose ──────
 * The `[&_svg]:h-[18px]` / `[&_svg]:w-[18px]` occurrences were DECLARED, in the
 * form `design/shell/rail-bottom-section.mock.html` already carried — it is the
 * control that rules out "the mocks intend 24px", and copying its rule rather
 * than authoring one is what keeps the shell assets saying the same thing.
 * Every affected `.png` was re-exported.
 *
 * ⚠️ SIX assets, 344 occurrences — not the seven and 484 the population had,
 * because `design/workbench/workbench.mock.html` (140) LANDED FIRST, in
 * MOTIR-4851, which declared the same pair while redrawing the pager. Two cards
 * fixing one asset's inert utilities independently is not a collision to
 * prevent: the row simply left this table under whichever landed first, and the
 * second found its own edit already made. What it does mean is that a count
 * taken when a card is FILED is a measurement of that moment — MOTIR-4862 is
 * the planning bug about this card's numbers, and this is the benign half of
 * the same fact.
 *
 * The 48 `[&_.seg-ic]:` / `[&_.seg-trail]:` occurrences in
 * `design/work-items/child-panel-graph.mock.html` were REMOVED, and the second
 * bullet above therefore never fired: the strings `seg-ic` and `seg-trail`
 * occurred in that file ONLY inside those class tokens — 24 each, all of them
 * the token's own text — so the segmented control has no icon and no trailing
 * element for the rule to paint. They select nothing, which makes them
 * vestigial rather than a token question, and no ink reached
 * `design-state-ink-contrast` at all. ⚠️ That is NOT the same act as pointing
 * `--el-text-faint` at a passing token to quieten an arm — the defect
 * MOTIR-4812 exists for — and the discriminator is checked, not asserted: a
 * REMOVE is only honest where the selector matches no element, which is a
 * grep, and where it matches one the answer is the ink question.
 *
 * The counts are OCCURRENCES, not distinct utilities, so the table measures how
 * much of each asset is inert. A file whose two halves belong to different
 * cards names both, and the first of them to land DECREMENTS the row rather
 * than deleting it — which is what `design/shell/help-menu.mock.html` did here,
 * 34 → 6.
 *
 * ⚠️ EMPTY, AND THAT IS THE POINT OF THE TABLE RATHER THAN AN ABSENCE OF ONE.
 * MOTIR-4810 took 636 → 104 (the structural `[&_…]:` half), MOTIR-4845 took
 * 104 → 100 without meaning to, and MOTIR-4813 took 100 → 0 (the STATE half),
 * so direction (A) is now at zero over the WHOLE tree in both halves and the
 * exact-count arm below holds every mock there.
 *
 * The middle step is worth a line because it is the only one nobody planned:
 * MOTIR-4845 removed the `Workspace settings` row from `account-menu`, which
 * took that panel's whole conditional AXIS with it, so two of its four frames
 * collapsed and 4 inert occurrences went with them. Four fewer defects and
 * not one of them fixed — which is why the row was RE-MEASURED there rather
 * than decremented by arithmetic.
 * The table stays because it is the ratchet: an inert variant landing in any
 * asset now fails with no row to hide behind, and a row added back has to
 * carry a card that says why.
 *
 * ⚠️ ZERO USED TO BE ZERO FOR `isArbitrary` ONLY, WHICH WAS NARROWER THAN IT
 * READ — MOTIR-4890 WIDENED IT AND TOOK THE REMAINDER TO ZERO. 93 occurrences
 * of 6 PLAIN inert variants survived the arm reaching zero, all in
 * `design/ai-chat/plan-change-run-live.mock.html`, because `inertUtilities`
 * filtered on `isArbitrary` and a plain token carries no `[` or `(`. The
 * exemption's stated reason was that a plain class may come from an inherited
 * stylesheet, and a `*.mock.html` inherits none — the correction is at
 * `isArbitrary`, with the measurement that chose the widening's ceiling.
 *
 * What MOTIR-4890 disposed of, per utility, on MOTIR-4813's terms — all six
 * DECLARE, and the discriminator is that every one is a verbatim transcription
 * of a class list the SHIPPED component carries, so the rule to copy already
 * existed rather than being authored here:
 *
 *   `disabled:opacity-50` 25 · `disabled:pointer-events-none` 16
 *   (`packages/design-system/src/components/ui/Button.tsx:34`),
 *   `focus-visible:ring-offset-2` 16 · `focus-visible:ring-offset-background`
 *   16 (`Button.tsx:33`), `hover:opacity-90` 11 (`Button.tsx:39`, the primary
 *   variant), `disabled:opacity-60` 9
 *   (`components/planning/PlanChangeComposer.tsx:432`, the composer input the
 *   asset draws). Every rule was copied verbatim from
 *   `design/shell/context-row.mock.html`, which declares all six — the control
 *   that rules out "the mocks intend otherwise", the same move MOTIR-4810 made
 *   with `rail-bottom-section`. The `@property --tw-ring-offset-color` block
 *   and its `@layer properties` fallback were copied with them, because
 *   `.focus-visible\:ring-offset-2` writes a shadow that reads that property
 *   and MOTIR-4813 declared only the ring's width and colour — a DECLARE that
 *   still renders nothing is not a fix.
 *
 * ⚠️ ONE of the six PAINTS AT REST and moved the `.png`: the asset has exactly
 * one `disabled=""` element, the secondary *Stop* button in the run-live
 * footer, and declaring `disabled:opacity-50` dims it to 50% — which is what
 * the shipped Button does and what every reader of the export should see. The
 * other five are state-conditional and fire in the browser a reviewer opens the
 * mock in. REMOVE was not available for any of them: a REMOVE is honest only
 * where the selector matches no element, and every one of these sits on a real
 * button or input.
 *
 * What MOTIR-4813 disposed of, per utility rather than per class — the
 * judgement the card exists for, since "a static mock is never hovered" is an
 * answer that ends the enquiry and is false three ways here:
 *
 *   DECLARE (7 rules across 2 assets; the class is on a real element that
 *   wants it) — `focus-visible:ring-(--focus-ring-color)` 34,
 *   `hover:bg-(--el-surface-soft)` 18, `active:scale-(--active-scale)` 16,
 *   `hover:text-(--el-text)` 11 and `placeholder:text-(--el-text-secondary)`
 *   9 in `plan-change-run-live`, `active:bg-(--el-surface-soft)` 2 in
 *   `peek-proposal-mode`. The placeholder one paints with no interaction at
 *   all, so it moved that asset's `.png`; the rest fire in the browser a
 *   reviewer opens the mock in. `focus-visible:ring-2` and
 *   `focus-visible:outline-none` were declared alongside — they are not
 *   arbitrary and so are invisible to this guard, but the ring COLOUR alone
 *   paints nothing without the rule that composes the shadow, and a DECLARE
 *   that still renders nothing is not a fix. The eight `@property --tw-*`
 *   blocks that composition reads were copied verbatim from
 *   `peek-proposal-mode`, which already carried them.
 *
 *   REMOVE (5 elements across 2 assets — 2 in `account-menu`, 3 in
 *   `help-menu`; it was 7 before MOTIR-4845 deleted two of the four frames)
 *   — `data-[state=open]:animate-in` and
 *   `data-[state=closed]:animate-out` on the popover panels of `account-menu`
 *   and `help-menu`, with `fade-in-0` / `fade-out-0` (not arbitrary, so not
 *   counted here) in the same four-class group. Both are a verbatim
 *   transcription of `packages/design-system/src/components/ui/Popover.tsx`
 *   line 98 — and NOTHING in this repository generates them: there is no
 *   `tailwindcss-animate` / `tw-animate-css` dependency, no `@keyframes enter`
 *   or `exit`, and no `--tw-enter-*`, so they are inert in the SHIPPED
 *   component too — filed as MOTIR-4889 against all four sites. There is
 *   therefore no value in
 *   `packages/design-system/theme.css` to declare them from, and inventing an
 *   animation the product does not have is the opposite of designing against
 *   shipped reality. `data-[state=closed]:` additionally selects nothing here
 *   under any reading: every panel in both assets carries a literal
 *   `data-state="open"`.
 */
const INERT_VARIANT_DEBT: { file: string; count: number; card: string }[] = [];

/**
 * DIRECTION (B) — EMPTY, and it is meant to stay that way. MOTIR-4811 swept the
 * hand-written half; MOTIR-4814 swept the 1116 rules its two remaining rows
 * pinned, and the direction is now enforced at ZERO over every mock in the tree.
 *
 * ⚠️ MOTIR-4814 WAS FILED TO DECIDE WHETHER MACHINE OUTPUT SHOULD BE EXCUSED BY A
 * PREDICATE INSTEAD, AND THE MEASUREMENT ANSWERED IT NO. The premise was that the
 * two rows were the tree's two COMPILED Tailwind builds, for which unused rules
 * are the normal state of machine output. Both halves of that failed:
 *
 *   • The proposed fingerprint does not separate anything, and it fails in BOTH
 *     directions. `--tw-` appears in 24 of the 176 mocks, three of them
 *     hand-written (`shell/navigation-pending`, `work-items/detail-arrival`,
 *     `work-items/pending-plan-indicator`) — a shim block that copies Tailwind's
 *     own two-property output for `.shadow-\(--shadow-card\)` carries the
 *     namespace — and it appears NOT ONCE in `design/ai-chat/onboarding.mock.html`,
 *     one of the two assets the predicate existed to excuse.
 *   • The real fingerprint, the build's own `tailwindcss v4.3.0` banner, matches
 *     TWENTY-ONE assets, TWENTY of which this guard already held at zero — and
 *     EIGHTEEN of the twenty-one were swept by hand in MOTIR-4811, an hour before
 *     this card was claimed. Excusing compiled builds would therefore un-ratchet
 *     twenty assets to buy an exemption for one, which is the
 *     exemption-wider-than-it-reads shape a debt table exists to prevent — and it
 *     would excuse a class of file the tree has already decided it sweeps.
 *
 * And `onboarding` is not a compiled build at all: no banner, no `--tw-`, no
 * `@layer`, and its 249 dead rules were the mock's OWN semantic classes
 * (`.adv-knob`, `.dwz-step`, `.diff-add`) left behind by panels that no longer
 * exist — MOTIR-4811's population exactly, split off by a premise that did not hold.
 * So both were swept, which is what the rest of the tree already does.
 *
 * ⚠️ A SWEPT RULE IS RENDER-NEUTRAL BY CONSTRUCTION, and that is the whole warrant:
 * a rule is removed only when its selector REQUIRES a class no element in any mock
 * carries, so it matched nothing before the edit. In `onboarding` that also took 17
 * rules whose selector paired a live class with a dead one (`.dfield .dlabel`) —
 * every one of those still declared in another mock, and none of them reachable
 * here, since nothing carries the ancestor. Both files' markup and scripts are
 * byte-identical to what they were, so no `.png` moves.
 *
 * ⚠️ THIS TABLE WAS A COUNT AND NOT A NAME LIST, and that is why it is empty rather
 * than pinned: swapping one dead rule for another inside a file passed. The name
 * list was 1276 rows, and a 1300-line data block in a spec is read by nobody. What
 * the count bought was the ratchet, and the ratchet has now reached its floor —
 * every mock is held at zero outright, which is a stronger statement than any
 * budget. A row added here is a regression to explain, not a debt to schedule.
 *
 * ⚠️ THE PREDICATE IS TREE-WIDE, WHICH CUTS BOTH WAYS, AND MOTIR-4851 IS THE
 * WORKED EXAMPLE. A rule is dead when NO element in ANY mock carries its class,
 * so a mock that starts CARRYING one changes the answer for every OTHER file
 * that declares it: `design/workbench/`'s pager panels picked up
 * `cursor-not-allowed`, `cursor-default`, `opacity-55`, `select-none`, `min-w-6`
 * and `text-[13px]`, and six rows in this table dropped by one.
 *
 * ⚠️ WITH BOTH HALVES SWEPT, THAT SAME MOVE NOW LANDS ON DIRECTION (A), which is a
 * sharper failure and the reason to keep saying it. There is no dead rule left for
 * a new element to revive: a mock that begins carrying a class whose declaration
 * one of these sweeps removed is an INERT class, and direction (A) is enforced at
 * ZERO. **So a sweep of this kind is re-derived against the tree it will land on,
 * never against the tree it was planned on** — MOTIR-4811's population had to be
 * recomputed after MOTIR-4851, MOTIR-4812 and MOTIR-4810 merged under it, and this
 * card's two rows had moved 873 → 867 and 255 → 249 under MOTIR-4811 in the eleven
 * minutes between its merge and this card's claim.
 *
 * The type and the hold-it-tight arm below survive an empty table so a future row
 * stays expressible — with a card, a count and a reason — rather than inviting a
 * `deadBudget` bypass written some other way.
 */
const DEAD_UTILITY_DEBT: { file: string; count: number; card: string }[] = [];

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

  it('reports a PLAIN inert variant, and stops at a plain un-prefixed class', () => {
    // MOTIR-4890's widening, pinned in both directions on a fixture — the real
    // tree is at zero for direction (A), so nothing else here exercises the new
    // reporting branch, and nothing else pins where it STOPS.
    const fixture = [
      '<style>.opacity-80 { opacity: 80%; }</style>',
      '<button class="disabled:opacity-50 opacity-80 lucide lucide-menu"></button>',
    ].join('\n');
    // The variant is reported though it carries neither `[` nor `(` — the case
    // `isArbitrary` alone could not see.
    expect(inertUtilities({ path: 'fixture', source: fixture })).toEqual([
      { token: 'disabled:opacity-50', count: 1 },
    ]);
    // And the icon library's own identity classes are NOT: they are a hook
    // rather than a utility, and 4116 of the 4419 occurrences an
    // every-plain-class predicate would report are exactly these.
    expect(isVariant('lucide-menu')).toBe(false);
    expect(isArbitrary('lucide-menu')).toBe(false);
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

  it('holds `DEAD_UTILITY_DEBT` tight — and it is EMPTY, which is the point', () => {
    // The emptiness is asserted FIRST because the loop below says nothing about an
    // empty table: with no rows it passes whatever the tree looks like, so a spec
    // that only looped would report green on a table somebody had refilled. The
    // direction-(B) arm above is what holds every mock at zero; this is what stops
    // a row being added back without a card, a count and a reason beside it.
    expect(
      DEAD_UTILITY_DEBT,
      'direction (B) is at zero over the whole tree (MOTIR-4811 + MOTIR-4814) — a ' +
        'new row is a regression to explain, not a debt to schedule',
    ).toEqual([]);
    const paths = new Set(MOCKS.map(({ path }) => path));
    for (const row of DEAD_UTILITY_DEBT) {
      expect(paths.has(row.file), `${row.file} is gone — drop its row`).toBe(true);
      expect(row.count, row.file).toBeGreaterThan(0);
    }
  });

  it('reports a mis-declared utility, and leaves a legitimate override alone', () => {
    // Direction (C)'s negative path, on the shape MOTIR-4812 was filed for and
    // on the one the card's own proposed scoping would have caught by mistake.
    const broken = {
      path: 'fixture.mock.html',
      source: '<style>.text-\\(--el-text-faint\\) { color: var(--el-text-secondary); }</style>',
    };
    expect(misdeclaredUtilities(broken)).toHaveLength(1);
    expect(misdeclaredUtilities(broken)[0]).toContain('must declare `--el-text-faint`');

    // The `@scope` override: single-property, and NOT a mis-declaration —
    // `box-shadow` is not the property `rounded` names, so the rule adds a
    // shadow to an existing class rather than re-pointing it.
    expect(
      misdeclaredUtilities({
        path: 'fixture.mock.html',
        source:
          `<style>@scope ([data-style='3d-immersive']) to ([data-style]) {` +
          `.rounded-\\(--radius-card\\) { box-shadow: var(--shadow-card); }}</style>`,
      }),
      'an override sets a property the utility does not name',
    ).toEqual([]);

    // Tailwind's own two-property output, which DOES carry the promise: the
    // token is written into the custom property, and the composed `box-shadow`
    // is not a bare `var()` at all.
    expect(
      misdeclaredUtilities({
        path: 'fixture.mock.html',
        source:
          '<style>.shadow-\\(--shadow-card\\) { --tw-shadow: var(--shadow-card); ' +
          'box-shadow: var(--tw-inset-shadow), var(--tw-ring-shadow), var(--tw-shadow); }</style>',
      }),
    ).toEqual([]);

    // A NESTED declaration is the rule's own — `.divide-(--el-border)` declares
    // nothing at its top level.
    expect(
      misdeclaredUtilities({
        path: 'fixture.mock.html',
        source:
          '<style>.divide-\\(--el-border\\) { :where(& > :not(:last-child)) { ' +
          'border-color: var(--el-border-soft); } }</style>',
      }).length,
      'a nested declaration carries the promise too',
    ).toBe(1);

    // An unmapped prefix is REPORTED, never skipped — otherwise a new utility
    // family arrives unchecked and the arm reads green about a set it dropped.
    expect(
      misdeclaredUtilities({
        path: 'fixture.mock.html',
        source: '<style>.tracking-\\(--el-track\\) { letter-spacing: var(--el-other); }</style>',
      })[0],
    ).toContain('UTILITY_PROPERTIES has no entry for `tracking`');
  });

  it('direction (C) — every utility rule declares the token its NAME promises', () => {
    // MOTIR-4812's own population, at zero. Five assets declared
    // `.text-\(--el-text-faint\)` as `color: var(--el-text-secondary)`; four of
    // them carried it on nothing, and the fifth painted four aria-hidden
    // chevrons a colour their markup did not name.
    expect(MOCKS.flatMap(misdeclaredUtilities).sort()).toEqual([]);
  });

  it('holds `UTILITY_PROPERTIES` tight — an entry no rule in the tree uses fails', () => {
    // The same treatment the two debt tables get, for the same reason: a map
    // that may only grow accumulates rows nobody can tell from live ones. The
    // arm above fails on a prefix the map is MISSING; this fails on one the tree
    // no longer has.
    const present = new Set(
      MOCKS.flatMap(({ source }) => utilityRules(source)).map((r) => r.prefix),
    );
    expect([...Object.keys(UTILITY_PROPERTIES)].filter((prefix) => !present.has(prefix))).toEqual(
      [],
    );
  });

  it('holds the two tables to a shrinking total', () => {
    // The number a reader checks in one line, and the one that says whether the
    // four follow-up cards are making progress. The ceilings may only be lowered.
    // 636 → 104 with MOTIR-4810 (the structural half), 104 → 100 with
    // MOTIR-4845 (two frames deleted, not fixed), 100 → 0 with MOTIR-4813 (the
    // state half), which is what the ratchet is for — the ceiling comes
    // DOWN with the fix and cannot go back up. At zero it is no longer a budget
    // but a floor, and the exact-count arm above is what enforces it per file.
    expect(INERT_VARIANT_DEBT.reduce((n, row) => n + row.count, 0)).toBeLessThanOrEqual(0);
    // Direction (B)'s came down the same way and has now reached the same floor.
    // MOTIR-4851 and MOTIR-4810 each took rows off the table WITHOUT lowering it,
    // correctly — the per-file rows were the real ratchet there, each asserted
    // EXACT, so the ceiling was a backstop rather than the instrument. MOTIR-4811
    // took the hand-written half (1493 → 1116) and MOTIR-4814 the two rows left,
    // so the ceiling is 0 and the per-file arm now holds all 176 mocks at zero
    // outright rather than 174 of them. **Both tables are empty**: every mock is
    // held at zero in both directions, which is a stronger statement than any
    // pair of budgets, and a row appearing in either is a regression to explain.
    expect(DEAD_UTILITY_DEBT.reduce((n, row) => n + row.count, 0)).toBe(0);
  });
});
