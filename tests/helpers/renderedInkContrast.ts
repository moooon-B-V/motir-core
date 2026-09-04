import { contrast, flattenColorMix, mixSrgb } from '../theme/colorMetrics';
import { loadTokenLayer, resolveToken } from '../theme/paletteCascade';

// MOTIR-4251 — the RENDER-TIME ink guard, for the surfaces the static walk
// declines to rule on.
//
// ── What this is for ───────────────────────────────────────────────────────
// `tests/theme/inkContrastLint.test.ts` resolves an ink's background by walking
// the AST of the module the ink is written in (widened by MOTIR-3711 to that
// component's own use sites in the same file). Its header states the remaining
// boundary in its own words: an element whose background is painted by a
// `<Card>`, a `<Popover.Content>` or a layout in ANOTHER module reads as "no
// surface found here" and the rule ABSTAINS — it does not rule the site safe, it
// declines to rule at all, because resolving that needs the import graph.
//
// That abstention is correct, deliberate, and NOT this module's to widen. What
// it is not is COVERED: **453 muted-ink sites across 195 modules** fall inside
// it, measured rather than described — `tests/theme/composedInkAbstentions.ts`
// runs the arm's own predicates over the same file set and records what it walks
// past, and `tests/theme/composedSurfaceInkCoverage.test.ts` is the guard that
// keeps that number honest. Run it rather than trusting this sentence.
// Five bug cards were filed one site at a time inside that hole — MOTIR-3523,
// MOTIR-3711, MOTIR-4030, MOTIR-4196, MOTIR-4246.
//
// A RENDER resolves what a static walk cannot: the composed DOM already carries
// the answer the import graph would have to reconstruct, and reading it is one
// `parentElement` loop. MOTIR-4196 shipped that loop inline in
// `tests/components/quick-view-rail-ink.test.tsx` and it immediately found a
// site the bug card that commissioned it had not named. This module is that
// loop, generalised.
//
// ── Why the failing surface set is DERIVED, never listed ───────────────────
// MOTIR-3693 is the card where a name-based surface model missed an alias:
// `--el-sidebar-bg` is `var(--color-surface)`, the identical `#f6f5f4` as
// `--el-surface`, and it was not on the hand-written list — 242 sub-AA pairs
// invisible to both guards for as long as the rail had existed. The static
// guard's `TINTED_SURFACE_TOKENS` is now total over the token table, and pinned
// by a test that reads `theme.css` back in both directions.
//
// This module does not need that list at all, and deliberately does not import
// it. The DOM names the background TOKEN (`bg-(--el-x)`); the token layer gives
// its RESOLVED value; `contrast()` gives the ratio. No enumeration of "which
// surfaces are tinted" exists here to go stale, so an alias cannot hide in one.
// That is also why this guard is STRICTLY WIDER than the static one: in the
// light theme `--el-text-muted` clears AA on exactly three of the fifty
// background tokens (`--el-page-bg`, `--el-card`, `--el-sidebar-item-bg-active`)
// and fails on the other forty-seven, where `TINTED_SURFACE_TOKENS` names
// sixteen. The extra thirty-one are the `--el-tint-*` family, the
// danger/warning/success surfaces, the tooltip and callout fills and the vote
// and chat backgrounds — every one of them a real background this repo paints.
//
// ── Which theme binds ──────────────────────────────────────────────────────
// LIGHT. In dark `--el-text-muted` and `--el-text-secondary` both resolve to
// `#a4a097`, so the muted ink passes on every one of those fifty backgrounds and
// the arm has nothing to say. Measuring dark for the muted ink is measuring the
// same pass twice. The FAINT ink is the other way round and fails in both — it
// clears AA on no background in either theme — which is why its rule below has
// no surface term at all. `themesThatBind()` states this as data rather than as
// a sentence, so a palette change that made dark binding would be visible.

/** WCAG 1.4.3 AA for body text. Large-text's 3:1 is deliberately not modelled. */
export const AA = 4.5;

/** The inks under measurement, as their token names. */
export const MUTED_INK = '--el-text-muted';
export const FAINT_INK = '--el-text-faint';
/**
 * The SECONDARY ink — added by MOTIR-4475, and the reason it is measured at all
 * is the opacity term below.
 *
 * At `opacity: 1` it clears AA on every background in both themes (6.18–6.80:1),
 * so including it costs nothing and finds nothing. Under a COMPOSITE it does
 * not: `opacity` scales whatever ink you pick toward the backdrop, and a title
 * re-inked from muted to secondary specifically to clear AA landed at 3.95:1
 * anyway. A guard that measures only the two inks a re-inking moves AWAY from
 * goes silent on exactly the sites a re-inking has just touched.
 */
export const SECONDARY_INK = '--el-text-secondary';

/** The background an element with no painting ancestor lands on. */
export const DEFAULT_SURFACE = '--el-page-bg';

export type Theme = 'light' | 'dark';

const classesOf = (el: Element) => el.getAttribute('class') ?? '';

/** `text-(--el-x)`, with or without a variant prefix (`hover:`, `group-hover:`). */
const inkClass = (token: string) => `text-(${token})`;
/** Every `bg-(--el-x)` on one element, prefixed or not. */
const PAINTS_BACKGROUND = /bg-\((--el-[\w-]+)\)/g;

/**
 * An `opacity-<n>` utility — Tailwind's numeric scale (`opacity-80` ⇒ `0.8`) or
 * an arbitrary value (`opacity-[0.66]`). A variant prefix is matched too, on the
 * same reading `resolveSurface` gives a prefixed background: a state of the TEXT
 * is covered by 1.4.3, and over-reporting a conditional one is the safe
 * direction to be wrong in.
 */
const OPACITY_UTILITY = /(?:^|[\s:])opacity-(?:(\d{1,3})|\[([\d.]+)\])(?![\w-])/g;

/** Every opacity this element declares, as a factor in `[0, 1]`. */
function opacitiesOf(el: Element): number[] {
  const out: number[] = [];
  for (const m of classesOf(el).matchAll(OPACITY_UTILITY)) {
    const value = m[1] !== undefined ? Number(m[1]) / 100 : Number(m[2]);
    if (Number.isFinite(value) && value >= 0 && value < 1) out.push(value);
  }
  return out;
}

/**
 * Every `--el-*` token that resolves to a flat hex in one theme, keyed by name.
 *
 * Non-colour tokens (radii, shadows, gradients) and anything still carrying an
 * unresolved `var()` are dropped rather than guessed at — a token this map does
 * not hold is one the guard says nothing about, which it then SAYS (see
 * `resolveSurface`'s `unknown` verdict) rather than silently passing.
 */
export type TokenHexes = Readonly<Record<string, string>>;

const HEX = /^#[0-9a-f]{6}$/i;
const cache = new Map<Theme, TokenHexes>();

export function tokenHexes(theme: Theme): TokenHexes {
  const hit = cache.get(theme);
  if (hit) return hit;
  const layer = loadTokenLayer();
  const out: Record<string, string> = {};
  for (const token of layer.elementTokens) {
    const { value, unresolved } = resolveToken(layer.rules, { palette: 'motir', theme }, token);
    if (unresolved.length > 0) continue;
    const flat = flattenColorMix(value);
    if (HEX.test(flat)) out[token] = flat.toLowerCase();
  }
  cache.set(theme, out);
  return out;
}

/** The measured ratio of one ink on one surface, or `null` if either is unknown. */
export function ratio(theme: Theme, ink: string, surface: string): number | null {
  const hexes = tokenHexes(theme);
  const a = hexes[ink];
  const b = hexes[surface];
  return a && b ? contrast(a, b) : null;
}

/** Does this ink fail AA on this surface? `null` when the pairing is unmeasurable. */
export function failsAA(theme: Theme, ink: string, surface: string): boolean | null {
  const r = ratio(theme, ink, surface);
  return r === null ? null : r < AA;
}

/**
 * Every background token the ink FAILS on, in one theme — derived, never listed.
 *
 * Exported because a test that wants to state the rule it is enforcing should
 * state it as this set rather than as a sentence about three token names.
 */
export function surfacesUnderAA(theme: Theme, ink: string): string[] {
  const hexes = tokenHexes(theme);
  const inkHex = hexes[ink];
  if (!inkHex) throw new Error(`${ink} does not resolve to a hex in the ${theme} theme`);
  return Object.keys(hexes)
    .filter((token) => contrast(inkHex, hexes[token]!) < AA)
    .sort();
}

/**
 * The themes in which this ink can fail at all — the arm that decides whether
 * measuring the second theme is a measurement or a repeat.
 *
 * For `--el-text-muted` this is `['light']`: in dark it resolves to the same hex
 * as `--el-text-secondary` and passes everywhere. For `--el-text-faint` it is
 * both. Asserted rather than asserted-about in
 * `tests/components/composed-surface-ink.test.tsx`.
 */
export function themesThatBind(ink: string, surfaces: readonly string[]): Theme[] {
  return (['light', 'dark'] as const).filter((theme) =>
    surfaces.some((surface) => failsAA(theme, ink, surface) === true),
  );
}

// ── The two structural WCAG 1.4.3 exemptions, read off the composed DOM ──────
//
// The static guard infers both from the source: `isDecorative` reads
// `aria-hidden` / `role="img"` / whether the element renders text, and
// `isDisabledElement` reads a `disabled` attribute or a disabled-looking ternary
// branch. Every one of those is a CLAIM about what will render. Here they are
// read back off the thing that did render, which is the one place they are facts
// — and is why the card asks for the faint arm at this tier at all.
//
// Nothing further is exempted. In particular a `hidden` element, an element
// inside a collapsed disclosure and an off-screen one are all still measured:
// they are text the user reaches by one interaction, and treating "not visible
// in this render" as an exemption is how a guard passes on the closed state of
// every popover in the tree.

/** Is this element, or an ancestor, hidden from the accessibility tree? */
function ariaHidden(el: Element): boolean {
  return el.closest('[aria-hidden="true"]') !== null;
}

/** Is this element, or an ancestor, a decorative glyph rather than text? */
function decorativeGlyph(el: Element): boolean {
  if (el.tagName.toLowerCase() === 'svg') return true;
  return el.closest('svg, [role="img"]') !== null;
}

/** Is this element, or an ancestor, disabled — the 1.4.3 grant WCAG makes? */
function disabled(el: Element): boolean {
  return el.closest('[disabled], [aria-disabled="true"], [data-disabled="true"]') !== null;
}

/** Does this element put characters on the screen itself, rather than via a child? */
function ownText(el: Element): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) text += node.textContent ?? '';
  }
  return text.trim();
}

/**
 * The text this ink actually paints. An ink lands on the element carrying the
 * class and CASCADES to every descendant that does not re-declare a colour, so
 * a wrapper `<div class="text-(--el-text-muted)">` around a `<span>` paints that
 * span's text. `textContent` is therefore the right reading, and `ownText` is
 * used only to make the finding message legible.
 */
function paintedText(el: Element): string {
  return (el.textContent ?? '').trim();
}

export type Exemption = 'aria-hidden' | 'decorative-glyph' | 'disabled' | 'no-text';

/** Which 1.4.3 exemption clears this element, if any. */
export function exemptionFor(el: Element): Exemption | null {
  if (ariaHidden(el)) return 'aria-hidden';
  if (decorativeGlyph(el)) return 'decorative-glyph';
  if (disabled(el)) return 'disabled';
  if (paintedText(el).length === 0) return 'no-text';
  return null;
}

// ── The surface walk ────────────────────────────────────────────────────────

export interface ResolvedSurface {
  /** The `--el-*` token whose value the text lands on. */
  token: string;
  /** The element that paints it — the container, or `null` for the page default. */
  painter: Element | null;
  /**
   * True when the token came from `DEFAULT_SURFACE` because nothing in the
   * mounted tree paints a background. A test whose every site resolves this way
   * is measuring a component OUT of the surface that composes it, which is the
   * one way this guard can be green and say nothing.
   */
  defaulted: boolean;
  /**
   * The cumulative `opacity` this text is composited at — `1` when nothing in
   * the chain dims it (MOTIR-4475).
   */
  opacity: number;
  /**
   * The token BEHIND the outermost dimming element, which the composite mixes
   * toward. Only meaningful when {@link opacity} is below 1.
   */
  backdrop: string;
}

/**
 * The surface an element's text lands on, resolved from the composed DOM.
 *
 * Two decisions, both the conservative direction and both different from the
 * static walk's — stated here because the card requires the two guards not to
 * drift into disagreeing silently:
 *
 *  1. **The WORST background an ancestor can paint decides.** An element with
 *     `bg-(--el-card) hover:bg-(--el-surface)` paints white at rest and the tint
 *     under the pointer, and hover is a STATE OF THE TEXT rather than a separate
 *     element — 1.4.3 covers it (this is MOTIR-4246's own reasoning about the
 *     `/items` row, and MOTIR-4246 is the card that owns those two sites). The
 *     static walk returns the unprefixed SAFE background first and clears the
 *     ink; this one takes the lowest-contrast token on the element. Over-
 *     reporting a conditional tint is the documented safe way to be wrong.
 *  2. **No painting ancestor means the PAGE**, not an abstention. A rendered
 *     tree bottoms out on `--el-page-bg`, so the honest default is white rather
 *     than a decline — and `defaulted` is carried on the result so a test can
 *     assert it mounted the composing surface rather than the leaf alone.
 */
export function resolveSurface(el: Element, theme: Theme, ink: string): ResolvedSurface {
  const hexes = tokenHexes(theme);
  const inkHex = hexes[ink];

  /** The worst background this one element paints, or null if it paints none. */
  const paintedBy = (node: Element): string | null => {
    const tokens = Array.from(classesOf(node).matchAll(PAINTS_BACKGROUND))
      .map((m) => m[1]!)
      .filter((token) => token in hexes);
    if (tokens.length === 0) return null;
    return inkHex
      ? tokens.reduce((a, b) =>
          contrast(inkHex, hexes[a]!) <= contrast(inkHex, hexes[b]!) ? a : b,
        )
      : tokens[0]!;
  };

  // ── PASS 1 — the surface, and the OPACITY chain above it (MOTIR-4475) ──────
  // `opacity < 1` composites the element AND ITS WHOLE SUBTREE against the
  // backdrop, so an ancestor's dimming reaches text several levels down and
  // reaches the fill that text sits on at the same time. The walk therefore
  // collects two things it did not before: the cumulative factor, and WHERE the
  // outermost dimming element sits — because that is what decides which
  // background is the composite's backdrop rather than part of the group.
  let token: string | null = null;
  let painter: Element | null = null;
  let opacity = 1;
  let outermostDimmed: Element | null = null;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (token === null) {
      const found = paintedBy(node);
      if (found !== null) {
        token = found;
        painter = node;
      }
    }
    for (const value of opacitiesOf(node)) {
      opacity *= value;
      outermostDimmed = node;
    }
  }
  const resolved = token ?? DEFAULT_SURFACE;
  const defaulted = token === null;
  if (opacity >= 1 || outermostDimmed === null) {
    return { token: resolved, painter, defaulted, opacity: 1, backdrop: DEFAULT_SURFACE };
  }

  // ── PASS 2 — the BACKDROP, strictly ABOVE the outermost dimming element ────
  // Everything at or below it is inside the composited group, including its own
  // fill; what the group is mixed toward is whatever paints behind it.
  let backdrop = DEFAULT_SURFACE;
  for (let node: Element | null = outermostDimmed.parentElement; node; node = node.parentElement) {
    const found = paintedBy(node);
    if (found !== null) {
      backdrop = found;
      break;
    }
  }
  return { token: resolved, painter, defaulted, opacity, backdrop };
}

/**
 * The ratio this text is ACTUALLY read at, composite included (MOTIR-4475).
 *
 * `opacity` mixes the whole group toward the backdrop, so BOTH terms move: the
 * ink toward the backdrop and the fill toward the backdrop. Measuring the ink at
 * full strength on the undimmed fill is the reading that let a title re-inked to
 * clear AA (6.18:1 on `--el-muted`) ship at 3.95:1 over the canvas.
 */
export function composedRatio(theme: Theme, ink: string, surface: ResolvedSurface): number | null {
  const hexes = tokenHexes(theme);
  const inkHex = hexes[ink];
  const surfaceHex = hexes[surface.token];
  if (!inkHex || !surfaceHex) return null;
  if (surface.opacity >= 1) return contrast(inkHex, surfaceHex);
  const backdropHex = hexes[surface.backdrop];
  if (!backdropHex) return null;
  const percent = surface.opacity * 100;
  return contrast(mixSrgb(inkHex, percent, backdropHex), mixSrgb(surfaceHex, percent, backdropHex));
}

// ── The finding ─────────────────────────────────────────────────────────────

export interface RenderedInkFinding {
  ink: string;
  surface: string;
  ratio: number;
  theme: Theme;
  tag: string;
  classes: string;
  text: string;
  /** True when the surface came from the page default rather than from an ancestor. */
  defaulted: boolean;
  /** The cumulative `opacity` the text is composited at — `1` when undimmed. */
  opacity: number;
  /** The token the composite mixes toward. Only meaningful below `opacity: 1`. */
  backdrop: string;
}

/**
 * The inks measured when a caller names none.
 *
 * SECONDARY joined MUTED and FAINT with the opacity term (MOTIR-4475): at full
 * strength it clears AA everywhere, so it is free; under a composite it is the
 * ink a re-inking will have just MOVED TO, and the guard has to be able to see
 * the site it was moved to.
 */
export const DEFAULT_INKS: readonly string[] = [MUTED_INK, FAINT_INK, SECONDARY_INK];

export interface InkSweepOptions {
  /** Which theme's resolved values to measure with. Default `light`. */
  theme?: Theme;
  /** Which inks to measure. Default: the muted and faint inks. */
  inks?: readonly string[];
}

/**
 * Normalise the one-or-many root argument. `Array.isArray` does not narrow a
 * `readonly T[]` usefully, so the cast is here once rather than at each call.
 */
export function rootList(roots: ParentNode | readonly ParentNode[]): ParentNode[] {
  return Array.isArray(roots) ? [...(roots as readonly ParentNode[])] : [roots as ParentNode];
}

/**
 * Every element in `roots` whose ink fails AA on the surface it actually lands
 * on, with the two structural exemptions applied.
 *
 * `roots` takes an array because a portalled surface — a popover body, a modal —
 * is not inside the container Testing Library returns. Pass
 * `[container, document.body]` for a component that portals; passing
 * `document.body` alone is equivalent and is what most callers want.
 */
export function findInkContrastFailures(
  roots: ParentNode | readonly ParentNode[],
  options: InkSweepOptions = {},
): RenderedInkFinding[] {
  const theme = options.theme ?? 'light';
  const inks = options.inks ?? DEFAULT_INKS;
  const list = rootList(roots);
  const seen = new Set<Element>();
  const findings: RenderedInkFinding[] = [];

  for (const root of list) {
    for (const el of Array.from(root.querySelectorAll<Element>('*'))) {
      if (seen.has(el)) continue;
      seen.add(el);
      const classes = classesOf(el);
      for (const ink of inks) {
        if (!classes.includes(inkClass(ink))) continue;
        if (exemptionFor(el) !== null) continue;
        const surface = resolveSurface(el, theme, ink);
        const measured = composedRatio(theme, ink, surface);
        if (measured === null || measured >= AA) continue;
        findings.push({
          ink,
          surface: surface.token,
          ratio: Number(measured.toFixed(2)),
          theme,
          tag: el.tagName.toLowerCase(),
          classes,
          text: (ownText(el) || paintedText(el)).slice(0, 60),
          defaulted: surface.defaulted,
          opacity: surface.opacity,
          backdrop: surface.backdrop,
        });
      }
    }
  }
  return findings;
}

export function formatRenderedFinding(f: RenderedInkFinding): string {
  const composite = f.opacity < 1 ? ` composited at opacity ${f.opacity} over ${f.backdrop}` : '';
  return `${f.ink} on ${f.surface}${composite} — ${f.ratio}:1 (${f.theme}, AA is ${AA}) — <${f.tag} class="${f.classes}"> "${f.text}"`;
}

/**
 * The tokens some element in `roots` actually paints a background with.
 *
 * A test asserts this is non-empty before trusting a green sweep: a component
 * mounted OUTSIDE the surface that composes it resolves every site to the page
 * default and passes for a reason that has nothing to do with the code. A check
 * that cannot go red is not evidence.
 */
export function paintedSurfaces(roots: ParentNode | readonly ParentNode[]): string[] {
  const list = rootList(roots);
  const out = new Set<string>();
  for (const root of list) {
    for (const el of Array.from(root.querySelectorAll<Element>('*'))) {
      for (const m of classesOf(el).matchAll(PAINTS_BACKGROUND)) out.add(m[1]!);
    }
  }
  return [...out].sort();
}

export interface MeasuredInkSite {
  ink: string;
  surface: string;
  ratio: number | null;
  /** The cumulative `opacity` the site is composited at — `1` when undimmed. */
  opacity: number;
  tag: string;
  text: string;
}

/**
 * Every ink site the sweep actually MEASURED — the ones that carried a measured
 * ink, survived the exemptions and resolved a surface, whether they passed or
 * failed.
 *
 * This is the anti-tautology instrument, and it is the assertion that matters
 * more than the green one. `findInkContrastFailures` returning `[]` has two
 * causes that look identical from the outside: the surface is clean, or the
 * mount rendered nothing carrying either ink. A test that asserts only the empty
 * findings list cannot tell them apart, and the second one stays green through
 * any future refactor that stops rendering the text at all.
 */
export function measuredInkSites(
  roots: ParentNode | readonly ParentNode[],
  options: InkSweepOptions = {},
): MeasuredInkSite[] {
  const theme = options.theme ?? 'light';
  const inks = options.inks ?? DEFAULT_INKS;
  const list = rootList(roots);
  const seen = new Set<Element>();
  const out: MeasuredInkSite[] = [];
  for (const root of list) {
    for (const el of Array.from(root.querySelectorAll<Element>('*'))) {
      if (seen.has(el)) continue;
      seen.add(el);
      const classes = classesOf(el);
      for (const ink of inks) {
        if (!classes.includes(inkClass(ink))) continue;
        if (exemptionFor(el) !== null) continue;
        const surface = resolveSurface(el, theme, ink);
        out.push({
          ink,
          surface: surface.token,
          ratio: composedRatio(theme, ink, surface),
          opacity: surface.opacity,
          tag: el.tagName.toLowerCase(),
          text: (ownText(el) || paintedText(el)).slice(0, 60),
        });
      }
    }
  }
  return out;
}
