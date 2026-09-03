import { SAFE_SURFACE_TOKENS, TINTED_SURFACE_TOKENS } from './inkContrastScan';

// The DESIGN-ASSET arm of the ink-contrast guard (MOTIR-3014, MOTIR-3054).
//
// ── The hole this closes ────────────────────────────────────────────────────
// `inkContrastLint` scans `components/**`, `app/**`, `lib/**` and the design
// system's `src/**`. It does not scan `design/**` — so a mock could specify an
// ink/surface pair the lint forbids in code, and the mock is what the next
// implementer copies. That is not hypothetical: `DevelopmentSection.tsx` put
// `--el-text-muted` on `--el-surface-soft` (4.34:1) because
// `design/work-items/repository-set.mock.html` did, and the guard caught the
// component while the asset it was copied from stayed on `main`.
//
// The constraint was not missing when that happened. It is in `CLAUDE.md`'s
// measured table (MOTIR-2455), and `design/work-items/design-notes.md` restates
// it about two hundred lines above the section the violating asset appended to.
// A rule that is written down twice and violated anyway is a rule nothing
// measures — which is what this file is for.
//
// ── Why a second scanner rather than a wider glob ───────────────────────────
// `inkContrastScan` parses TSX with the TypeScript compiler and walks the JSX
// tree. A `.mock.html` has no JSX in it, so pointing that scanner at `design/**`
// would report nothing at all — the failure mode a widened glob is worst at,
// because it reads as coverage. The rule being enforced is identical; only the
// tree it is read out of differs, so the two share `SAFE_SURFACE_TOKENS` (the
// list `inkContrastLint` derives from `theme.css`) rather than restating it.
//
// ── An HTML mock is EASIER to rule on than a component, not harder ──────────
// The muted arm's verdict is a property of the ink AND the background under it,
// and in a component that background is frequently painted by a `<Card>` in
// another module — so `inkContrastScan`'s surface walk stops at the file
// boundary and ABSTAINS. A mock is by construction self-contained: the whole
// surface, its own stylesheet, one file. The walk here therefore resolves a
// background for every element that has one, and an abstention means the asset
// genuinely paints no background above the ink (the page white).
//
// ── THE MUTED ARM IS ENFORCED OVER BOTH LAYERS (MOTIR-3054) ────────────────
// A mock paints in two layers — a `text-(--el-text-muted)` utility written on
// the element, and a `.tbtn { color: var(--el-text-muted) }` rule in the file's
// own `<style>` block — and both are ruled on, at zero, across the whole tree.
//
// MOTIR-3014 shipped enforcing only the first (26 findings, 4 files, swept
// there) and DECLINED the second (277 findings, 51 files), on the grounds that
// a mock's stylesheet paints the board a design is PRESENTED on — the panel
// captions, the numbered annotations, the fold measurements — as well as the
// product surface it specifies, so ruling on it meant first deciding whether a
// design board's own chrome owes AA. MOTIR-3054 answered that question NO
// EXEMPTION, swept all 277, and closed the boundary. The reasoning is in
// `docs/decisions/design-board-chrome-aa.md`; the two loads it actually bears
// here are:
//
//   1. **The declined population was never mostly chrome.** Classified by the
//      class that carried the ink, the 277 are dominated by the PRODUCT
//      surface — `.meta`, `.icon-btn`, `.tbtn`, `.chev`, `.lane-chevron`,
//      `.col-count`, `.pr-meta` — the rows and controls the mock exists to
//      specify. `.foldNote` was 5 of 277. An exemption sized for the whole
//      population would have been granted on the strength of its clearest
//      example rather than its actual contents.
//   2. **The exemption cost more than compliance.** Marking chrome
//      structurally (`data-mock-chrome` on the annotation layer) is an edit to
//      every annotation in 126 mocks plus a standing authoring obligation, and
//      it opens a hole exactly where the guard is load-bearing: an element that
//      inherits the marker stops being ruled on, silently. Swapping the ink is
//      one token per rule, 86 lines, and it makes the board more legible.
//
// So there is no `via` filter on the muted arm any more, and no allowlist. The
// only exemptions are the two 1.4.3 grants below, which are declared ON the
// element and are the same two `inkContrastScan` takes.
//
// ── BOTH ARMS ARE RULED ON, AT ZERO, OVER BOTH LAYERS (MOTIR-3068) ────────
// `--el-text-faint` clears AA on NO surface (2.37–2.61:1), so — exactly like the
// code guard — every non-decorative, non-disabled use of it is a violation here.
// The faint arm was COUNTED and not ruled on for one reason, SIZE: read out of
// this tree it was 1745 findings across 101 files, a backlog rather than a sweep.
// MOTIR-3068 discharged it, area by area, and the boundary was deleted with its
// subject rather than reworded — a decline that outlives its reason is how the
// next reader re-derives it.
//
// The only exemptions in either arm are the two 1.4.3 grants below, declared ON
// the element. There is no allowlist, no per-area carve-out and no `via` filter:
// the layer an ink is written in changes nothing about the pixels it puts on
// screen, so it changes nothing about the verdict.

/** The ink this arm RULES ON, as it appears in an arbitrary-value class. */
export const MUTED_CLASS = 'text-(--el-text-muted)';
export const MUTED_TOKEN = '--el-text-muted';

/** The ink this arm COUNTS. Same spellings, same two layers, no verdict. */
export const FAINT_CLASS = 'text-(--el-text-faint)';
export const FAINT_TOKEN = '--el-text-faint';

/**
 * The DANGER ink — MOTIR-3663, the design-side half of the code arm in
 * `inkContrastScan.ts`.
 *
 * The two arms above are a CONTRAST rule: an ink is fine here and fails there,
 * so the verdict needs a surface walk and a measured table. This one is a
 * PAIRING rule — `--el-danger-text` is `--color-destructive-foreground`, the ink
 * FOR a bright danger fill, so it is legal on exactly one background and wrong
 * on every other. No walk, no table.
 *
 * ⚠️ And this arm is the one that matters most on THIS tree, because a mock is
 * what the next implementer copies. MOTIR-1553's root cause was literally that:
 * `.opt.danger { color: var(--el-danger-text) }` in a mock, copied into two row
 * menus, invisible in the shipped product. The mock scanner has had no danger
 * arm from the day it was written, so the seed that produced the defect went on
 * being green while the component that copied it was caught.
 */
export const DANGER_CLASS = 'text-(--el-danger-text)';
export const DANGER_TOKEN = '--el-danger-text';

/** The one background that makes the pairing legal. */
export const DANGER_FILL_TOKEN = '--el-danger';

/**
 * The backgrounds on which `--el-text-muted` drops below 4.5:1 — CLAUDE.md's
 * measured table (MOTIR-2455): 4.17 / 4.12 / 4.34 against 4.54 on the white
 * page/card.
 *
 * BOTH lists are imported from the code scanner now (MOTIR-3693). The safe one
 * always was, for the stated reason — so the two arms cannot disagree about
 * which token is the page white — and the tinted one was a second copy of the
 * same kind of fact, carrying three names while `theme.css` declared sixteen
 * `--el-*` that resolve to one of those three fills. `--el-sidebar-bg` is the
 * one that mattered: an alias of `--el-surface`, painting the identical
 * `#f6f5f4`, measured by neither guard, carrying 242 sub-AA pairs across 18
 * assets. Two copies of a list is how one of them goes stale; the list is now
 * derived from the token table and asserted total there.
 */
export { SAFE_SURFACE_TOKENS, TINTED_SURFACE_TOKENS };

export interface MockFinding {
  file: string;
  line: number;
  /**
   * Which ink. `muted` is the ruled-on arm; `faint` is the counted one (the
   * header's remaining boundary). `violations()` is the only place that
   * distinction is applied — everything else treats a finding as a finding.
   */
  ink: 'muted' | 'faint' | 'danger';
  /**
   * The `--el-*` background the surface walk resolved under the ink, or `null`
   * on the faint arm — where the verdict is a property of the ink alone, so no
   * walk is performed and no surface can excuse it.
   */
  surface: string | null;
  /** The element the ink landed on. */
  element: string;
  /** How the ink was declared — a utility class, or a rule in the mock's own stylesheet. */
  via: 'class' | 'stylesheet';
  reason: string;
  snippet: string;
}

/* ─────────────────────────── the HTML tokenizer ────────────────────────────
 * Hand-written rather than a DOM library, for one reason: a finding has to name
 * a LINE. `happy-dom` (the repo's only HTML parser) discards source positions,
 * so a finding it produced could only be located by searching the file for the
 * element's serialized markup — which is ambiguous exactly where a mock repeats
 * a row across panels, i.e. everywhere. A tokenizer that records offsets gives
 * every finding an address for free, and a design mock is well-formed,
 * prettier-printed markup with no scripting, which is the input this is safe on.
 */

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/** Raw-text elements whose CONTENT is not markup and must not be tokenized. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

export interface MockElement {
  tag: string;
  attrs: Map<string, string>;
  classes: string[];
  line: number;
  /**
   * Byte offset of this element's `<` in the source — MOTIR-4255.
   *
   * `line` addresses a finding for a HUMAN; this addresses it for a PROGRAM.
   * `mockStateInkScan` renders a mock in a real DOM to resolve the surfaces
   * this file's `stylePaint` abstains on, and a DOM node carries no source
   * position — so that scanner stamps every opening tag with its own line
   * before parsing, and needs the offset to know where to write. Recording it
   * here rather than re-tokenizing the file there keeps ONE tokenizer: two
   * would be two things to keep in step about which `<` is markup and which is
   * text inside a `<style>` block.
   */
  offset: number;
  /** Index into the flat element list, or -1 at the root. */
  parent: number;
  /** The opening tag, verbatim, for the failure message. */
  snippet: string;
  /** Whether any descendant text node (outside an aria-hidden subtree) is non-empty. */
  hasText: boolean;
}

const ATTR_RE = /([a-zA-Z_:@][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

function parseAttrs(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const [, name, dq, sq, bare] of source.matchAll(ATTR_RE)) {
    attrs.set(name!.toLowerCase(), dq ?? sq ?? bare ?? '');
  }
  return attrs;
}

/**
 * Every element in the document, in source order, each carrying its parent's
 * index — which is all the surface walk needs, and all `hasText` needs.
 */
export function parseElements(html: string): MockElement[] {
  const elements: MockElement[] = [];
  const stack: number[] = [];
  const lineStarts = [0];
  for (let i = 0; i < html.length; i += 1) if (html[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  /** Mark the open ancestors as carrying text, stopping at an aria-hidden one. */
  const noteText = (text: string) => {
    if (!text.trim()) return;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const element = elements[stack[i]!]!;
      if (isHidden(element)) return;
      element.hasText = true;
    }
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      noteText(html.slice(i));
      break;
    }
    noteText(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt);
      const tag = html
        .slice(lt + 2, end === -1 ? html.length : end)
        .trim()
        .toLowerCase();
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (elements[stack[depth]!]!.tag === tag) {
          stack.length = depth;
          break;
        }
      }
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    const end = findTagEnd(html, lt);
    if (end === -1) {
      i = lt + 1;
      continue;
    }
    const raw = html.slice(lt + 1, end);
    const nameMatch = raw.match(/^[a-zA-Z][-a-zA-Z0-9:]*/);
    if (!nameMatch) {
      i = end + 1;
      continue;
    }
    const tag = nameMatch[0].toLowerCase();
    const selfClosing = raw.trimEnd().endsWith('/') || VOID_ELEMENTS.has(tag);
    const attrs = parseAttrs(raw.slice(nameMatch[0].length));
    const element: MockElement = {
      tag,
      attrs,
      classes: (attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
      line: lineAt(lt),
      offset: lt,
      parent: stack.length ? stack[stack.length - 1]! : -1,
      snippet: collapse(html.slice(lt, end + 1)),
      hasText: false,
    };
    elements.push(element);
    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, end + 1);
      i = close === -1 ? html.length : close;
      continue;
    }
    if (!selfClosing) stack.push(elements.length - 1);
    i = end + 1;
  }
  return elements;
}

/** The `>` that closes this tag, skipping any inside a quoted attribute value. */
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i += 1) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

function collapse(source: string): string {
  const flat = source.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}…` : flat;
}

/* ────────────────────────── the mock's own stylesheet ──────────────────────
 * A mock paints in two layers: Tailwind-shaped utility classes written on the
 * element (`text-(--el-text-muted)`, `bg-(--el-surface-soft)`) and named classes
 * defined in the file's own `<style>` block (`.dsCard { background: … }`). Both
 * put ink on screen, so both are read — a scanner that saw only the first would
 * report a clean asset whose stylesheet paints the same failing pair.
 */

/**
 * ONE structural rule the mock's stylesheet declares: the selector as a chain of
 * compounds, plus whichever of `color` / `background` it sets to an `--el-*`
 * token.
 *
 * `steps` reads left to right — `.panel > .row .cap` is
 * `[{panel}, {row, child:false}… ]` — and `child` on a step means the step
 * BEFORE it must be its immediate parent rather than any ancestor.
 */
interface StyleRule {
  steps: Array<{ classes: string[]; child: boolean; tag: string | null }>;
  color: string | null;
  background: string | null;
}

type StylePaint = StyleRule[];

const COMMENT_RE = /\/\*[\s\S]*?\*\//g;

/** Every `<style>` block's text, comments stripped. */
function stylesheetText(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1]!)
    .join('\n')
    .replace(COMMENT_RE, '');
}

/**
 * The mock's stylesheet as an ordered list of STRUCTURAL rules — `color` and
 * `background`, in source order, so a later declaration wins as the cascade does.
 *
 * ── What is READ, and what still ABSTAINS (MOTIR-3122) ─────────────────────
 * Read: any selector made only of CLASSES, in a descendant (`.a .b`), child
 * (`.a > .b`) or compound (`.a.b`) arrangement. Those paint in EVERY render, so
 * resolving them is not a guess — it is the same fact a bare `.a` states, one
 * containment step further out.
 *
 * Read: TAGS too (`th`, `table.spec`, `.doc h3`) — a tag is structural, so such a
 * rule paints in every render exactly as a class chain does. Excluding them cost
 * 381 faint findings and 270 MUTED violations, on the arm that is enforced
 * (MOTIR-3147); the same mistake as the bare-only form, one coordinate over.
 *
 * Abstains: a selector carrying a pseudo-class or pseudo-element (`:hover`,
 * `:focus`, `::before`), an attribute (`[data-state]`), or a universal. **That restriction is the original one and its warrant is
 * unchanged:** a STATE rule paints in one render and not another, so clearing an
 * ink on the strength of one would be a false NEGATIVE, and claiming a tint from
 * one would be a false positive nobody can act on. Both directions are still
 * declined.
 *
 * ── Why the bare-only form had to go ───────────────────────────────────────
 * It conflated those two populations. `.zoomctl .pct { color: var(--el-text-faint) }`
 * paints `80%` on screen every single time the page is opened, and the guard could
 * not see it — 299 such rules over ~775 elements that carry text and claim no
 * exemption, which is the blind spot MOTIR-3122 was filed for. A guard's blind
 * spot reads as a verdict, and this one was reading as a clean tree.
 */
function stylePaint(css: string): StylePaint {
  const rules: StylePaint = [];
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const color = declaredToken(body!, /(?:^|[;{\s])color\s*:\s*([^;]+)/i);
    const background = declaredToken(body!, /(?:^|[;{\s])background(?:-color)?\s*:\s*([^;]+)/i);
    if (!color && !background) continue;
    for (const selector of selectors!.split(',')) {
      const steps = parseSelector(selector);
      if (steps) rules.push({ steps, color, background });
    }
  }
  return rules;
}

/**
 * A selector as its chain of class compounds, or `null` when it names anything
 * this scanner declines to resolve (a state, an attribute, a tag, a universal).
 */
function parseSelector(selector: string): StyleRule['steps'] | null {
  const trimmed = selector.trim();
  if (!trimmed) return null;
  // Tokenize on whitespace and the child combinator, keeping the combinator.
  const parts = trimmed.split(/\s*(>)\s*|\s+/).filter((p) => p !== undefined && p !== '');
  const steps: StyleRule['steps'] = [];
  let child = false;
  for (const part of parts) {
    if (part === '>') {
      if (steps.length === 0) return null;
      child = true;
      continue;
    }
    // A compound is an optional TAG plus zero or more classes: `.a`, `.a.b`,
    // `th`, `table.spec`. A tag is STRUCTURAL — `.doc h3` paints every heading in
    // the doc, in every render — so it is read for the same reason a descendant
    // class chain is (MOTIR-3147). What still abstains is STATE, below.
    if (!/^[a-zA-Z][-\w]*(?:\.(?:[\w-]|\\.)+)*$|^(?:\.(?:[\w-]|\\.)+)+$/.test(part)) return null;
    const classes = [...part.matchAll(/\.((?:[\w-]|\\.)+)/g)].map((m) => m[1]!.replace(/\\/g, ''));
    const tagMatch = part.match(/^([a-zA-Z][-\w]*)/);
    const tag = tagMatch ? tagMatch[1]!.toLowerCase() : null;
    if (classes.length === 0 && !tag) return null;
    steps.push({ classes, child, tag });
    child = false;
  }
  return steps.length ? steps : null;
}

/** `element` matches this compound: its tag (when named) and every class. */
function carries(element: MockElement, classes: string[], tag: string | null): boolean {
  if (tag !== null && element.tag !== tag) return false;
  return classes.every((c) => element.classes.includes(c));
}

/**
 * Does `rule` match `element`, given the flat element list its `parent` indices
 * point into?
 *
 * Matched right to left: the LAST compound must be the element itself, then each
 * preceding compound is satisfied by the immediate parent (child combinator) or
 * by the nearest ancestor that carries it (descendant). The descendant search
 * takes the NEAREST match and does not backtrack — a deliberate simplification
 * that can only ever FAIL to match, never match something it should not, which
 * keeps the abstention on the safe side.
 */
function ruleMatches(rule: StyleRule, element: MockElement, elements: MockElement[]): boolean {
  const last = rule.steps[rule.steps.length - 1]!;
  if (!carries(element, last.classes, last.tag)) return false;
  let node: MockElement | undefined = element;
  for (let i = rule.steps.length - 1; i > 0; i -= 1) {
    const step = rule.steps[i - 1]!;
    const asChild = rule.steps[i]!.child;
    let ancestor: MockElement | undefined =
      node!.parent === -1 ? undefined : elements[node!.parent];
    if (asChild) {
      if (!ancestor || !carries(ancestor, step.classes, step.tag)) return false;
      node = ancestor;
      continue;
    }
    while (ancestor && !carries(ancestor, step.classes, step.tag)) {
      ancestor = ancestor.parent === -1 ? undefined : elements[ancestor.parent];
    }
    if (!ancestor) return false;
    node = ancestor;
  }
  return true;
}

/** The token the stylesheet paints on `element` for one axis — last rule wins. */
function paintedToken(
  element: MockElement,
  elements: MockElement[],
  paint: StylePaint,
  axis: 'color' | 'background',
): string | null {
  let token: string | null = null;
  for (const rule of paint) {
    if (rule[axis] === null) continue;
    if (ruleMatches(rule, element, elements)) token = rule[axis];
  }
  return token;
}

/**
 * The `--el-*` token a declaration resolves to, or null.
 *
 * `var(--el-x, var(--color-y))` resolves to `--el-x`: the fallback only applies
 * where the token is undefined, and a mock embeds the whole token table, so it
 * never is. A declaration that names no `--el-*` at all (a literal, a
 * `--color-*`) is not this scanner's business — the never-invent-a-colour rule
 * is a different guard.
 */
function declaredToken(body: string, pattern: RegExp): string | null {
  const match = body.match(pattern);
  if (!match) return null;
  const token = match[1]!.match(/var\(\s*(--el-[a-z0-9-]+)/);
  return token ? token[1]! : null;
}

/* ───────────────────────────── the two verdicts ───────────────────────────── */

function isHidden(element: MockElement): boolean {
  const hidden = element.attrs.get('aria-hidden');
  return hidden !== undefined && hidden !== 'false';
}

function hasAccessibleName(element: MockElement): boolean {
  return element.attrs.has('aria-label') || element.attrs.has('aria-labelledby');
}

/**
 * The glyph exemption, in the same three shapes `inkContrastScan.isDecorative`
 * reads: an explicitly hidden element, a labelled `role="img"`, and a labelled
 * control whose content is glyphs only. An icon that merely LOOKS decorative is
 * not exempt — saying so on the element is the fix, and it costs one attribute.
 */
function decorativeReason(element: MockElement): string | null {
  if (isHidden(element)) return `<${element.tag}> is aria-hidden`;
  if (element.attrs.get('role') === 'img') {
    return hasAccessibleName(element) ? `<${element.tag}> is a labelled role="img"` : null;
  }
  if (hasAccessibleName(element) && !element.hasText) {
    return `<${element.tag}> is a labelled control whose content is glyphs only`;
  }
  return null;
}

/** The 1.4.3 disabled exemption — declared on the element, never inferred. */
function disabledReason(element: MockElement): string | null {
  for (const key of ['disabled', 'aria-disabled']) {
    const value = element.attrs.get(key);
    if (value !== undefined && value !== 'false') return `<${element.tag}> is ${key}`;
  }
  return null;
}

/** The token this element paints as its own background, or null. */
function ownSurface(
  element: MockElement,
  elements: MockElement[],
  paint: StylePaint,
): string | null {
  for (const className of element.classes) {
    const utility = className.match(/^bg-\((--el-[a-z0-9-]+)\)$/);
    if (utility) return utility[1]!;
  }
  const inline = element.attrs.get('style');
  if (inline) {
    const token = declaredToken(inline, /(?:^|[;\s])background(?:-color)?\s*:\s*([^;]+)/i);
    if (token) return token;
  }
  return paintedToken(element, elements, paint, 'background');
}

/**
 * How this element takes `token`, or null if it does not — the utility class
 * written on the element, an inline `style`, or the mock's own stylesheet.
 *
 * An inline `style="color: var(--el-text-muted)"` is reported as `stylesheet`
 * rather than as a fourth `via`: the distinction the field records is whether
 * the ink is written in the Tailwind-shaped layer a mock is SUPPOSED to be
 * built from, and an inline declaration is not.
 */
function inkVia(
  element: MockElement,
  elements: MockElement[],
  paint: StylePaint,
  utility: string,
  token: string,
): 'class' | 'stylesheet' | null {
  if (element.classes.includes(utility)) return 'class';
  const inline = element.attrs.get('style');
  if (inline && declaredToken(inline, /(?:^|[;\s])color\s*:\s*([^;]+)/i) === token) {
    return 'stylesheet';
  }
  return paintedToken(element, elements, paint, 'color') === token ? 'stylesheet' : null;
}

/**
 * Every finding this mock carries — the muted ink over a tinted surface, which
 * the guard rules on, and the faint ink anywhere it carries text, which it
 * counts.
 *
 * The muted surface walk starts at the ink's own element (an element painting
 * its own background is the surface its ink sits on) and stops at the first
 * ancestor that paints one — so a white `--el-card` nested inside a tinted
 * panel correctly ends the search, exactly as the code scanner's walk does.
 *
 * The faint arm performs no walk. `--el-text-faint` measures 2.37–2.61:1
 * against every surface in the table, so there is no background that would
 * change the answer, and an abstention on an unresolvable one would be a false
 * negative rather than an honest gap.
 */
export function scanMock(file: string, html: string): MockFinding[] {
  const paint = stylePaint(stylesheetText(html));
  const elements = parseElements(html);
  const findings: MockFinding[] = [];

  for (const element of elements) {
    // ⚠️ The DANGER arm is ruled on BEFORE the two 1.4.3 grants, and that
    // ordering is the whole difference between it and the arms below
    // (MOTIR-3663). The grants exempt a decorative glyph and a disabled control
    // because 1.4.3 does not MEASURE either — which is the right answer for a
    // contrast threshold and the wrong one for a token that is simply the wrong
    // token: an aria-hidden glyph painted `--el-danger-text` on a page is
    // invisible, and 1.4.3 declining to measure it does not make it visible.
    // On the code side the same divergence was worth four of the fourteen
    // swept sites, all of them correctly-marked hidden glyphs.
    const dangerVia = inkVia(element, elements, paint, DANGER_CLASS, DANGER_TOKEN);
    if (dangerVia && ownSurface(element, elements, paint) !== DANGER_FILL_TOKEN) {
      findings.push({
        file,
        line: element.line,
        ink: 'danger',
        surface: ownSurface(element, elements, paint),
        element: element.tag,
        via: dangerVia,
        reason:
          `--el-danger-text is the ink FOR a bright danger fill (--color-destructive-foreground), ` +
          `and <${element.tag}> does not paint bg-(--el-danger) — so it specifies the fill's ink ` +
          `on a page, which is 1.00:1 in every palette's light theme. Use --el-danger-on-surface`,
        snippet: element.snippet,
      });
    }

    // The two 1.4.3 grants are properties of the ELEMENT, so they are read
    // once and applied to both inks — an aria-hidden glyph is exempt whichever
    // ink it takes.
    if (decorativeReason(element)) continue;
    if (disabledReason(element)) continue;

    const mutedVia = inkVia(element, elements, paint, MUTED_CLASS, MUTED_TOKEN);
    if (mutedVia) {
      let surface: string | null = null;
      for (let node: MockElement | undefined = element; node; ) {
        surface = ownSurface(node, elements, paint);
        if (surface) break;
        node = node.parent === -1 ? undefined : elements[node.parent];
      }
      if (surface && TINTED_SURFACE_TOKENS.includes(surface)) {
        findings.push({
          file,
          line: element.line,
          ink: 'muted',
          surface,
          element: element.tag,
          via: mutedVia,
          reason:
            `--el-text-muted is 4.12–4.34:1 on ${surface}; it clears AA only on the white ` +
            `page/card (CLAUDE.md's measured table)`,
          snippet: element.snippet,
        });
      }
    }

    const faintVia = inkVia(element, elements, paint, FAINT_CLASS, FAINT_TOKEN);
    // `hasText` is what separates an ink from a text ink here. The muted arm
    // needs no such test because its surface walk already requires a painted
    // ancestor; the faint arm has no walk, so without this every container
    // that merely INHERITS the ink down to a labelled glyph would be counted.
    if (faintVia && element.hasText) {
      findings.push({
        file,
        line: element.line,
        ink: 'faint',
        surface: null,
        element: element.tag,
        via: faintVia,
        reason:
          `--el-text-faint is 2.37–2.61:1 and clears AA on NO surface, so <${element.tag}> ` +
          `paints active informational text with an ink no background can rescue`,
        snippet: element.snippet,
      });
    }
  }
  return findings;
}

/**
 * The findings that FAIL the guard — BOTH inks, over BOTH layers.
 *
 * Two filters used to stand here and both are gone: `via === 'class'` (boundary
 * 2, removed by MOTIR-3054) and `ink === 'muted'` (the faint arm's decline,
 * removed by MOTIR-3068 once its 2199 findings were swept). Nothing narrows this
 * any more — a finding is a finding.
 */
export function violations(findings: MockFinding[]): MockFinding[] {
  return findings;
}

/**
 * The FAINT findings, split out of the ruled-on set by ink.
 *
 * It no longer marks a boundary — `violations()` returns these too. It survives
 * because the faint classification still has to be exercised in its own right:
 * both layers, the two 1.4.3 grants, and the no-surface-resolution case. A
 * classifier whose behaviour is only ever asserted through the aggregate is one
 * nobody can show is running.
 */
export function counted(findings: MockFinding[]): MockFinding[] {
  return findings.filter((finding) => finding.ink === 'faint');
}

export function formatMockFinding(finding: MockFinding): string {
  return `${finding.file}:${finding.line} — ${finding.reason}\n    ${finding.snippet}`;
}
