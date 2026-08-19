import { SAFE_SURFACE_TOKENS } from './inkContrastScan';

// The DESIGN-ASSET arm of the ink-contrast guard (MOTIR-3014).
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
// ── The TWO boundaries, both measured, neither an oversight ────────────────
// A mock paints in two layers, and this arm ENFORCES one of them. Read
// `violations()` below with this: `scanMock` reports every finding it can see,
// and only the class-layer ones fail the guard.
//
//   1. THE UTILITY-CLASS LAYER — `text-(--el-text-muted)` written on the
//      element — is ENFORCED, at zero, across the whole mock tree. This is the
//      layer the design-asset rule (`CLAUDE.md` § design assets) says a mock is
//      built from: "the `components/ui/*` primitives' markup + the `globals.css`
//      `--el-*` tokens". It is also exactly what `inkContrastScan` reads out of
//      a component, so the two guards enforce one rule over one layer, in two
//      trees. Its whole population was 26 findings in 4 files, and MOTIR-3014
//      swept them; the guard has been green since.
//
//   2. THE MOCK'S OWN `<style>` BLOCK — `.tbtn { color: var(--el-text-muted) }`
//      — is READ (so the surface walk is accurate, below) but NOT ruled on.
//      277 findings across 51 files, measured. It is declined for a reason that
//      is about the artefact rather than the budget: a mock's stylesheet paints
//      BOTH the product surface it specifies AND the board it is presented on —
//      the panel captions, the numbered annotations, the fold measurements — and
//      nothing in the markup separates them. `design/work-items/
//      repository-set-quick-view.mock.html`'s `.foldNote` is the shape: muted
//      text on a tinted strip, carrying "MEASURED at 1280×900: the modal is
//      680px", which no user will ever see. Ruling on that population means
//      first deciding what a design board IS, which is a card that can make that
//      decision, not a contrast question this one can settle.
//      **`inkContrastScan` draws the same line from the other side**: its own
//      header says a background "painted from a stylesheet rather than a
//      `bg-(--el-…)` class" is outside it, because "the scanner never opens a
//      `.css` file". So this is the sibling guard's boundary, not a new one.
//
// The census in (2) is asserted NON-EMPTY by `design-ink-contrast.test.ts`, so
// the boundary stays load-bearing: if a sweep ever empties it, the assertion
// fails and this comment gets revisited rather than quietly outliving its
// subject.
//
// ── And the FAINT arm is not here at all ───────────────────────────────────
// `--el-text-faint` clears AA on no surface, so the code guard treats every
// non-decorative, non-disabled use as a violation. In a mock the dominant
// population of faint text is the board chrome above, at a scale that makes the
// judgement call unavoidable rather than incidental. Same decision, same owner,
// and stated here so that its absence reads as a choice.

/** The ink this arm rules on, as it appears in an arbitrary-value class. */
export const MUTED_CLASS = 'text-(--el-text-muted)';
export const MUTED_TOKEN = '--el-text-muted';

/**
 * The backgrounds on which `--el-text-muted` drops below 4.5:1 — CLAUDE.md's
 * measured table (MOTIR-2455): 4.17 / 4.12 / 4.34 against 4.54 on the white
 * page/card. The safe ones are `SAFE_SURFACE_TOKENS`, imported from the code
 * scanner so the two arms cannot disagree about which token is the page white.
 */
export const TINTED_SURFACE_TOKENS: readonly string[] = [
  '--el-surface',
  '--el-surface-soft',
  '--el-muted',
];

export { SAFE_SURFACE_TOKENS };

export interface MockFinding {
  file: string;
  line: number;
  /** The `--el-*` background the surface walk resolved under the ink. */
  surface: string;
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

interface ClassPaint {
  color: Map<string, string>;
  background: Map<string, string>;
}

const COMMENT_RE = /\/\*[\s\S]*?\*\//g;

/** Every `<style>` block's text, comments stripped. */
function stylesheetText(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1]!)
    .join('\n')
    .replace(COMMENT_RE, '');
}

/**
 * `class → --el-* token`, for `color` and for `background`, last declaration
 * winning as the cascade does.
 *
 * Only a BARE single-class selector is read (`.dsCard`, not `.dsCard:hover` and
 * not `.a .b`). That is the same asymmetry `inkContrastScan.paintsUnprefixed`
 * takes for the safe side and for the same reason: a state or context rule
 * paints in one render and not another, so clearing an ink on the strength of
 * one would be a false NEGATIVE, and claiming a tint from one would be a false
 * positive nobody can act on. Both directions are declined.
 */
function classPaint(css: string): ClassPaint {
  const color = new Map<string, string>();
  const background = new Map<string, string>();
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const inkToken = declaredToken(body!, /(?:^|[;{\s])color\s*:\s*([^;]+)/i);
    const bgToken = declaredToken(body!, /(?:^|[;{\s])background(?:-color)?\s*:\s*([^;]+)/i);
    if (!inkToken && !bgToken) continue;
    for (const selector of selectors!.split(',')) {
      const match = selector.trim().match(/^\.((?:[\w-]|\\.)+)$/);
      if (!match) continue;
      const name = match[1]!.replace(/\\/g, '');
      if (inkToken) color.set(name, inkToken);
      if (bgToken) background.set(name, bgToken);
    }
  }
  return { color, background };
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
function ownSurface(element: MockElement, paint: ClassPaint): string | null {
  for (const className of element.classes) {
    const utility = className.match(/^bg-\((--el-[a-z0-9-]+)\)$/);
    if (utility) return utility[1]!;
  }
  const inline = element.attrs.get('style');
  if (inline) {
    const token = declaredToken(inline, /(?:^|[;\s])background(?:-color)?\s*:\s*([^;]+)/i);
    if (token) return token;
  }
  for (const className of element.classes) {
    const declared = paint.background.get(className);
    if (declared) return declared;
  }
  return null;
}

/** How this element takes `--el-text-muted`, or null if it does not. */
function mutedVia(element: MockElement, paint: ClassPaint): 'class' | 'stylesheet' | null {
  if (element.classes.includes(MUTED_CLASS)) return 'class';
  const inline = element.attrs.get('style');
  if (inline && declaredToken(inline, /(?:^|[;\s])color\s*:\s*([^;]+)/i) === MUTED_TOKEN) {
    return 'stylesheet';
  }
  for (const className of element.classes) {
    if (paint.color.get(className) === MUTED_TOKEN) return 'stylesheet';
  }
  return null;
}

/**
 * Every place this mock puts `--el-text-muted` over a tinted surface.
 *
 * The surface walk starts at the ink's own element (an element painting its own
 * background is the surface its ink sits on) and stops at the first ancestor
 * that paints one — so a white `--el-card` nested inside a tinted panel
 * correctly ends the search, exactly as the code scanner's walk does.
 */
export function scanMock(file: string, html: string): MockFinding[] {
  const paint = classPaint(stylesheetText(html));
  const elements = parseElements(html);
  const findings: MockFinding[] = [];

  for (const element of elements) {
    const via = mutedVia(element, paint);
    if (!via) continue;
    const decorative = decorativeReason(element);
    if (decorative) continue;
    if (disabledReason(element)) continue;

    let surface: string | null = null;
    for (let node: MockElement | undefined = element; node; ) {
      surface = ownSurface(node, paint);
      if (surface) break;
      node = node.parent === -1 ? undefined : elements[node.parent];
    }
    if (!surface || !TINTED_SURFACE_TOKENS.includes(surface)) continue;

    findings.push({
      file,
      line: element.line,
      surface,
      element: element.tag,
      via,
      reason:
        `--el-text-muted is 4.12–4.34:1 on ${surface}; it clears AA only on the white ` +
        `page/card (CLAUDE.md's measured table)`,
      snippet: element.snippet,
    });
  }
  return findings;
}

/**
 * The findings that FAIL the guard — the utility-class layer only. The
 * stylesheet layer is reported by `scanMock` for the census, and is boundary
 * (2) in the header: read, measured, and deliberately not ruled on.
 */
export function violations(findings: MockFinding[]): MockFinding[] {
  return findings.filter((finding) => finding.via === 'class');
}

export function formatMockFinding(finding: MockFinding): string {
  return `${finding.file}:${finding.line} — ${finding.reason}\n    ${finding.snippet}`;
}
