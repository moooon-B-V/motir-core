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
// ── What this rules on, and the two boundaries it declares ──────────────────
// RULED ON: `--el-text-muted`, on text it paints inside an element whose
// background is painted by an INTERACTION-STATE rule, at under 4.5:1. Same ink,
// same threshold and the same two 1.4.3 grants as the resting arm — only the
// surface's provenance differs.
//
// DECLINED, both with their count reported by the spec so neither can outlive
// its reason quietly:
//
//   • ATTRIBUTE selectors (`[data-state='open']`, `[data-theme='dark']`). The
//     resting scanner abstains on these in the same breath as the pseudo-classes,
//     but they are not one population: `:hover` is a STATE a pointer puts an
//     element into, while `[data-theme]` is a SCOPE the document is authored in
//     and `design-dark-parity` already rules on. Ruling on both from one arm
//     would mean deciding, per attribute, which it is — which is a judgement,
//     not a measurement.
//   • Ink that names NO `--el-*` token at all — a raw hex, or a local `:root`
//     alias like `--muted: #787671`. Fifteen assets in this tree are written
//     that way. Such an element can fail the same pairing in the same pixels,
//     but the remedy here is a token SWAP and there is no token to swap: it is
//     outside the token layer, which is the never-invent-a-colour rule's
//     subject, not this arm's. `unTokenisedInkCount` reports the population so
//     the decline cannot outlive it quietly.

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
  /**
   * Elements under a state surface whose ink fails 4.5:1 and names NO `--el-*`
   * token — the second declared boundary. Not a finding here; counted so the
   * class cannot go unnoticed.
   */
  unTokenisedInkCount: number;
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

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function toHex(value: string): string | null {
  const trimmed = value.trim();
  if (HEX_RE.test(trimmed)) return trimmed.toLowerCase();
  const rgb =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(trimmed);
  if (!rgb) return null;
  if (rgb[4] !== undefined && alphaOf(rgb[4]) < 1) return null;
  const channel = (raw: string) => Math.round(Number(raw)).toString(16).padStart(2, '0').slice(-2);
  return `#${channel(rgb[1]!)}${channel(rgb[2]!)}${channel(rgb[3]!)}`;
}

function alphaOf(raw: string): number {
  return raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
}

/**
 * Composite a possibly-translucent colour over an opaque ground, or return it
 * unchanged when it is already opaque.
 *
 * A hover tint written `rgba(0, 0, 0, 0.08)` paints REAL pixels, and declining
 * to measure it because it carries an alpha would be an abstention with no
 * warrant — the ground under it is knowable, and where it is not this returns
 * null and the site is named rather than passed.
 */
function composite(value: string, ground: string | null): string | null {
  const opaque = toHex(value);
  if (opaque) return opaque;
  const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*[,/]\s*([\d.]+%?)\s*\)$/i.exec(
    value.trim(),
  );
  if (!rgba || !ground) return null;
  const alpha = alphaOf(rgba[4]!);
  if (alpha <= 0) return null;
  const base = ground.replace('#', '');
  const full =
    base.length === 3
      ? base
          .split('')
          .map((c) => c + c)
          .join('')
      : base;
  const mix = (index: number) => {
    const over = Number(rgba[index + 1]!);
    const under = parseInt(full.slice(index * 2, index * 2 + 2), 16);
    return Math.round(over * alpha + under * (1 - alpha))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${mix(0)}${mix(1)}${mix(2)}`;
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
  const wrapper = window.document.createElement('span');
  wrapper.setAttribute('style', `color: ${SENTINEL}`);
  const probe = window.document.createElement('span');
  probe.setAttribute('style', `color: ${value}`);
  wrapper.appendChild(probe);
  host.appendChild(wrapper);
  const resolved = window.getComputedStyle(probe).getPropertyValue('color').trim();
  wrapper.remove();
  // The sentinel showing through means the declaration was invalid at computed
  // value time — an undefined token — and NOT that the site paints magenta.
  return toHex(resolved) === SENTINEL ? null : resolved;
}

/** The element's own painted background, or null when it paints none. */
function ownBackground(window: Window, element: El): string | null {
  const value = window.getComputedStyle(element).getPropertyValue('background-color').trim();
  if (!value || value === 'transparent') return null;
  return toHex(value);
}

/** The opaque surface an element sits on at REST — the nearest painted ancestor. */
function restingBackground(window: Window, element: El): string | null {
  for (let node: El | null = element; node; node = node.parentElement as El | null) {
    const own = ownBackground(window, node);
    if (own) return own;
  }
  return null;
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
  let unTokenisedInkCount = 0;

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
        const surface = composite(declared, restingBackground(window, host));
        if (surface === null) {
          abstentions.push({
            file,
            stateSelector: rule.selectorText,
            reason:
              `the state background ${JSON.stringify(rule.background)} resolved to ` +
              `${JSON.stringify(declared)}, which is translucent over no opaque ground`,
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
          if (!source.values.some((value) => value.includes(MUTED_TOKEN))) {
            // Ink that names no `--el-*` token at all is the second declared
            // boundary: it can fail the same pairing in the same pixels, and
            // the remedy here is a token SWAP with no token to swap.
            if (
              contrast(ink, surface) < AA_SMALL_TEXT &&
              !source.values.some((value) => value.includes('--el-'))
            ) {
              unTokenisedInkCount += 1;
            }
            continue;
          }
          const ratio = contrast(ink, surface);
          if (ratio >= AA_SMALL_TEXT) continue;
          if (seen.has(element)) continue;
          seen.add(element);

          const resting = restingBackground(window, element);
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
    unTokenisedInkCount,
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
