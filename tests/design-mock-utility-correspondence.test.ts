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
const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi;

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
  for (const match of html.matchAll(STYLE_BLOCK)) blocks.push(match[1]!);
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
  return html.replace(STYLE_BLOCK, ' ').replace(SCRIPT_BLOCK, ' ');
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
 * Split out because the two halves are DIFFERENT SIZED problems and MOTIR-4687
 * fixed one of them (see `INERT_VARIANT_DEBT`), not because a variant is less
 * of a defect. `[&_svg]:h-[18px]` is a descendant rule with no state in it at
 * all: it applies unconditionally, so an undeclared one is exactly as inert as
 * an un-prefixed class, and the seven shell assets carrying it rendered every
 * nav icon at the `<svg width="24" height="24">` attribute instead of 18px
 * until MOTIR-4810 declared it in each of them.
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
  for (const mock of mocks) for (const token of usedClasses(mock.source).keys()) carried.add(token);
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
 */
export const UTILITY_PROPERTIES: Record<string, readonly string[]> = {
  bg: ['background-color'],
  border: ['border-color'],
  decoration: ['text-decoration-color'],
  divide: ['border-color'],
  duration: ['transition-duration', '--tw-duration'],
  fill: ['fill'],
  gap: ['gap'],
  h: ['height'],
  'inset-ring': ['--tw-inset-ring-color'],
  mb: ['margin-bottom'],
  'min-h': ['min-height'],
  'min-w': ['min-width'],
  mt: ['margin-top'],
  mx: ['margin-inline'],
  outline: ['outline-color'],
  p: ['padding'],
  pb: ['padding-bottom'],
  pl: ['padding-left'],
  pr: ['padding-right'],
  pt: ['padding-top'],
  px: ['padding-inline', 'padding-left', 'padding-right'],
  py: ['padding-block', 'padding-bottom', 'padding-top'],
  ring: ['--tw-ring-color'],
  'ring-offset': ['--tw-ring-offset-color'],
  rounded: ['border-radius'],
  'rounded-b': ['border-bottom-left-radius', 'border-bottom-right-radius'],
  'rounded-t': ['border-top-left-radius', 'border-top-right-radius'],
  shadow: ['--tw-shadow'],
  size: ['width', 'height'],
  'space-y': ['margin-block-start', 'margin-block-end'],
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
 */
const INERT_VARIANT_DEBT: { file: string; count: number; card: string }[] = [
  { file: 'design/ai-chat/plan-change-run-live.mock.html', count: 88, card: 'MOTIR-4813' },
  { file: 'design/ai-planning/peek-proposal-mode.mock.html', count: 2, card: 'MOTIR-4813' },
  // 8 → 4 (MOTIR-4845): the `Workspace settings` row left this menu and took its
  // whole conditional AXIS with it, so Panel B's four state frames collapsed to
  // two — the inert variants went with the two deleted frames rather than being
  // fixed. Re-measured after MOTIR-4810's structural sweep landed, not carried
  // over: that sweep touched this file's structural half and left its variant
  // half at 4, which is what this row now pins.
  { file: 'design/shell/account-menu.mock.html', count: 4, card: 'MOTIR-4813' },
  { file: 'design/shell/help-menu.mock.html', count: 6, card: 'MOTIR-4813' }, // was 34; 28 structural landed with MOTIR-4810
];

/**
 * DIRECTION (B) — MOTIR-4811 (the 87 hand-written assets) and MOTIR-4814 (the
 * two compiled builds).
 *
 * 1493 dead declarations across 89 assets, of which 1128 are in the two mocks
 * that embed a COMPILED Tailwind build (`design/shell/context-row.mock.html`
 * 873, `design/ai-chat/onboarding.mock.html` 255). For those two, unused rules
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
 * list is 1276 rows, and a 1300-line data block in a spec is read by nobody,
 * which is a worse guard than a count somebody maintains. What the count DOES
 * buy is the ratchet the pair of cards was filed for: no asset can gain a dead
 * rule, and the 85 mocks absent from this table are held at zero outright.
 *
 * ⚠️ SIX COUNTS DROPPED BY ONE (five, for `context-row`) IN MOTIR-4851, AND THE
 * RATCHET IS WHY THEY HAD TO BE EDITED RATHER THAN LEFT. A rule is dead when NO
 * element in ANY mock carries its class — the predicate is tree-wide, not
 * per-file — so a mock that starts CARRYING a class revives the dead rule
 * wherever it was declared. `design/workbench/`'s pager panels carry
 * `cursor-not-allowed`, `cursor-default`, `opacity-55`, `select-none`, `min-w-6`
 * and `text-[13px]`, which these six files had declared and nothing used. The
 * table asserts equality in BOTH directions, so a count going DOWN is a failure
 * exactly as one going up is — which is the ratchet working: the number stays a
 * measurement somebody maintains rather than a ceiling that quietly drifts.
 */
const DEAD_UTILITY_DEBT: { file: string; count: number; card: string }[] = [
  { file: 'design/ai-chat/ai-callout-menu.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/ai-chat/ask-answers.mock.html', count: 5, card: 'MOTIR-4811' },
  { file: 'design/ai-chat/canvas-spatial.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/ai-chat/onboarding.mock.html', count: 255, card: 'MOTIR-4814' },
  { file: 'design/ai-chat/plan-change-conversation.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/ai-chat/plan-change-planner-speaks.mock.html', count: 6, card: 'MOTIR-4811' },
  { file: 'design/ai-chat/plan-change-run-live.mock.html', count: 6, card: 'MOTIR-4811' },
  { file: 'design/ai-chat/planning-workspace.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/ai-chat/reading-and-handoff.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/ai-chat/target-picker.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/ai-planning/peek-proposal-mode.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/ai-planning/peek-proposed-todos.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/ai-planning/plan-canvas-grouped-roots.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/ai-planning/plan-detail-refined.mock.html', count: 6, card: 'MOTIR-4811' },
  { file: 'design/ai-usage/search-spend.mock.html', count: 9, card: 'MOTIR-4811' },
  { file: 'design/api-docs/docs-index.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/audit-coverage/audit-coverage.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/auth/legal-agreement.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/auth/passkey-sign-in.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/auth/two-factor-challenge.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/billing/billing.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/billing/ci-line.mock.html', count: 10, card: 'MOTIR-4811' },
  { file: 'design/billing/search-line.mock.html', count: 9, card: 'MOTIR-4811' },
  { file: 'design/boards/board-config.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/boards/board.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/boards/implemented-column.mock.html', count: 7, card: 'MOTIR-4811' },
  { file: 'design/boards/scrum.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/boards/swimlanes-wip.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/brand/brand-mark.mock.html', count: 22, card: 'MOTIR-4811' },
  { file: 'design/cli-connect/cli-connect.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/cli-guide/cli-guide.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/coding-convention/convention.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/design-system/element-tokens.mock.html', count: 2, card: 'MOTIR-4811' },
  { file: 'design/epic-privacy/epic-privacy.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/github/github.mock.html', count: 2, card: 'MOTIR-4811' },
  { file: 'design/gitlab/gitlab.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/notifications/drawer.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/onboarding-migrate/onboarding-migrate.mock.html', count: 10, card: 'MOTIR-4811' },
  { file: 'design/org-admin/create-workspace.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/project-square/project-square.mock.html', count: 17, card: 'MOTIR-4811' },
  { file: 'design/projects/details.mock.html', count: 5, card: 'MOTIR-4811' },
  { file: 'design/projects/inapp-plan-with-ai.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/projects/public-page.mock.html', count: 5, card: 'MOTIR-4811' },
  { file: 'design/projects/roles-permissions.mock.html', count: 2, card: 'MOTIR-4811' },
  { file: 'design/public-projects/public-changelog.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/public-projects/public-projects.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/public-projects/public-signin-modal.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/reports/dashboard.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/reports/more-reports.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/repository-set/repositories-room.mock.html', count: 2, card: 'MOTIR-4811' },
  { file: 'design/repository-set/repository-set.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/repository-set/takeover.mock.html', count: 2, card: 'MOTIR-4811' },
  { file: 'design/roadmap/full-screen.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/roadmap/locate.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/roadmap/roadmap-arrival.mock.html', count: 10, card: 'MOTIR-4811' },
  { file: 'design/roadmap/roadmap.mock.html', count: 19, card: 'MOTIR-4811' },
  { file: 'design/runs/run-modal.mock.html', count: 7, card: 'MOTIR-4811' },
  { file: 'design/runs/run-section.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/runs/runs-index.mock.html', count: 11, card: 'MOTIR-4811' },
  { file: 'design/settings/account-data.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/settings/appearance.mock.html', count: 18, card: 'MOTIR-4811' },
  { file: 'design/settings/arrival.mock.html', count: 7, card: 'MOTIR-4811' },
  { file: 'design/settings/passkeys.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/settings/permission-columns.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/settings/two-factor.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/shell/3d-immersive-shell.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/shell/account-menu.mock.html', count: 4, card: 'MOTIR-4811' },
  // 868 → 867 with MOTIR-4810, and the arithmetic is worth stating because it
  // went the OTHER way first. Removing the four vestigial `[&_.seg-*]:` tokens
  // from `child-panel-graph.mock.html` orphaned this file's compiled
  // `.[&_.seg-trail]:text-(--el-text-faint)` rule — the tree-wide predicate had
  // been holding it alive off that one carrier — so the count ROSE to 869. The
  // remedy the failure message itself prescribes is to DELETE the rule, not to
  // raise the pin: this table is a ratchet, and a count that grows to absorb the
  // diff that broke it is the mute button it exists not to be. Deleting the rule
  // dropped TWO declared names, because its nested `& .seg-trail` prelude
  // declared the second, and `.seg-trail` was already inside the pinned count.
  // (The baseline is 868 rather than the 873 this card was written against:
  // MOTIR-4851 took five off it, by the mirror of the same tree-wide predicate
  // — its pager panels started CARRYING classes these files had declared and
  // nothing used. Same mechanism, opposite direction.)
  { file: 'design/shell/context-row.mock.html', count: 867, card: 'MOTIR-4814' },
  { file: 'design/shell/help-menu.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/shell/navigation-pending.mock.html', count: 6, card: 'MOTIR-4811' },
  { file: 'design/shell/rail-bottom-section.mock.html', count: 5, card: 'MOTIR-4811' },
  { file: 'design/shell/top-bar.mock.html', count: 2, card: 'MOTIR-4811' },
  { file: 'design/triage/triage.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/work-items/acceptance-panel.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/work-items/activity-history.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/work-items/child-panel-graph.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/work-items/delivery-set.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/work-items/design-result.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/work-items/detail-arrival.mock.html', count: 5, card: 'MOTIR-4811' },
  { file: 'design/work-items/draft-with-ai.mock.html', count: 2, card: 'MOTIR-4811' },
  { file: 'design/work-items/labels-components-watch.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/work-items/pending-plan-indicator.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/work-items/provenance.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/work-items/repository-set.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/work-items/saved-filters.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/work-items/todo-list.mock.html', count: 3, card: 'MOTIR-4811' },
  { file: 'design/work-items/type-executor-picker.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/workbench/workbench.mock.html', count: 15, card: 'MOTIR-4811' },
  { file: 'design/workspaces/invite-arrival.mock.html', count: 6, card: 'MOTIR-4811' },
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
    // four follow-up cards are making progress. The ceilings are the populations
    // measured on `origin/main` `cd77d0225`; they may only be lowered.
    // 636 → 104 with MOTIR-4810: the whole structural half landed at once,
    // which is what the ratchet is for — the ceiling comes DOWN with the fix and
    // cannot go back up.
    expect(INERT_VARIANT_DEBT.reduce((n, row) => n + row.count, 0)).toBeLessThanOrEqual(104);
    // Direction (B)'s ceiling stays at its measured population: MOTIR-4851 took
    // ten off the table and MOTIR-4810 one more without lowering it, because the
    // per-file rows are the real ratchet here — each is asserted EXACT, so the
    // ceiling is a backstop rather than the instrument.
    expect(DEAD_UTILITY_DEBT.reduce((n, row) => n + row.count, 0)).toBeLessThanOrEqual(1493);
  });
});
