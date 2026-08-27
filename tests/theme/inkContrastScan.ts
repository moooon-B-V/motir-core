import ts from 'typescript';

// The ink-contrast scanner (MOTIR-2459). It ships on its own, ahead of the
// repo-wide lint that consumes it (MOTIR-2475 turns on the faint arm with its
// sweep, MOTIR-2477 the muted arm with its own), so that the classification
// below can be reviewed and pinned to fixtures — including a deliberately
// violating one — before it is pointed at 134 files. A lint whose negative case
// is never exercised is a lint nobody knows is running.
//
// ── What it decides, and why an AST rather than a grep ──────────────────────
// MOTIR-2455 measured that `--el-text-faint` clears AA on NO surface in either
// theme (2.37–2.61:1), which leaves it exactly two legitimate jobs: decorative
// glyphs, whose meaning lives in a label rather than in the pixels, and
// disabled / inactive text, which WCAG 1.4.3 explicitly exempts. Both of those
// are STRUCTURE, not text: `aria-hidden`, `role="img"`, a `disabled` attribute,
// a `disabled ? faint : ink` ternary. A grep sees the class and none of the
// structure, so it can only ever count occurrences; the parser sees the element
// the class lands on and can therefore say which of the three cases it is.
//
// The same argument decides the second rule. `--el-text-muted` is 4.54:1 on the
// white page/card and fails on every tinted surface (4.12–4.34:1), so the
// verdict depends on the BACKGROUND the ink sits over — which means walking up
// the JSX tree to the nearest ancestor that paints one.
//
// ── What it deliberately cannot see ─────────────────────────────────────────
// Surface inheritance stops at the MODULE boundary: an element whose background
// is painted by a `<Card>`, a `<Popover.Content>` or a layout in another module
// reads here as "no surface", and the muted rule abstains — it does not rule the
// site safe, it declines to rule at all. Resolving that needs the import graph,
// which this file does not build. The faint rule has no such hole — it is a
// property of the element itself — which is why that one has always been the
// unqualified sweep.
//
// The fence used to be drawn one step further in, at the COMPONENT the ink is
// written in: a file that wrote the ink in a local `Th` and painted the tint on
// the `<thead>` that USED it abstained, with both halves in this one AST. That
// hid eight column labels at 4.17:1 on the operator jobs dashboard for the whole
// life of the file, under a green lint (MOTIR-3523), and eight more across the
// swimlane board, the filters directory, billing, the board-config editor and
// both planning review surfaces (MOTIR-3711). `surfacesAtUseSites` closes it by
// walking the component's use sites in this same file. That walk is
// UNCONDITIONAL — MOTIR-3523 shipped it behind an opt-in `ScanOptions` flag only
// so that the sweep could land with the switch rather than after it (MOTIR-2496
// is what the other order costs), and MOTIR-3711 did both and removed the flag.
//
// ── The class and the element can come apart (MOTIR-2489) ───────────────────
// The premise above — the verdict is a property of the ELEMENT — survives, but
// its first implementation assumed the element the class is WRITTEN on is the
// element the ink LANDS on. Tailwind lets those differ three ways, and all
// three were mis-ruled in the tree the faint sweep went through:
//
//   1. a descendant variant (`[&_svg]:text-…`) addresses a CHILD, so the
//      verdict belongs to that child; where the selector names something this
//      file cannot show, the honest answer is `unattributable`, not the
//      carrier's verdict;
//   2. `disabled={a || b}` describes the element only SOMETIMES, so it cannot
//      carry 1.4.3's unconditional exemption — only a literal `disabled`, and
//      the disabled branch of a ternary, can;
//   3. a `placeholder:` prefix paints a pseudo-element that IS text, even on a
//      self-closing control whose own content is glyphs.
//
// Two of the three failed QUIETLY, which is why they are worth code: a false
// positive gets argued with, a false negative reads as coverage. Where the
// scanner still cannot tell, it says `unattributable` — which fails loudly and
// asks a person — rather than `decorative`, which asks nobody.
//
// Still invisible, and knowingly so: a STATE variant that is itself the
// exemption (`disabled:text-(--el-text-faint)` paints only while disabled).
// One site carries it today, and it clears on the decorative arm anyway.
//
// ── One colour, two token names (MOTIR-2497) ────────────────────────────────
// The surface walk knew ONE spelling of "this element paints the white page".
// `--el-page-bg` and `--el-card` are both `var(--color-background)`, so two
// elements painted the identical colour got opposite verdicts depending on
// which token the author reached for — and the walk sailed past the
// `--el-page-bg` one to report a tint further up. `SAFE_SURFACE_TOKENS` below
// carries both, and `inkContrastLint.test.ts` derives that list from
// `theme.css` so a third alias of the same colour cannot reopen it silently.
//
// ── …and the TINTED half had the same hole, for longer (MOTIR-3693) ─────────
// MOTIR-2497 derived the SAFE list from the token table and left the TINTED one
// a hand-written enumeration of three names — which is the same modelling error
// on the arm where it fails SILENTLY. A missing safe alias over-reports and gets
// argued with; a missing TINTED alias reports nothing at all, and an incomplete
// enumeration's failure mode is a PASS.
//
// `--el-sidebar-bg` is `var(--color-surface)`, the identical `#f6f5f4` as
// `--el-surface`, and it was not on the list: 242 sub-AA pairs across 18 design
// assets and one component were invisible to BOTH guards for as long as the rail
// has existed. Twelve more `--el-*` names resolve to one of the three measured
// tints and were equally unmeasured.
//
// So the list below is now TOTAL over the token table rather than over the three
// names somebody remembered, `TINTED_SURFACE_VALUES` states what "tinted" means
// as a COLOUR, and `inkContrastLint.test.ts` reads both back from `theme.css` in
// both directions. `inkContrastMockScan` imports the list rather than restating
// it, so the two arms cannot disagree about which surfaces are tinted any more
// than they can about which are white.

/** The two inks under measurement, as they appear in an arbitrary-value class. */
export const FAINT_CLASS = 'text-(--el-text-faint)';
export const MUTED_CLASS = 'text-(--el-text-muted)';

/**
 * What "a tinted surface" IS, as a colour rather than as a name: the three
 * `--color-*` fills MOTIR-2455 measured `--el-text-muted` at 4.12–4.34:1 on.
 * Every `--el-*` that resolves to one of them paints the same pixels and so
 * takes the same verdict, whatever it is called.
 *
 * This is the fact `TINTED_SURFACE_TOKENS` below is derived from, and the thing
 * `inkContrastLint.test.ts` reads back out of `theme.css`. Adding a value here
 * without re-measuring the ink on it is the one edit that would make the guard
 * wrong rather than merely narrow.
 */
export const TINTED_SURFACE_VALUES: readonly string[] = [
  'var(--color-surface)',
  'var(--color-surface-soft)',
  'var(--color-muted)',
];

/**
 * Backgrounds that are NOT the white page/card, on which `--el-text-muted`
 * drops below 4.5:1 (MOTIR-2455's measured table). The safe ones are
 * `SAFE_SURFACE_TOKENS` below and are deliberately absent.
 *
 * TOTAL over the token table, not over the surfaces anyone thought of: every
 * `--el-*` in `theme.css` whose every declaration is one of
 * `TINTED_SURFACE_VALUES` appears here, and `inkContrastLint.test.ts` fails if
 * one stops doing so in either direction (MOTIR-3693). Membership is NOT
 * filtered by whether the tree currently paints with the token — unlike the safe
 * set below, where narrowness is the conservative direction. Here it is the
 * opposite: an over-listed tint over-REPORTS, which this file already documents
 * as the safe way to be wrong, while an under-listed one is a silent pass.
 */
export const TINTED_SURFACE_TOKENS: readonly string[] = [
  '--el-archived-pill-bg',
  '--el-card-icon-bg',
  '--el-chart-plot',
  '--el-chat-bubble-ai',
  '--el-chip-bg',
  '--el-code-bg',
  '--el-count-bg',
  '--el-input-disabled-bg',
  '--el-input-readonly-bg',
  '--el-muted',
  '--el-option-active-bg',
  '--el-sidebar-bg',
  '--el-surface',
  '--el-surface-soft',
  '--el-switch-knob',
  '--el-tabnav-track',
];

const TINTED_SURFACE_CLASSES = TINTED_SURFACE_TOKENS.map((token) => `bg-(${token})`);

/**
 * The `--el-*` backgrounds that ARE the white page/card, where `--el-text-muted`
 * measures 4.54:1 — so an element painting one ends the surface walk with a
 * PASS rather than being walked past (MOTIR-2497).
 *
 * There are two of them because the token layer spells the same colour twice:
 * `--el-page-bg` and `--el-card` are both `var(--color-background)`. Knowing
 * only one spelling is what made the guard report
 * `backlog/_components/CreateIssueRow.tsx` — an input carrying
 * `bg-(--el-page-bg)` inside an `--el-surface-soft` row — as ink on a tint,
 * when its placeholder was painting on white the whole time. A false positive
 * is not free here: the cheapest way to silence one is to swap the token for
 * its identical twin, which changes no pixels and leaves the codebase carrying
 * a colour choice made for a parser.
 *
 * Exported as TOKEN NAMES rather than classes because `inkContrastLint.test.ts`
 * reads them back against `theme.css`: any `--el-*` used as a background that
 * also resolves to `--color-background` has to appear here, so a THIRD spelling
 * cannot reopen this hole quietly.
 *
 * A third spelling then did, and the derivation could not see it (MOTIR-3693):
 * `--el-sidebar-item-bg-active` is declared across three lines, so the
 * single-line regex that reads the token table captured
 * `var(\n    --color-background\n  )` and compared it — unequal — to
 * `var(--color-background)`. The check that was supposed to make the list total
 * was itself matching on a SPELLING. The derivation now collapses whitespace
 * before comparing, and this token is the row that proves it: the docs
 * catalogue and the app sidebar both paint active rows with it, inside a rail
 * the walk would otherwise have reported as the tint.
 */
export const SAFE_SURFACE_VALUES: readonly string[] = ['var(--color-background)'];

export const SAFE_SURFACE_TOKENS: readonly string[] = [
  '--el-card',
  '--el-page-bg',
  '--el-sidebar-item-bg-active',
];

const SAFE_SURFACE_CLASSES = SAFE_SURFACE_TOKENS.map((token) => `bg-(${token})`);

/**
 * Predicates whose TRUE branch is a disabled / inactive state — the 1.4.3
 * exemption. Matched against the ternary's condition source, so `disabled`,
 * `isDisabled`, `seatOff`, `!canEdit` and `locked` all land here.
 */
const DISABLED_TEST =
  /\b(?:is|are|has)?[A-Za-z]*(?:disabled|locked|inactive|readonly|unavailable)\b|\b[a-z][A-Za-z]*Off\b|\bnot(?:Allowed|Held|Available)\b/i;

/** Predicates whose FALSE branch is the disabled one (`enabled ? ink : faint`). */
const ENABLED_TEST =
  /\b(?:is|can|has)?[A-Za-z]*(?:enabled|active|available|editable|allowed|held)\b/i;

export type Verdict = 'decorative' | 'disabled' | 'violation' | 'unattributable';

export interface InkFinding {
  file: string;
  line: number;
  /** Which measured ink this finding is about. */
  ink: 'faint' | 'muted';
  verdict: Verdict;
  /** Why the scanner ruled the way it did — quoted verbatim in the failure. */
  reason: string;
  /** The element the class landed on, or `null` when it landed on a constant. */
  element: string | null;
  snippet: string;
}

/** Every string-ish node whose text contains `needle`, with its position. */
function classLiterals(source: ts.SourceFile, needle: string): ts.LiteralLikeNode[] {
  const hits: ts.LiteralLikeNode[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)) &&
      node.text.includes(needle)
    ) {
      hits.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return hits;
}

/**
 * One OCCURRENCE of the ink: the whole whitespace-separated Tailwind class that
 * carries it, with its variant prefixes split off. The occurrence rather than
 * the literal is the unit of judgement, because the prefixes are what decide
 * WHICH element the ink lands on (MOTIR-2489).
 */
interface InkToken {
  /** The string-ish node the class was written in — the reporting anchor. */
  node: ts.Node;
  /** The variant prefixes, outermost first: `[&_svg]`, `placeholder`, `hover`. */
  variants: string[];
  /** Absolute position of the token, for the reported line. */
  start: number;
}

/**
 * Split a Tailwind class into its variant prefixes and its utility. Bracket-
 * and paren-aware, so `text-(--el-text-faint)` is one utility and
 * `[&_[data-x]]:text-(…)` is one variant plus one utility.
 */
function splitVariants(token: string): string[] {
  const variants: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i += 1) {
    const char = token[i];
    if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    else if (char === ':' && depth === 0) {
      variants.push(token.slice(start, i));
      start = i + 1;
    }
  }
  return variants;
}

/** Every occurrence of `needle`, one per class token rather than one per literal. */
function inkTokens(source: ts.SourceFile, needle: string): InkToken[] {
  const tokens: InkToken[] = [];
  for (const node of classLiterals(source, needle)) {
    const raw = node.getText(source);
    let searchFrom = 0;
    for (const token of node.text.split(/\s+/)) {
      if (!token.includes(needle)) continue;
      const at = raw.indexOf(token, searchFrom);
      if (at >= 0) searchFrom = at + token.length;
      tokens.push({
        node,
        variants: splitVariants(token),
        start: node.getStart(source) + Math.max(at, 0),
      });
    }
  }
  return tokens;
}

/**
 * The descendant selector a variant retargets to, e.g. `[&_svg]` → `_svg`.
 * Only a variant whose `&` is followed by a combinator moves the ink OFF the
 * carrier: `[&:hover]` and `[.dark_&]` still paint the element itself.
 */
function retargetSelector(variants: string[]): string | null {
  for (const variant of variants) {
    const match = /^\[&([_>].+)\]$/.exec(variant);
    if (match) return match[1]!;
  }
  return null;
}

/** Does any variant paint the `::placeholder` pseudo-element — which is text? */
function paintsPlaceholder(variants: string[]): boolean {
  return variants.includes('placeholder');
}

/** The JSX element a node sits inside an ATTRIBUTE of, if any. */
function owningElement(node: ts.Node): ts.JsxOpeningLikeElement | null {
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    if (ts.isJsxAttribute(cursor)) {
      const parent = cursor.parent.parent;
      return ts.isJsxOpeningLikeElement(parent) ? parent : null;
    }
    // A nested element ends the search: the class belongs to whatever attribute
    // we are inside, and crossing an element boundary means we were never in
    // one (a class constant declared mid-render, say).
    if (ts.isJsxElement(cursor) || ts.isJsxSelfClosingElement(cursor)) return null;
  }
  return null;
}

function attributesOf(element: ts.JsxOpeningLikeElement): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const attr of element.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name)) continue;
    const initializer = attr.initializer;
    if (!initializer) {
      attrs.set(attr.name.text, 'true'); // bare `aria-hidden` / `disabled`
    } else if (ts.isStringLiteral(initializer)) {
      attrs.set(attr.name.text, initializer.text);
    } else {
      attrs.set(attr.name.text, initializer.getText());
    }
  }
  return attrs;
}

function tagNameOf(element: ts.JsxOpeningLikeElement): string {
  return element.tagName.getText();
}

/**
 * Does this element render any text of its own? A control whose entire content
 * is glyphs paints no characters for 1.4.3 to measure, so the ink on it is
 * governed by 1.4.11 (a separate threshold and a separate card), not by this
 * sweep. A `{…}` child is counted as text: the scanner cannot see what an
 * expression renders, and "I can't tell" has to mean "assume text".
 */
function rendersText(element: ts.JsxOpeningLikeElement): boolean {
  if (ts.isJsxSelfClosingElement(element)) return false; // a glyph by construction
  const node = element.parent;
  if (!node || !ts.isJsxElement(node)) return false;
  for (const child of node.children) {
    if (ts.isJsxText(child)) {
      if (child.text.trim().length > 0) return true;
      continue;
    }
    if (ts.isJsxExpression(child)) {
      if (child.expression) return true;
      continue;
    }
    const opening = ts.isJsxElement(child)
      ? child.openingElement
      : ts.isJsxSelfClosingElement(child)
        ? child
        : null;
    if (!opening) continue;
    const hidden = attributesOf(opening).get('aria-hidden');
    if (hidden !== undefined && hidden !== 'false' && hidden !== '{false}') continue;
    if (rendersText(opening)) return true;
  }
  return false;
}

/** Does the element carry an accessible name of its own? */
function accessibleName(element: ts.JsxOpeningLikeElement): boolean {
  const attrs = attributesOf(element);
  return attrs.has('aria-label') || attrs.has('aria-labelledby');
}

/**
 * `true` when the element is a glyph whose meaning is carried elsewhere — the
 * first of the two legitimate jobs. Note this asks for an EXPLICIT marker: an
 * icon that merely looks decorative but is announced by a screen reader is a
 * defect in its own right, so "make it legibly decorative" is the fix rather
 * than an exemption.
 */
function isDecorative(
  element: ts.JsxOpeningLikeElement,
  /**
   * Whether the ink paints characters here, when the caller knows better than
   * `rendersText` can. A `placeholder:` class puts text on a self-closing
   * `<textarea aria-label … />` whose CONTENT is nothing at all, so the
   * glyphs-only arm below would otherwise clear the one thing a person reads
   * (MOTIR-2489 shape 3).
   */
  paintsText = rendersText(element),
): string | null {
  const attrs = attributesOf(element);
  const hidden = attrs.get('aria-hidden');
  if (hidden !== undefined && hidden !== 'false' && hidden !== '{false}') {
    return `<${tagNameOf(element)}> is aria-hidden`;
  }
  if (attrs.get('role') === 'img') {
    // An UNLABELLED role="img" carries meaning nothing else states.
    return accessibleName(element) ? `<${tagNameOf(element)}> is a labelled role="img"` : null;
  }
  if (accessibleName(element) && !paintsText) {
    return `<${tagNameOf(element)}> is a labelled control whose content is glyphs only`;
  }
  return null;
}

/**
 * `true` when the element itself declares the disabled state 1.4.3 exempts —
 * UNCONDITIONALLY. `disabled={a || b}` is not that: the control is inactive
 * only sometimes, and the render where it is not still paints text a person has
 * to read, so the exemption cannot be taken from an expression the scanner
 * cannot evaluate (MOTIR-2489 shape 2). A genuinely conditional style has a
 * shape that DOES say which branch is which — `disabled ? faint : ink` — and
 * `inDisabledBranch` reads it.
 */
function isDisabledElement(element: ts.JsxOpeningLikeElement): string | null {
  const attrs = attributesOf(element);
  for (const key of ['disabled', 'aria-disabled']) {
    const value = attrs.get(key);
    // `true` covers the bare attribute and `aria-disabled="true"`; `{true}` the
    // explicit literal. Every other initializer is an expression.
    if (value === 'true' || value === '{true}') {
      return `<${tagNameOf(element)}> carries ${key}`;
    }
  }
  return null;
}

/**
 * The expression an element's `disabled` / `aria-disabled` is computed from,
 * when it is an expression rather than a constant. This is the OTHER half of
 * `isDisabledElement`: that one refuses the exemption to a conditional
 * attribute, and this one is how a conditional attribute can still earn it.
 */
function disabledPredicate(element: ts.JsxOpeningLikeElement): string | null {
  for (const key of ['disabled', 'aria-disabled']) {
    const value = attributesOf(element).get(key);
    if (value === undefined) continue;
    const expression = /^\{([\s\S]*)\}$/.exec(value);
    if (expression) return expression[1]!.trim();
  }
  return null;
}

const withoutSpace = (source: string) => source.replace(/\s+/g, '');

/**
 * `true` when the class sits in the disabled branch of a ternary — the shape
 * `disabled ? faint : ink`, which is the 1.4.3 exemption written as a style.
 *
 * Two things can make a branch the disabled one. The predicate can SAY so
 * (`disabled`, `isLocked`, `seatOff`), which is the vocabulary below — or, and
 * this is the exact case rather than the readable one, the ternary can ask the
 * very question the element's own `disabled` attribute is computed from. A
 * `<button disabled={atCap} className={atCap ? faint : link}>` paints the faint
 * ink in precisely the render where the control is inactive, whatever the
 * predicate happens to be called; that is a proof, not a guess, and without it
 * MOTIR-2489's refusal to trust `disabled={expression}` would report three
 * cap-limited buttons that are behaving correctly.
 */
function inDisabledBranch(node: ts.Node, element?: ts.JsxOpeningLikeElement): string | null {
  const predicate = element ? disabledPredicate(element) : null;
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    const parent = cursor.parent;
    if (parent && ts.isConditionalExpression(parent)) {
      const test = parent.condition.getText();
      const inTrue = parent.whenTrue === cursor || contains(parent.whenTrue, cursor);
      const inFalse = parent.whenFalse === cursor || contains(parent.whenFalse, cursor);
      if (predicate !== null) {
        // `disabled={p}` + `p ? faint : ink`, and its negated mirror
        // `disabled={!p}` + `p ? ink : faint`: the ink paints exactly when the
        // control is inactive.
        if (inTrue && withoutSpace(predicate) === withoutSpace(test)) {
          return `the branch where \`${test}\` holds — the same expression \`disabled\` is computed from`;
        }
        if (inFalse && withoutSpace(predicate) === `!${withoutSpace(test)}`) {
          return `the branch where \`${test}\` fails — the negation \`disabled\` is computed from`;
        }
      }
      if (inTrue && DISABLED_TEST.test(test)) return `disabled branch of \`${test}\``;
      if (inFalse && ENABLED_TEST.test(test)) return `inactive branch of \`${test}\``;
    }
    if (ts.isJsxAttribute(cursor)) break; // do not escape the attribute
  }
  return null;
}

function contains(haystack: ts.Node, needle: ts.Node): boolean {
  return needle.pos >= haystack.pos && needle.end <= haystack.end;
}

/** The class strings any JSX element carries, flattened to one searchable blob. */
function classBlob(element: ts.JsxOpeningLikeElement): string {
  const className = element.attributes.properties.find(
    (attr) =>
      ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === 'className',
  );
  return className ? className.getText() : '';
}

/** A literal string, safe to embed in a `RegExp`. */
function escapeForRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does the blob carry this class with NO variant prefix — i.e. does the element
 * paint it in its RESTING state?
 *
 * Only the safe arm asks. `hover:bg-(--el-page-bg)` on a
 * `bg-(--el-surface)` button paints white under the pointer and the tint every
 * other render, so reading it as a safe surface would clear the muted ink
 * beside it — a false NEGATIVE, which reads as coverage. Two sites in the tree
 * are that exact shape (`components/issues/EstimateBadge.tsx`,
 * `components/ui/MarkdownEditor.tsx`), so widening the safe set without this is
 * how the correction would silence real findings. The TINTED arm keeps its
 * substring match on purpose: over-reporting a conditional tint is the
 * documented safe way to be wrong (see `inkContrastLint.test.ts`).
 */
function paintsUnprefixed(blob: string, className: string): boolean {
  return new RegExp(`(^|[\\s"'\`{])${escapeForRegExp(className)}([\\s"'\`}]|$)`).test(blob);
}

/**
 * The nearest ancestor (within this file) that paints a background, and whether
 * that background is one the muted ink fails on. Returns `null` when no
 * ancestor in this file paints one — the abstention documented at the top.
 */
function nearestSurface(node: ts.Node): { className: string; tinted: boolean } | null {
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    const element = ts.isJsxElement(cursor)
      ? cursor.openingElement
      : ts.isJsxSelfClosingElement(cursor)
        ? cursor
        : ts.isJsxOpeningLikeElement(cursor)
          ? cursor
          : null;
    if (!element) continue;
    const blob = classBlob(element);
    const safe = SAFE_SURFACE_CLASSES.find((surface) => paintsUnprefixed(blob, surface));
    if (safe) return { className: safe, tinted: false };
    const tinted = TINTED_SURFACE_CLASSES.find((surface) => blob.includes(surface));
    if (tinted) return { className: tinted, tinted: true };
  }
  return null;
}

/**
 * The component this node is declared inside, when that component is declared
 * at the TOP LEVEL OF THIS FILE — `function Th(…)`, or `const Th = (…) => …`,
 * with a capitalised name. Anything else (a nested helper, an import, a default
 * export of an expression) returns `null`.
 */
function enclosingLocalComponent(node: ts.Node): string | null {
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    // ⚠️ THE INNERMOST enclosing function decides, and a non-top-level one
    // decides AGAINST resolving. Walking PAST a nested helper to the top-level
    // function around it would attribute that function's use sites to the
    // helper — a surface the helper may never sit on, and a false positive
    // pointing at a line the reader cannot act on.
    if (ts.isFunctionDeclaration(cursor) || ts.isFunctionExpression(cursor)) {
      return cursor.name && ts.isSourceFile(cursor.parent) && /^[A-Z]/.test(cursor.name.text)
        ? cursor.name.text
        : null;
    }
    if (ts.isArrowFunction(cursor)) {
      const declaration = cursor.parent;
      if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null;
      const statement = declaration.parent.parent;
      return ts.isVariableStatement(statement) &&
        ts.isSourceFile(statement.parent) &&
        /^[A-Z]/.test(declaration.name.text)
        ? declaration.name.text
        : null;
    }
  }
  return null;
}

/**
 * Every surface a locally-declared component is USED over, within this file.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `nearestSurface` walks the ink element's own ancestors, which stops at the
 * root of the component the element is written in. So a file that puts the ink
 * in `<Th>` and the tint on the `<thead>` that USES it reads as "no surface
 * found here" and the muted arm abstains — silently, since an abstention emits
 * no finding at all. That is not the cross-MODULE boundary the guard documents
 * as out of reach: both halves are in one file and one AST, which is exactly
 * what this walk can already see. MOTIR-3523 is the defect it missed for that
 * reason — eight column labels at 4.17:1 on a page an operator reads while
 * something is on fire.
 *
 * ── The two ways to be wrong, and which one this picks ──────────────────────
 * A component used at several sites can sit over a tint at one and white at
 * another, and the ink is genuinely unreadable at the tinted one. So ANY tinted
 * use site is a violation, matching the tinted arm's standing policy that
 * over-reporting is the safe direction (`inkContrastLint.test.ts`).
 *
 * ── The hop is ONE level, deliberately ──────────────────────────────────────
 * A use site whose own surface is unresolved is not chased through a second
 * component. One hop terminates without a cycle check and covers the shape this
 * was written for; a transitive resolver is the import-graph problem the file
 * header defers, and inheriting its cost here would buy nothing measured.
 */
function surfacesAtUseSites(
  source: ts.SourceFile,
  component: string,
): { className: string; tinted: boolean; line: number }[] {
  const surfaces: { className: string; tinted: boolean; line: number }[] = [];
  const visit = (node: ts.Node) => {
    const element = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (element && ts.isIdentifier(element.tagName) && element.tagName.text === component) {
      // Start the walk at the PARENT: a use site paints the ink's background
      // from above it, and `<Th className="bg-…">` would be the carrier's own
      // surface, which `nearestSurface` has already ruled on.
      const surface = element.parent ? nearestSurface(element.parent) : null;
      if (surface) surfaces.push({ ...surface, line: lineAt(source, element.getStart(source)) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return surfaces;
}

/**
 * A predicate for ONE simple selector, or `null` when the selector is past what
 * this resolver reads. `null` is not "no match" — it is "I cannot tell", and it
 * has to stay distinct from an empty match set, because both end in
 * `unattributable` for different reasons and only one of them is worth
 * teaching the scanner later.
 */
function selectorMatcher(
  selector: string,
): ((element: ts.JsxOpeningLikeElement) => boolean) | null {
  // A lowercase tag — `svg`, `span`. A capitalised one is a component, whose
  // rendered tag this file does not know, so it is deliberately not matched:
  // `[&_svg]:` over a `<ChevronRight />` really is unresolvable here.
  if (/^[a-z][a-z0-9]*$/.test(selector)) {
    return (element) => tagNameOf(element) === selector;
  }
  if (/^\.[A-Za-z0-9_-]+$/.test(selector)) {
    const className = selector.slice(1);
    const pattern = new RegExp(`(^|[\\s"'\`{])${className}([\\s"'\`}]|$)`);
    return (element) => pattern.test(classBlob(element));
  }
  const attribute = /^\[([A-Za-z][A-Za-z0-9-]*)(?:[~^$*|]?=.*)?\]$/.exec(selector);
  if (attribute) {
    return (element) => attributesOf(element).has(attribute[1]!);
  }
  return null;
}

/** Every JSX element under `element`, in source order. `direct` stops at one level. */
function descendantsOf(
  element: ts.JsxOpeningLikeElement,
  direct: boolean,
): ts.JsxOpeningLikeElement[] {
  const found: ts.JsxOpeningLikeElement[] = [];
  const parent = element.parent;
  if (!ts.isJsxElement(parent)) return found; // self-closing: no children at all
  const collect = (children: readonly ts.JsxChild[]) => {
    for (const child of children) {
      if (ts.isJsxSelfClosingElement(child)) {
        found.push(child);
      } else if (ts.isJsxElement(child)) {
        found.push(child.openingElement);
        if (!direct) collect(child.children);
      } else if (!direct && ts.isJsxExpression(child) && child.expression) {
        // `{items.map(i => <li …/>)}` — the elements are real and in this file.
        const visit = (node: ts.Node) => {
          if (ts.isJsxSelfClosingElement(node)) found.push(node);
          else if (ts.isJsxElement(node)) found.push(node.openingElement);
          ts.forEachChild(node, visit);
        };
        visit(child.expression);
      }
    }
  };
  collect(parent.children);
  return found;
}

/**
 * The elements a descendant variant's ink actually lands on, or a reason the
 * selector could not be resolved in this file. Everything an ancestor's class
 * says about ITSELF — that it is aria-hidden, that it renders a label — is
 * irrelevant once the ink is painted on a child, which is the whole of
 * MOTIR-2489 shape 1.
 */
function retargeted(
  carrier: ts.JsxOpeningLikeElement,
  selector: string,
): { elements: ts.JsxOpeningLikeElement[] } | { unresolved: string } {
  const direct = selector.startsWith('>');
  const simple = selector.slice(1).trim();
  const matches = selectorMatcher(simple);
  if (!matches) {
    return { unresolved: `the descendant selector \`${simple}\` is past what this scanner reads` };
  }
  const elements = descendantsOf(carrier, direct).filter(matches);
  if (elements.length === 0) {
    return {
      unresolved: `\`${simple}\` matches no element inside <${tagNameOf(carrier)}> in this file, so the ink's target cannot be judged here`,
    };
  }
  return { elements };
}

/**
 * The reported line. Taken from the TOKEN's own position rather than the
 * literal's, so a class list spread over several lines points at the class.
 */
function lineAt(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

/**
 * The snippet a reader sees in the failure. It deliberately includes the
 * element's CHILDREN where there are any: the opening tag alone shows the class
 * and hides the thing the verdict is about — whether this element paints real
 * copy — which is exactly the judgement the reader is being asked to check.
 */
function snippetOf(
  source: ts.SourceFile,
  node: ts.Node,
  /**
   * The element to show instead of the carrier — used when a descendant variant
   * moved the ink, where showing the carrier would hide the element the verdict
   * is actually about.
   */
  override?: ts.JsxOpeningLikeElement,
): string {
  const element = override ?? owningElement(node);
  const subject =
    element && ts.isJsxOpeningElement(element) && ts.isJsxElement(element.parent)
      ? element.parent
      : (element ?? node);
  const text = subject.getText(source).replace(/\s+/g, ' ');
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

/**
 * Scan one source file. `fileName` is only used for reporting, so a synthetic
 * fixture can be scanned by passing its text directly.
 *
 * There is no options argument. The use-site resolution below was briefly an
 * opt-in `ScanOptions.resolveUseSites` (MOTIR-3523), off while the population it
 * un-blinds went unswept — the ordering this repo has twice paid for getting
 * wrong (MOTIR-2496). MOTIR-3711 swept those eight sites and removed the flag in
 * the same change, because a knob every caller sets to `true` is only ever
 * reachable as a way to make a red lint green, and this guard deliberately has
 * no allowlist to make optional.
 */
export function scanSource(fileName: string, text: string): InkFinding[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings: InkFinding[] = [];

  for (const token of inkTokens(source, FAINT_CLASS)) {
    const { node } = token;
    const line = lineAt(source, token.start);
    const carrier = owningElement(node);

    if (!carrier) {
      findings.push({
        file: fileName,
        line,
        ink: 'faint',
        verdict: 'unattributable',
        reason:
          'the class is not attached to a JSX element here, so nothing can show it is decorative or disabled',
        element: null,
        snippet: snippetOf(source, node),
      });
      continue;
    }

    const painted = paintedElements(carrier, token);
    if ('unresolved' in painted) {
      findings.push({
        file: fileName,
        line,
        ink: 'faint',
        verdict: 'unattributable',
        reason: painted.unresolved,
        element: null,
        snippet: snippetOf(source, node),
      });
      continue;
    }

    for (const element of painted.elements) {
      const decorative = isDecorative(element, paintsText(element, token));
      const disabled = isDisabledElement(element) ?? inDisabledBranch(node, element);
      findings.push({
        file: fileName,
        line,
        ink: 'faint',
        element: tagNameOf(element),
        verdict: decorative ? 'decorative' : disabled ? 'disabled' : 'violation',
        reason:
          decorative ??
          disabled ??
          `<${tagNameOf(element)}> paints active informational text with an ink that clears AA on no surface`,
        snippet: snippetOf(source, node, element === carrier ? undefined : element),
      });
    }
  }

  for (const token of inkTokens(source, MUTED_CLASS)) {
    const { node } = token;
    const line = lineAt(source, token.start);
    const carrier = owningElement(node);
    if (!carrier) continue; // the muted rule needs an element to find a surface for

    const painted = paintedElements(carrier, token);
    if ('unresolved' in painted) {
      findings.push({
        file: fileName,
        line,
        ink: 'muted',
        verdict: 'unattributable',
        reason: painted.unresolved,
        element: null,
        snippet: snippetOf(source, node),
      });
      continue;
    }

    for (const element of painted.elements) {
      // 1.4.3 measures TEXT. A glyph or a disabled control is out of its scope
      // whichever ink it takes, so those are filtered before the surface lookup.
      if (isDecorative(element, paintsText(element, token))) continue;
      if (isDisabledElement(element) || inDisabledBranch(node, element)) continue;
      const surface = nearestSurface(element);
      // No surface in the element's OWN ancestors: before abstaining, ask where
      // the component this element belongs to is USED in this file (MOTIR-3523).
      const component = surface ? null : enclosingLocalComponent(element);
      const inherited = component
        ? surfacesAtUseSites(source, component).find((use) => use.tinted)
        : undefined;
      const resolved = surface ?? inherited;
      if (!resolved?.tinted) continue;
      findings.push({
        file: fileName,
        line,
        ink: 'muted',
        verdict: 'violation',
        element: tagNameOf(element),
        reason: inherited
          ? `--el-text-muted is 4.12–4.34:1 on ${inherited.className}, which <${tagNameOf(element)}> inherits from this component's use site at line ${inherited.line}; it clears AA only on the white page/card`
          : `--el-text-muted is 4.12–4.34:1 on ${resolved.className}; it clears AA only on the white page/card`,
        snippet: snippetOf(source, node, element === carrier ? undefined : element),
      });
    }
  }

  return findings;
}

/**
 * The element(s) this occurrence of the ink paints — the carrier itself, or
 * whatever a descendant variant retargets it to.
 */
function paintedElements(
  carrier: ts.JsxOpeningLikeElement,
  token: InkToken,
): { elements: ts.JsxOpeningLikeElement[] } | { unresolved: string } {
  const selector = retargetSelector(token.variants);
  return selector === null ? { elements: [carrier] } : retargeted(carrier, selector);
}

/** Whether this occurrence puts characters on the element it lands on. */
function paintsText(element: ts.JsxOpeningLikeElement, token: InkToken): boolean {
  return paintsPlaceholder(token.variants) || rendersText(element);
}

/** The findings that FAIL the guard — everything the two legitimate jobs do not cover. */
export function violations(findings: InkFinding[]): InkFinding[] {
  return findings.filter(
    (finding) => finding.verdict === 'violation' || finding.verdict === 'unattributable',
  );
}

export function formatFinding(finding: InkFinding): string {
  return `${finding.file}:${finding.line} — ${finding.reason}\n    ${finding.snippet}`;
}
