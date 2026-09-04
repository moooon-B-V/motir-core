import { Window } from 'happy-dom';
import { contrast } from './colorMetrics';
import { MUTED_TOKEN, parseElements } from './inkContrastMockScan';

// MOTIR-4255 — the STATE arm of the design-asset ink guard.
//
// ── The hole this closes ────────────────────────────────────────────────────
// `inkContrastMockScan`'s `stylePaint` reads a mock's stylesheet as STRUCTURE
// and abstains, deliberately, on any selector carrying a pseudo-class. Its own
// words for why:
//
//   "a STATE rule paints in one render and not another, so clearing an ink on
//    the strength of one would be a false NEGATIVE, and claiming a tint from
//    one would be a false positive nobody can act on."
//
// That warrant is correct and this file does not touch it. A static walk cannot
// know whether the state obtains, so it may not rule either way. The
// consequence, though, is that `design-ink-contrast` enforces the MUTED arm at
// ZERO across the whole tree and is green — which reads as *the assets are
// clean* and means *the assets are clean in their RESTING state*. Every hover
// tint, every focus ring's ground, every `:active` press is unmeasured by
// construction, i.e. most of the states a person is actually in while reading a
// row, because you hover the row you are reading.
//
// The remedy is therefore NOT a wider grep. It is an instrument that HAS the
// answer a static walk cannot have: a real CSS engine, a real DOM, and the
// containment question asked of the tree rather than of the selector text.
//
// ── Why a RENDER answers what the selector text cannot ──────────────────────
// `.lt-row:hover { background: var(--el-surface) }` and
// `.cell-title .lr-id { color: var(--el-text-muted) }` are two rules in one
// file, and whether they ever meet is a fact about the MARKUP: is a `.lr-id`
// inside a `.lt-row`, with nothing opaque in between? `stylePaint` resolves a
// structural chain by walking its own parsed element list, which is why the
// bare-selector widenings (MOTIR-3122, MOTIR-3169) were possible at all — but
// each of those extended the same string matcher one selector form further, and
// the form left over is the one where the string is not the question. Here the
// engine matches the selector, builds the tree, applies the cascade, substitutes
// every `var()` and hands back a hex. `design-dark-parity.test.ts` (MOTIR-3592)
// established that this lane may ask a CSS engine what a mock COMPUTED; this is
// the second spec to do it, for the same reason and on the same engine.
//
// ── Why happy-dom, and what was probed before trusting it ───────────────────
// `vitest.design.config.ts` runs on EVERY branch prefix and its `design-guards`
// job installs no browser — "an install plus a few seconds of Node" is the cost
// class the lane promises. happy-dom is already a devDependency. It is NOT
// interchangeable with jsdom here, and the difference is the whole guard:
// jsdom's `getComputedStyle` does not expand `var()` and drops the
// `background: var(--x)` SHORTHAND, both silently and both in the
// UNDER-reporting direction — a guard built on it would pass and read as
// coverage. Probed against `design/work-items/list.mock.html` before this file
// was written, happy-dom resolves `color: var(--el-text-muted)` to `#787671`,
// resolves BOTH `background:` and `background-color:` shorthands through
// `var()`, exposes `document.styleSheets` with `selectorText` and recurses into
// `@media` / `@layer` grouping rules.
//
// Two behaviours it has that the code below is written AROUND rather than
// against, because both were observed and neither is a bug:
//
//   1. `getComputedStyle(el).getPropertyValue('--el-x')` reads '' on an element
//      that does not itself declare the custom property. So a token is resolved
//      by PLANTING a probe element at the site and reading back a real
//      `color`, never by reading the custom property.
//   2. An UNDEFINED custom property makes the declaration invalid at computed
//      value time, so `color: var(--undefined)` INHERITS — which, for a probe
//      planted inside the very element whose ink is being classified, returns
//      that element's own colour and makes every ink look like the token.
//      Fifteen mocks in this tree define no `--el-text-muted` at all (they
//      alias a raw hex on `:root`), so this is not a hypothetical: unguarded,
//      they reported their FAINT ink as muted. The guard is a probe planted
//      inside a WRAPPER that paints a sentinel colour, so an unresolved token
//      inherits the sentinel and is detected instead of the site's own ink.
//      ⚠️ NOT a `var(--x, <sentinel>)` fallback, which is the obvious form and
//      does not work: happy-dom substitutes only ONE level when a fallback is
//      present, so `var(--el-text-muted, #ff00fe)` reads back the literal
//      string `var(--color-muted-foreground)` on an asset where the plain
//      `var(--el-text-muted)` resolves to `#787671`.
//
// ── What this rules on, and the boundary it declares ────────────────────────
// RULED ON: `--el-text-muted`, on text it paints inside an element whose
// background is painted by an INTERACTION-STATE rule, at under 4.5:1. Same ink,
// same threshold and the same two 1.4.3 grants as the resting arm — only the
// surface's provenance differs.
//
// DECLINED, with its count reported by the spec so it cannot outlive its reason
// quietly:
//
//   • ATTRIBUTE selectors (`[data-state='open']`, `[data-theme='dark']`). The
//     resting scanner abstains on these in the same breath as the pseudo-classes,
//     but they are not one population: `:hover` is a STATE a pointer puts an
//     element into, while `[data-theme]` is a SCOPE the document is authored in
//     and `design-dark-parity` already rules on. Ruling on both from one arm
//     would mean deciding, per attribute, which it is — which is a judgement,
//     not a measurement.
//
// ── The GROUND is composited, not the nearest opaque thing (MOTIR-4317) ─────
// Two colours in this file carry an alpha and only one of them used to be
// measured. A state rule's own translucent tint was composited over the ground
// beneath it, deliberately and with its reason written on `composite`. An
// ANCESTOR's translucent background was not: `restingBackground` asked `toHex`,
// which refuses any alpha under 1, and read that refusal as *this element
// paints nothing* — so the walk continued past a modal scrim, a frosted panel
// or a glass `data-surface` to the page underneath. The asymmetry was the whole
// bug: one translucent layer was composited because the code reached it through
// `composite`, the other was dropped because the code reached it through
// `toHex`.
//
// It reached both readers of that walk — the state SURFACE a finding is
// measured against, and `restingSurface` / `restingRatio`, the CONTROL that
// says whether a pair already fails at rest (the resting arm's finding, a
// duplicate) or only under the tint (this arm's discovery). A control measured
// against a ground the walk never composited is arbitrary in the REASSURING
// direction: it reads *fine at rest*, which makes every finding look like a
// discovery. Measured on the shape it was found in, a lightbox's white chrome
// inside an 80%-black scrim read 1.07:1 where it is 6.90:1.
//
// `restingBackground` now folds the translucent stack over the first opaque
// ground with the same `composite`. `toHex` keeps its alpha refusal — it is
// what TELLS the walk a layer is translucent — and the subtree walk's opaque-only
// question is unchanged, because a translucent element background correctly does
// NOT re-ground the subtree beneath it.
//
// ── The PARSER underneath both of those (MOTIR-4342) ────────────────────────
// The section above turns a silent skip into an honest abstention, and names
// the gap one colour form further out: `toHex` read neither an 8-digit
// `#rrggbbaa` nor `currentcolor`, so 47 elements on `origin/main` @ `e6d85218d`
// painted a background this file could not read at all — 20 of them an 8-digit
// hex across 6 assets, 27 a `currentcolor`. Both are ordinary design-system
// authoring: the first is the frosted-panel / scrim / glass `data-surface`
// material axis, the second a background that means *whatever this element's
// ink is*.
//
// Widening the parser is NOT a local change to a regex, which is why it did not
// belong inside MOTIR-4317. A `toHex` null is read as *translucent* by the
// grounding walk, as *not a colour* by the ink read, and as *unresolvable* by
// `composite` — three readers, three meanings, one return value — so what the
// widening changes is what three separate measurements MEAN. Three things
// follow, and they are the shape of the section below:
//
//   1. ONE parse. `parseColour` is the single reader; `toHex`, `alphaIn`,
//      `composite` and `classifyPaint` are four questions asked of it. A form
//      one of them can read and another cannot is the asymmetry MOTIR-4317 was.
//   2. `currentcolor` is resolved AT THE SITE, in `paintedBackground` and
//      `resolveAt`, never string-matched at a call site — it is a value-at-a-
//      site question, which is what this file renders to answer.
//   3. *Translucent* and *unreadable* stop sharing `toHex`'s null where the
//      difference is load-bearing: `classifyPaint` gives the grounding walk
//      three answers, and `groundAbstentionReason` prints which one happened.
//      A guard that fails for the wrong reason costs more than one that fails
//      for none.
//
// The state arm measured 0 findings and 0 abstentions over all 167 mocks both
// before and after — every one of those 47 elements sits off the chains this
// arm walks, which is a fact about which assets carry `:hover` tints this week
// and not a boundary anybody drew.
//
// ── The SECOND boundary is GONE, with its subject (MOTIR-4277) ──────────────
// This file shipped a second decline and a second counter, `unTokenisedInkCount`:
// ink that names NO `--el-*` token at all — a raw hex, or a local `:root` alias
// like `--muted: #787671` — could fail the same pairing in the same pixels, and
// the remedy this arm applies is a token SWAP with no token to swap. It reported
// 18 such elements across 2 assets, and the spec asserted the number non-zero so
// the decline could not go quiet while its subject was still there.
//
// MOTIR-4277 re-pointed both assets at the token layer, which took the count to
// **0 across all 167 mocks**. The counter and its assertion are deleted rather
// than reworded — the precedent is MOTIR-3068, which deleted a decline with its
// subject. What is NOT a boundary and needs no counter is the scope sentence
// above: this arm rules on `--el-text-muted`, so ink naming a different token,
// or none, is simply not its subject. An ink outside the token layer is the
// never-invent-a-colour rule's subject (`CLAUDE.md`), and it is enforced there.

/** The interaction states this arm resolves. Ordered as written, for the report. */
export const STATE_PSEUDO_CLASSES = [
  'hover',
  'focus',
  'focus-within',
  'focus-visible',
  'active',
  'checked',
  'target',
] as const;

/**
 * ⚠️ LONGEST ALTERNATIVE FIRST, and it is not cosmetic. A regex alternation is
 * ordered, and `\b` matches between `focus` and the `-` of `focus-within` — so
 * `:(?:focus|focus-within)` matches `:focus` inside `:focus-within`, `statesIn`
 * reports the wrong state and `baseSelector` rewrites `.x:focus-within` to the
 * selector `.x-within`, which matches nothing and reports a clean asset.
 */
const STATE_PSEUDO_RE = new RegExp(
  `:(?:${[...STATE_PSEUDO_CLASSES].sort((a, b) => b.length - a.length).join('|')})\\b`,
  'g',
);

/** Selectors carrying an ATTRIBUTE, which this arm declines — counted, not ruled on. */
const ATTRIBUTE_SELECTOR_RE = /\[[^\]]+\]/;

/** WCAG 1.4.3's small-text floor. The same number both resting arms measure against. */
export const AA_SMALL_TEXT = 4.5;

/**
 * A colour no palette in this tree contains. Every probe is planted inside a
 * wrapper painted this colour, so a token that does not resolve INHERITS the
 * sentinel and is detected rather than reading back the site's own ink. See the
 * header's (2) for why a `var()` fallback cannot do this job.
 */
const SENTINEL = '#ff00fe';

export interface StateInkFinding {
  file: string;
  /** The line of the element's opening tag, from the shared tokenizer. */
  line: number;
  /** The state rule's own selector, verbatim, e.g. `.lt-row:hover`. */
  stateSelector: string;
  /** Which interaction state paints it — `hover`, `focus-within`, … */
  state: string;
  /** The state background as the engine resolved it AT the host, e.g. `#f6f5f4`. */
  surface: string;
  /** The declaration the surface came from, e.g. `var(--el-surface)`. */
  surfaceValue: string;
  /** The ink as the engine resolved it, e.g. `#787671`. */
  ink: string;
  /**
   * The selector(s) of the rule that PAINTS that ink on this element — the
   * thing a sweep edits. A finding names the pixels; this names the line.
   * `(utility class or inline style)` where the ink is not painted by a rule.
   */
  inkRule: string;
  /** The measured ratio against `surface`. Under `AA_SMALL_TEXT` by construction. */
  ratio: number;
  /**
   * The same ink against the surface it sits on at REST, or null where nothing
   * opaque grounds it. The CONTROL: a pair that already fails at rest is the
   * resting arm's finding, not this one, and would be a duplicate rather than a
   * discovery.
   */
  restingSurface: string | null;
  restingRatio: number | null;
  element: string;
  snippet: string;
}

/** A site the render could not rule on, with the reason. Never counted as clean. */
export interface StateInkAbstention {
  file: string;
  stateSelector: string;
  reason: string;
}

export interface MockStateScan {
  file: string;
  findings: StateInkFinding[];
  abstentions: StateInkAbstention[];
  /** State rules declaring a background — the population this arm walked. */
  stateBackgroundRules: number;
  /** Rules declaring a background from an ATTRIBUTE selector — declined, counted. */
  attributeBackgroundRules: number;
}

/* ─────────────────────────── addressing a DOM node ─────────────────────────
 * A DOM node carries no source position, and a finding without one sends a
 * reader to search a two-thousand-line asset for a `<span>` that appears
 * eighteen times. So every opening tag is stamped with its own line BEFORE the
 * document is parsed, using the offsets the shared tokenizer already records —
 * one tokenizer, not two.
 */

export const LINE_ATTRIBUTE = 'data-mock-source-line';

/** The same HTML with `data-mock-source-line="<n>"` on every opening tag. */
export function stampSourceLines(html: string): string {
  const elements = parseElements(html);
  let out = html;
  // Descending, so an earlier insertion never moves a later offset.
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const element = elements[i]!;
    const name = out.slice(element.offset + 1).match(/^[a-zA-Z][-a-zA-Z0-9:]*/);
    if (!name) continue;
    const at = element.offset + 1 + name[0].length;
    out = `${out.slice(0, at)} ${LINE_ATTRIBUTE}="${element.line}"${out.slice(at)}`;
  }
  return out;
}

/* ──────────────────────────── colour resolution ──────────────────────────── */

/**
 * The hex forms this file reads — 3, 4, 6 and 8 digits.
 *
 * ⚠️ MOTIR-4342 — the 4- and 8-digit forms carry an ALPHA channel, and until
 * this widened they were not hex to this file at all. `#00000066` and
 * `rgba(0, 0, 0, 0.4)` paint identical pixels, which is what made the gap
 * invisible: a reader auditing this file for alpha handling finds `alphaIn`,
 * `composite` and an explicit refusal in `toHex`, all correct and all reasoning
 * carefully about alpha, and nothing in that reading suggests a whole notation
 * is missing. The tell was never in the code that handles alpha; it was in the
 * one regex that decides what counts as a hex.
 *
 * Measured on `origin/main` @ `e6d85218d`, over all 167 mocks: 20 elements
 * across 6 assets paint an 8-digit hex — the frosted panels, canvas scrims and
 * glass `data-surface` overlays of the material axis `CLAUDE.md` documents, so
 * the population is what the tree looks like when the design system is used as
 * intended, not an exotic authoring form.
 */
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A colour this file can read, in the one shape every reader below wants. */
interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0…1. A form that declares no alpha reads 1. */
  a: number;
}

/**
 * Read a colour, or null when this file cannot — the SINGLE parse every other
 * function in this section goes through.
 *
 * It is one function rather than a regex per caller because widening what the
 * file can read is not a local change: `toHex`, `alphaIn`, `composite` and
 * `classifyPaint` ask four different questions of the same value, and a form
 * one of them could read while another could not is exactly the asymmetry
 * MOTIR-4317 was filed for — one translucent layer composited because the code
 * reached it through `composite`, the other dropped because the code reached it
 * through `toHex`.
 */
function parseColour(value: string): Rgba | null {
  const trimmed = value.trim();
  if (HEX_RE.test(trimmed)) {
    const digits = trimmed.slice(1);
    // `#rgb` / `#rgba` are the same colour with every digit doubled.
    const wide =
      digits.length <= 4
        ? digits
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : digits;
    const at = (index: number) => parseInt(wide.slice(index * 2, index * 2 + 2), 16);
    return { r: at(0), g: at(1), b: at(2), a: wide.length === 8 ? at(3) / 255 : 1 };
  }
  const rgb =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(trimmed);
  if (!rgb) return null;
  return {
    r: Number(rgb[1]!),
    g: Number(rgb[2]!),
    b: Number(rgb[3]!),
    a: rgb[4] === undefined ? 1 : alphaOf(rgb[4]!),
  };
}

function alphaOf(raw: string): number {
  return raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
}

/** One 0–255 channel as its two hex digits. */
function channel(raw: number): string {
  return Math.round(raw).toString(16).padStart(2, '0').slice(-2);
}

function hexOf(colour: Rgba): string {
  return `#${channel(colour.r)}${channel(colour.g)}${channel(colour.b)}`;
}

/**
 * The OPAQUE colour a value names, or null.
 *
 * ⚠️ THE NULL MEANS TWO DIFFERENT THINGS — *this is not a colour I can read*
 * and *this colour is translucent* — and it always has. That is why
 * `classifyPaint` below exists and why `restingBackground` asks IT rather than
 * asking this twice: the alpha refusal is deliberate and load-bearing (it is
 * what TELLS the walk a layer has to be composited rather than taken as the
 * ground), so the refusal cannot also be the file's *unreadable* signal.
 */
function toHex(value: string): string | null {
  const colour = parseColour(value);
  return colour === null || colour.a < 1 ? null : hexOf(colour);
}

/**
 * The alpha carried by a resolved colour, for the one question its callers ask:
 * does this paint any pixels at all? A form that declares no alpha reads 1,
 * which is every opaque spelling — and also every form this file cannot parse,
 * where the answer is *something is painted here* and how much is decided
 * downstream (`restingBackground` abstains rather than guessing).
 */
function alphaIn(value: string): number {
  return parseColour(value)?.a ?? 1;
}

/** How the walk reads ONE painted background value. */
export type PaintClass = 'opaque' | 'translucent' | 'unreadable';

/**
 * Classify a painted background — the THREE answers `restingBackground` has to
 * tell apart, where `toHex` alone gives it two.
 *
 * ⚠️ MOTIR-4342. Before this, *translucent* and *unreadable* arrived at that
 * walk as one `toHex` null, so a layer the file could not parse was pushed onto
 * the composite stack like a scrim and the site abstained saying *"translucent
 * over no opaque ground"* — which is not why. **A guard that fails for the wrong
 * reason costs more than one that fails for none:** the first reader spends the
 * run looking at the asset instead of at the parser.
 */
export function classifyPaint(value: string): PaintClass {
  const colour = parseColour(value);
  if (colour === null) return 'unreadable';
  return colour.a >= 1 ? 'opaque' : 'translucent';
}

/** Does this value name `currentcolor` anywhere in it? */
const CURRENT_COLOUR_RE = /\bcurrentcolor\b/i;

/**
 * Substitute `currentcolor` with the element's own computed `color`.
 *
 * `currentcolor` is a background that means *whatever this element's ink is* —
 * a value-AT-a-site question exactly like `var()`, and a real colour the engine
 * already knows. So it is answered HERE, once, before anything downstream tries
 * to read the value as a colour, rather than special-cased at whichever call
 * site happened to meet it first. Twenty-seven elements paint one as a
 * background on `origin/main` @ `e6d85218d`.
 *
 * ⚠️ IT CANNOT BE LEFT TO `resolveAt`'s PROBE, which is why `resolveAt` calls
 * this rather than the other way round: the probe is planted inside a wrapper
 * that paints the sentinel, so a probe declaring `color: currentcolor` reads the
 * SENTINEL back and the site is reported as an undefined token.
 *
 * Where the engine has no colour to give — an element whose own `color` is
 * itself unresolved — the value is returned untouched and classifies as
 * unreadable, which is the honest answer rather than a fabricated one.
 */
function substituteCurrentColour(window: Window, element: El, value: string): string {
  if (!CURRENT_COLOUR_RE.test(value)) return value;
  const ink = window.getComputedStyle(element).getPropertyValue('color').trim();
  if (!ink || CURRENT_COLOUR_RE.test(ink)) return value;
  return value.replace(/\bcurrentcolor\b/gi, ink);
}

/**
 * Composite a possibly-translucent colour over an opaque ground, or return it
 * unchanged when it is already opaque.
 *
 * A hover tint written `rgba(0, 0, 0, 0.08)` — or `#00000014`, the same pixels
 * spelled the other way — paints REAL pixels, and declining to measure it
 * because it carries an alpha would be an abstention with no warrant: the ground
 * under it is knowable, and where it is not this returns null and the site is
 * named rather than passed.
 */
function composite(value: string, ground: string | null): string | null {
  const over = parseColour(value);
  if (over === null) return null;
  if (over.a >= 1) return hexOf(over);
  if (over.a <= 0 || ground === null) return null;
  const under = parseColour(ground);
  if (under === null) return null;
  const mix = (o: number, u: number) => channel(o * over.a + u * (1 - over.a));
  return `#${mix(over.r, under.r)}${mix(over.g, under.g)}${mix(over.b, under.b)}`;
}

/* ─────────────────────────────── the scan ────────────────────────────────── */

type Doc = Window['document'];
type El = ReturnType<Doc['querySelector']> & object;

interface PaintRule {
  selectorText: string;
  background: string;
  color: string;
}

/** Every style rule in the document that paints ink or ground, `@media` / `@layer` included. */
function styleRules(document: Doc): PaintRule[] {
  const out: PaintRule[] = [];
  const walk = (rules: unknown[]) => {
    for (const rule of rules as {
      selectorText?: string;
      style?: { getPropertyValue(name: string): string };
      cssRules?: unknown[];
    }[]) {
      if (rule.cssRules?.length) walk([...rule.cssRules]);
      if (typeof rule.selectorText !== 'string' || !rule.style) continue;
      const background =
        rule.style.getPropertyValue('background') ||
        rule.style.getPropertyValue('background-color');
      const color = rule.style.getPropertyValue('color');
      if (background.trim() || color.trim())
        out.push({ selectorText: rule.selectorText, background, color });
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk([...sheet.cssRules]);
    } catch {
      // A sheet the engine could not parse is named by the caller's abstention
      // list via the zero-rule count, not swallowed here.
    }
  }
  return out;
}

/**
 * Resolve a CSS value AT a place in the tree, by planting a probe element there
 * and reading back what the engine computed.
 *
 * This is the whole reason the file renders: `var(--el-surface)` means whatever
 * the cascade says it means at THAT element — a nested `[data-theme]` or
 * `[data-palette]` scope changes the answer — and no amount of reading the
 * stylesheet gets that right.
 */
function resolveAt(window: Window, host: El, value: string): string | null {
  // `currentcolor` is substituted BEFORE the probe is planted, never by it —
  // see `substituteCurrentColour`'s header for why the probe cannot answer it.
  const declared = substituteCurrentColour(window, host, value);
  const wrapper = window.document.createElement('span');
  wrapper.setAttribute('style', `color: ${SENTINEL}`);
  const probe = window.document.createElement('span');
  probe.setAttribute('style', `color: ${declared}`);
  wrapper.appendChild(probe);
  host.appendChild(wrapper);
  const resolved = window.getComputedStyle(probe).getPropertyValue('color').trim();
  wrapper.remove();
  // The sentinel showing through means the declaration was invalid at computed
  // value time — an undefined token — and NOT that the site paints magenta.
  return toHex(resolved) === SENTINEL ? null : resolved;
}

/**
 * The spellings this engine hands back for *no background COLOUR is painted
 * here*. Enumerated by MEASUREMENT over the asset tree, not assumed:
 * `background: none` computes to `"none"`, and a `background:` shorthand
 * carrying only a gradient computes to `"initial"` — the shorthand set no
 * colour, and `background-color` is the only half this walk reads. The
 * remaining CSS-wide keywords are the same answer in the same position.
 *
 * ⚠️ The pre-MOTIR-4317 walk got all of these right BY ACCIDENT. It asked
 * `toHex`, which refuses everything it cannot parse, so *paints no colour* and
 * *paints a translucent colour* arrived as one indistinguishable null — and
 * skipping was the correct handling of one of them. Compositing the translucent
 * layers makes the two answers different for the first time, which is why this
 * set has to be written down rather than left to a parse failure.
 */
const PAINTS_NO_COLOUR = new Set([
  'transparent',
  'none',
  'initial',
  'unset',
  'revert',
  'revert-layer',
]);

/**
 * The background an element paints ITSELF, RESOLVED, or null when it paints
 * nothing at all — no declaration, one of the spellings above, or a zero-alpha
 * colour, which are all one answer.
 *
 * ⚠️ This does NOT decide whether the colour is opaque. That is the caller's
 * question and the two callers want opposite things from it — see
 * `ownBackground` and `restingBackground` directly below. Ask `classifyPaint`.
 *
 * ⚠️ "RESOLVED" is MOTIR-4342's one word: `currentcolor` is substituted here,
 * at the element that paints it, so every caller downstream sees a colour
 * rather than a keyword only this element can expand. Exported because the
 * census that measures which of the tree's painted backgrounds this file can
 * READ has to ask the shipped resolver rather than copy its predicate.
 */
export function paintedBackground(window: Window, element: El): string | null {
  const declared = window.getComputedStyle(element).getPropertyValue('background-color').trim();
  if (!declared || PAINTS_NO_COLOUR.has(declared.toLowerCase())) return null;
  const value = substituteCurrentColour(window, element, declared);
  return alphaIn(value) <= 0 ? null : value;
}

/**
 * The element's own OPAQUE background, or null when it paints none or paints a
 * translucent one.
 *
 * The subtree walk in `scanMockStateInk` is the caller this shape is for: an
 * element painting an opaque background RE-GROUNDS everything beneath it, so
 * the state tint above does not reach that subtree; a translucent one neither
 * re-grounds it nor stops the tint reaching it, and reading null for that case
 * is correct there.
 */
function ownBackground(window: Window, element: El): string | null {
  const value = paintedBackground(window, element);
  return value === null ? null : toHex(value);
}

/**
 * The surface an element sits on at REST — the nearest OPAQUE ancestor, with
 * every TRANSLUCENT layer between the element and that ground composited back
 * over it, in paint order.
 *
 * ⚠️ MOTIR-4317 — the walk used to STOP being interested in a translucent
 * ancestor rather than composite it, because it asked `toHex`, which returns
 * null for any alpha under 1. So a modal scrim, a frosted panel or a glass
 * `data-surface` was read as painting NOTHING, and the ground came back as the
 * page it covers. Measured: a lightbox's white chrome inside an 80%-black scrim
 * reported 1.07:1 against the board's light page, where it is 6.90:1 — 6.4x
 * wrong, in the direction that manufactures a finding.
 *
 * The asymmetry was the bug, and `composite`'s own header had already settled
 * the principle for the other half: *"a hover tint written `rgba(0, 0, 0, 0.08)`
 * paints REAL pixels, and declining to measure it because it carries an alpha
 * would be an abstention with no warrant."* That is as true of an ancestor's
 * background as of a state rule's. `toHex` keeps its alpha refusal — it is what
 * TELLS this walk a layer is translucent — and this is the one place that knows
 * what to do with the answer.
 *
 * Where the chain reaches the document with no opaque ground anywhere, there is
 * nothing to composite over and the honest answer is still null; both callers
 * already handle it (an abstention naming the site, and the CONTROL's *nothing
 * opaque grounds it at rest*). A layer this cannot READ takes the same answer:
 * an unknown ground is not a ground to claim, and skipping such a layer would
 * be this very defect one colour form further out.
 *
 * ⚠️ MOTIR-4342 — THOSE TWO NULLS ARE DIFFERENT ANSWERS, AND THEY NO LONGER
 * SHARE ONE RETURN VALUE. MOTIR-4317 left them both as a bare null, so the
 * caller's abstention read *translucent over no opaque ground* for both; this
 * returns the layer it could not read alongside the null, and
 * `groundAbstentionReason` says which happened. It is a second return shape
 * rather than a note because the widening one line up made the unreadable
 * branch a smaller set, not an empty one — a named CSS colour, an `hsl()` the
 * engine passes through, the next notation nobody has thought of.
 */
interface RestingGround {
  /** The composited ground, or null when the walk cannot name one. */
  ground: string | null;
  /**
   * The layer value the walk could not READ, where that is why `ground` is
   * null. Null when the chain is simply translucent all the way to the
   * document — a different answer, and one that gets a different reason.
   */
  unreadable: string | null;
}

function restingBackground(window: Window, element: El): RestingGround {
  const layers: string[] = []; // translucent, nearest the element first
  let ground: string | null = null;
  for (let node: El | null = element; node; node = node.parentElement as El | null) {
    const value = paintedBackground(window, node);
    if (value === null) continue;
    const paint = classifyPaint(value);
    // An unreadable layer stops the walk rather than joining the fold: the
    // pixels above the ground are unknown, so the ground is unknown too.
    if (paint === 'unreadable') return { ground: null, unreadable: value };
    if (paint === 'opaque') {
      ground = toHex(value);
      break;
    }
    layers.push(value);
  }
  if (ground === null) return { ground: null, unreadable: null };
  // Bottom up: the layer nearest the ground is painted first, and folding the
  // other way round produces a different colour rather than an error.
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    ground = composite(layers[index]!, ground);
    // Unreachable: every layer classified `translucent` and the ground is a
    // hex, so `composite` has both halves. Kept as the type's own guard.
    if (ground === null) return { ground: null, unreadable: layers[index]! };
  }
  return { ground, unreadable: null };
}

/**
 * Why a state rule's surface could not be resolved — THREE answers, not one.
 *
 * ⚠️ MOTIR-4342. The single sentence this replaced said *translucent over no
 * opaque ground* whatever had actually happened, and two of the three things it
 * covered were not that. The reason a guard prints IS its output: a reader who
 * is told the ground is missing goes and looks at the asset's stacking, and the
 * answer was in the parser the whole time.
 */
function groundAbstentionReason(
  declaredValue: string,
  resolved: string,
  resting: RestingGround,
): string {
  const head =
    `the state background ${JSON.stringify(declaredValue)} resolved to ` +
    `${JSON.stringify(resolved)}, which `;
  if (classifyPaint(resolved) === 'unreadable') {
    return `${head}this scanner cannot read as a colour`;
  }
  if (resting.unreadable !== null) {
    return (
      `${head}is translucent over an ancestor painting ` +
      `${JSON.stringify(resting.unreadable)}, which this scanner cannot read as a colour`
    );
  }
  return `${head}is translucent over no opaque ground`;
}

/** The two 1.4.3 grants, read exactly as the resting scanner reads them. */
function isExempt(element: El): boolean {
  if (element.closest('[aria-hidden="true"], [disabled], [aria-disabled="true"]')) return true;
  if (element.getAttribute('role') === 'img') return true;
  const hasName = element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby');
  return hasName && !element.textContent?.trim();
}

/** Does this element paint text of its OWN, rather than only containing some? */
function ownsText(element: El): boolean {
  return [...element.childNodes].some(
    (node) => node.nodeType === 3 && (node.textContent ?? '').trim() !== '',
  );
}

/** Which of `STATE_PSEUDO_CLASSES` a selector names, in the order they appear. */
function statesIn(selectorText: string): string[] {
  STATE_PSEUDO_RE.lastIndex = 0;
  return [...new Set([...selectorText.matchAll(STATE_PSEUDO_RE)].map((m) => m[0].slice(1)))];
}

/**
 * The selector with its interaction states removed — the elements that TAKE
 * that paint when the state obtains.
 *
 * ⚠️ This is a rewrite of the SELECTOR, never of the verdict: it answers "which
 * elements can enter this state", which is exactly the containment question the
 * static walk cannot ask. It is safe here because the tree contains no
 * `:not(… :hover …)`, where dropping the pseudo would INVERT the rule rather
 * than widen it; `scanMockStateInk` abstains on such a selector rather than
 * rewriting it, so the check cannot rot if one is written later.
 */
function baseSelector(selectorText: string): string | null {
  if (
    /:not\([^)]*:(?:hover|focus|focus-within|focus-visible|active|checked|target)/.test(
      selectorText,
    )
  ) {
    return null;
  }
  const parts = selectorText
    .split(',')
    .map((part) => part.replace(STATE_PSEUDO_RE, '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** Where an element's ink is WRITTEN — the declarations that produce it. */
interface InkSource {
  /** The selector(s), or `inline style="…"`, as a sweep would go looking for them. */
  where: string;
  /** The declaration VALUES those rules give `color`, e.g. `var(--el-text-muted)`. */
  values: string[];
}

/**
 * Where this element's ink is WRITTEN — the thing a sweep edits, and the thing
 * that says WHICH TOKEN it is.
 *
 * ⚠️ THIS IS NOT A CONVENIENCE FOR THE FAILURE MESSAGE. Reading the token off
 * the DECLARATION is what makes the arm correct, because a resolved colour does
 * not name a token: `--el-text-muted` and `--el-text-secondary` compute to the
 * SAME `#a4a097` inside these assets' nested dark scopes, so an arm that
 * classified ink by comparing hexes reported eleven `--el-text-secondary` rows
 * in `design/settings/*.mock.html` as muted violations — a false positive, and
 * exactly the kind the resting scanner's abstention exists to avoid producing.
 *
 * The ink is also very often INHERITED — `.dash-row .dr-meta { color: … }` with
 * bare `<span>`s under it — so a search restricted to the element itself finds
 * nothing on precisely the sites whose fix is one edit a level up. The walk
 * climbs until it finds a rule that paints this colour, and says how far it went.
 */
function inkSource(window: Window, rules: PaintRule[], element: El, ink: string): InkSource {
  const inline = element.getAttribute('style');
  const inlineColor = inline?.match(/(?:^|[;\s])color\s*:\s*([^;]+)/i);
  if (inlineColor) {
    return { where: `inline style="${inline!.trim()}"`, values: [inlineColor[1]!.trim()] };
  }
  for (let node: El | null = element, depth = 0; node; node = node.parentElement as El | null) {
    const where = new Set<string>();
    const values = new Set<string>();
    for (const rule of rules) {
      if (!rule.color.trim()) continue;
      try {
        if (!node.matches(rule.selectorText)) continue;
      } catch {
        continue;
      }
      if (toHex(resolveAt(window, node, rule.color) ?? '') !== ink) continue;
      where.add(rule.selectorText.replace(/\s+/g, ' '));
      values.add(rule.color.trim());
    }
    if (where.size) {
      const inherited = depth === 0 ? '' : ` (inherited from <${node.tagName.toLowerCase()}>)`;
      return { where: `${[...where].join(' | ')}${inherited}`, values: [...values] };
    }
    depth += 1;
  }
  return { where: '(no rule found — a utility class, or an unattributable colour)', values: [] };
}

/**
 * Rule on ONE mock: every element painting `--el-text-muted` under a surface an
 * interaction-state rule paints, measured at the ratio the engine computed.
 */
export function scanMockStateInk(file: string, html: string): MockStateScan {
  const window = new Window({
    url: 'https://localhost/',
    // The assets' own scripts only clone specimen markup; none declares a
    // token. Skipping them keeps the lane in the seconds it promises — the same
    // setting, for the same reason, as `design-dark-parity.test.ts`.
    settings: { disableJavaScriptEvaluation: true },
  });
  const findings: StateInkFinding[] = [];
  const abstentions: StateInkAbstention[] = [];
  const seen = new Set<unknown>();
  let stateBackgroundRules = 0;
  let attributeBackgroundRules = 0;

  try {
    const { document } = window;
    document.write(stampSourceLines(html));

    const rules = styleRules(document);
    if (rules.length === 0) {
      abstentions.push({
        file,
        stateSelector: '(whole asset)',
        reason: 'the engine parsed no style rule at all — nothing here was ruled on',
      });
    }

    for (const rule of rules) {
      if (!rule.background.trim()) continue;
      if (ATTRIBUTE_SELECTOR_RE.test(rule.selectorText)) attributeBackgroundRules += 1;
      const states = statesIn(rule.selectorText);
      if (states.length === 0) continue;
      stateBackgroundRules += 1;

      const base = baseSelector(rule.selectorText);
      if (base === null) {
        abstentions.push({
          file,
          stateSelector: rule.selectorText,
          reason: 'the state pseudo-class sits inside :not(), where removing it inverts the rule',
        });
        continue;
      }

      let hosts: El[];
      try {
        hosts = [...document.querySelectorAll(base)] as El[];
      } catch {
        abstentions.push({
          file,
          stateSelector: rule.selectorText,
          reason: `the engine could not match the base selector ${JSON.stringify(base)}`,
        });
        continue;
      }

      for (const host of hosts) {
        const declared = resolveAt(window, host, rule.background);
        if (declared === null) {
          abstentions.push({
            file,
            stateSelector: rule.selectorText,
            reason:
              `the state background ${JSON.stringify(rule.background)} names a token that is ` +
              `undefined at this element, so the engine could not resolve it to a colour`,
          });
          continue;
        }
        // `transparent` is not an abstention — it is the rule painting NOTHING,
        // which is a resolved answer and a common one (`.opt.is-disabled:hover
        // { background: transparent }` un-paints a resting tint).
        if (declared === 'transparent' || declared === '') continue;
        const restingGround = restingBackground(window, host);
        const surface = composite(declared, restingGround.ground);
        if (surface === null) {
          abstentions.push({
            file,
            stateSelector: rule.selectorText,
            reason: groundAbstentionReason(rule.background, declared, restingGround),
          });
          continue;
        }

        // Walk the host's subtree. An element painting its OWN opaque
        // background re-grounds everything beneath it, so the state tint does
        // not reach that subtree at all — the same stop the resting arm's
        // surface walk makes, read downwards.
        const stack: El[] = [host];
        while (stack.length) {
          const element = stack.pop()!;
          if (element !== host && ownBackground(window, element)) continue;
          for (const child of element.children) stack.push(child as El);
          if (!ownsText(element) || isExempt(element)) continue;

          const ink = toHex(window.getComputedStyle(element).getPropertyValue('color'));
          if (ink === null) continue;
          const source = inkSource(window, rules, element, ink);
          // The TOKEN is read off the declaration, never off the pixel — see
          // `inkSource`'s header for the false positives the other way round.
          if (!source.values.some((value) => value.includes(MUTED_TOKEN))) continue;
          const ratio = contrast(ink, surface);
          if (ratio >= AA_SMALL_TEXT) continue;
          if (seen.has(element)) continue;
          seen.add(element);

          const resting = restingBackground(window, element).ground;
          findings.push({
            file,
            line: Number(element.getAttribute(LINE_ATTRIBUTE) ?? 0),
            stateSelector: rule.selectorText,
            state: states.join('+'),
            surface,
            surfaceValue: rule.background.trim(),
            ink,
            inkRule: source.where,
            ratio: Number(ratio.toFixed(2)),
            restingSurface: resting,
            restingRatio: resting === null ? null : Number(contrast(ink, resting).toFixed(2)),
            element: element.tagName.toLowerCase(),
            snippet: (element.outerHTML ?? '')
              .replace(new RegExp(`\\s*${LINE_ATTRIBUTE}="\\d+"`, 'g'), '')
              .replace(/\s+/g, ' ')
              .slice(0, 200),
          });
        }
      }
    }
  } finally {
    void window.happyDOM.close();
  }

  findings.sort((a, b) => a.line - b.line);
  return {
    file,
    findings,
    abstentions,
    stateBackgroundRules,
    attributeBackgroundRules,
  };
}

export function formatStateInkFinding(finding: StateInkFinding): string {
  const rest =
    finding.restingRatio === null
      ? 'nothing opaque grounds it at rest'
      : `${finding.restingRatio}:1 on ${finding.restingSurface} at rest`;
  return (
    `${finding.file}:${finding.line} — ${MUTED_TOKEN} (${finding.ink}) is ${finding.ratio}:1 on ` +
    `${finding.surface}, painted by \`${finding.stateSelector} { background: ${finding.surfaceValue} }\` ` +
    `(${rest})\n    ink from: ${finding.inkRule}\n    ${finding.snippet}`
  );
}
