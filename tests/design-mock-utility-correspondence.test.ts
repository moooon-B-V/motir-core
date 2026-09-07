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
 * The 484 `[&_svg]:h-[18px]` / `[&_svg]:w-[18px]` occurrences across seven
 * assets were DECLARED, in the form `design/shell/rail-bottom-section.mock.html`
 * already carried — it is the control that rules out "the mocks intend 24px",
 * and copying its rule rather than authoring one is what keeps the eight shell
 * assets saying the same thing. Every affected `.png` was re-exported.
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
  { file: 'design/shell/account-menu.mock.html', count: 8, card: 'MOTIR-4813' },
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
  { file: 'design/ai-planning/peek-proposed-todos.mock.html', count: 5, card: 'MOTIR-4811' },
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
  { file: 'design/runs/run-modal.mock.html', count: 8, card: 'MOTIR-4811' },
  { file: 'design/runs/run-section.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/runs/runs-index.mock.html', count: 12, card: 'MOTIR-4811' },
  { file: 'design/settings/account-data.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/settings/appearance.mock.html', count: 18, card: 'MOTIR-4811' },
  { file: 'design/settings/arrival.mock.html', count: 7, card: 'MOTIR-4811' },
  { file: 'design/settings/passkeys.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/settings/permission-columns.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/settings/two-factor.mock.html', count: 1, card: 'MOTIR-4811' },
  { file: 'design/shell/3d-immersive-shell.mock.html', count: 4, card: 'MOTIR-4811' },
  { file: 'design/shell/account-menu.mock.html', count: 4, card: 'MOTIR-4811' },
  // 873 → 872 with MOTIR-4810, and the arithmetic is worth stating because it
  // went the OTHER way first. Removing the four vestigial `[&_.seg-*]:` tokens
  // from `child-panel-graph.mock.html` orphaned this file's compiled
  // `.[&_.seg-trail]:text-(--el-text-faint)` rule — the tree-wide predicate had
  // been holding it alive off that one carrier — so the count rose to 874. The
  // remedy the failure message itself prescribes is to DELETE the rule, not to
  // raise the pin: this table is a ratchet, and a count that grows to absorb
  // the diff that broke it is the mute button it exists not to be. Deleting the
  // rule dropped TWO declared names, because its nested `& .seg-trail` prelude
  // declared the second, and `.seg-trail` was already inside the 873.
  { file: 'design/shell/context-row.mock.html', count: 872, card: 'MOTIR-4814' },
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
  { file: 'design/work-items/todo-list.mock.html', count: 4, card: 'MOTIR-4811' },
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

  it('holds the two tables to a shrinking total', () => {
    // The number a reader checks in one line, and the one that says whether the
    // four follow-up cards are making progress. The ceilings are the populations
    // measured on `origin/main` `cd77d0225`; they may only be lowered.
    // 636 → 104 with MOTIR-4810: the whole structural half landed at once,
    // which is what the ratchet is for — the ceiling comes DOWN with the fix and
    // cannot go back up.
    expect(INERT_VARIANT_DEBT.reduce((n, row) => n + row.count, 0)).toBeLessThanOrEqual(104);
    // 1493 → 1492: one compiled rule in `context-row.mock.html` that MOTIR-4810
    // orphaned and then deleted (see its row above).
    expect(DEAD_UTILITY_DEBT.reduce((n, row) => n + row.count, 0)).toBeLessThanOrEqual(1492);
  });
});
