import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// MOTIR-1278 · 1266.7 — a small CSS cascade model for the three-axis token
// layer, shared by the coverage / swap-layer suites.
//
// WHY a model instead of a rendered browser: the assertion these suites need is
// "what concrete colour does `--el-x` have under palette P, theme T" for 194
// tokens x 20 contexts. jsdom/happy-dom resolve neither `var()` chains nor the
// attribute-selector cascade, and a Playwright pass would gate a pure-CSS
// contract behind the E2E lane. So we model exactly the part of CSS the token
// layer uses — flat declaration blocks on the ROOT element, selected by
// `:root` / `[data-*='v']` — and resolve `var()` ourselves.
//
// The model deliberately does NOT understand descendant/child combinators or
// class selectors: any rule carrying one is component-scoped (`[data-style='glass']
// .card`), not part of the root token layer, and is skipped. That is also what
// keeps the model honest — it can only "see" the layer it claims to check.

/** The `data-*` axis state of the root element for one resolution context. */
export interface ThemeContext {
  /** `data-palette` value. `motir` is the base and ships no override block. */
  palette: string;
  /**
   * `light` means the attribute is ABSENT — light is the implicit `@theme`
   * base and `<html>` omits `data-theme` (theme.css documents this at the
   * `[data-theme='light']` re-assertion block, which exists only so a NESTED
   * subtree can force light back on).
   */
  theme: 'light' | 'dark';
}

interface Rule {
  /** Comma-separated selector list, comments already stripped. */
  selectors: string[];
  declarations: Record<string, string>;
  /** Source order — the tiebreaker between equal-specificity rules. */
  order: number;
}

const CUSTOM_PROPERTY = /(--[\w-]+)\s*:\s*([^;]+)/g;
/** A root-level simple selector the token layer is allowed to use. */
const ROOT_SIMPLE = /^(?::root|html|\[[\w-]+(?:=(?:'[^']*'|"[^"]*"))?\])+$/;
const ATTR_CONDITION = /\[([\w-]+)(?:=['"]([^'"]*)['"])?\]/g;

function parseDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(CUSTOM_PROPERTY)) {
    if (name === undefined || value === undefined) continue;
    out[name] = value.trim();
  }
  return out;
}

/**
 * Split the stylesheet into top-level rules. Nested at-rules (`@media`,
 * `@keyframes`) are skipped wholesale — the root token layer never declares a
 * custom property inside one, and treating their inner blocks as top-level
 * rules would invent declarations that do not apply unconditionally.
 */
function parseRules(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let i = 0;
  let order = 0;
  while (i < stripped.length) {
    const open = stripped.indexOf('{', i);
    if (open === -1) break;
    // Statement at-rules (`@import …;`, `@custom-variant …;`) carry no block, so
    // they sit inside this prelude and would otherwise disqualify the rule that
    // follows — which is how the `@theme` Tier-0 layer goes missing. Everything
    // up to the last `;` is a completed statement; the selector is what remains.
    const raw = stripped.slice(i, open);
    const prelude = raw.slice(raw.lastIndexOf(';') + 1).trim();
    // Walk to the matching close brace so a nested block cannot end the rule early.
    let depth = 0;
    let close = open;
    for (; close < stripped.length; close += 1) {
      if (stripped[close] === '{') depth += 1;
      else if (stripped[close] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = stripped.slice(open + 1, close);
    if (prelude === '@theme' || !prelude.startsWith('@')) {
      rules.push({
        // `@theme` emits its custom properties onto `:root` — Tailwind v4's
        // documented behaviour, and what makes it the Tier-0 base layer here.
        selectors: prelude === '@theme' ? [':root'] : prelude.split(',').map((s) => s.trim()),
        declarations: parseDeclarations(body),
        order: order++,
      });
    }
    i = close + 1;
  }
  return rules;
}

/** CSS specificity of a root-level selector, as the (b, c) pair that can vary here. */
function specificity(selector: string): [number, number] {
  const attributes = selector.match(/\[[^\]]*\]/g)?.length ?? 0;
  const pseudoClasses = selector.match(/:root/g)?.length ?? 0;
  const types = selector.match(/(^|\])html/g)?.length ?? 0;
  return [attributes + pseudoClasses, types];
}

/** Does this single (non-list) selector match the root element in `ctx`? */
function matchesContext(selector: string, ctx: ThemeContext): boolean {
  const trimmed = selector.trim();
  if (!ROOT_SIMPLE.test(trimmed)) return false; // combinator / class → component-scoped
  for (const [, attribute, value] of trimmed.matchAll(ATTR_CONDITION)) {
    switch (attribute) {
      case 'data-theme':
        // light == the attribute is absent, so ONLY a dark context matches.
        if (ctx.theme !== 'dark' || value !== 'dark') return false;
        break;
      case 'data-palette':
        if (value !== ctx.palette) return false;
        break;
      case 'data-appearance-scope':
        break; // re-emits the same layer onto a subtree; same declarations
      default:
        // data-style / data-type / data-surface — unset in these contexts.
        return false;
    }
  }
  return true;
}

/** The declared (still possibly `var()`-valued) custom properties for a context. */
export function declaredIn(rules: Rule[], ctx: ThemeContext): Record<string, string> {
  const applicable = rules
    .flatMap((rule) =>
      rule.selectors
        .filter((selector) => matchesContext(selector, ctx))
        .map((selector) => ({ rule, specificity: specificity(selector) })),
    )
    .sort((a, b) => {
      if (a.specificity[0] !== b.specificity[0]) return a.specificity[0] - b.specificity[0];
      if (a.specificity[1] !== b.specificity[1]) return a.specificity[1] - b.specificity[1];
      return a.rule.order - b.rule.order;
    });
  const out: Record<string, string> = {};
  for (const { rule } of applicable) Object.assign(out, rule.declarations);
  return out;
}

/**
 * Expand every `var(--x)` in `value` against `declarations`. Returns the
 * concrete value plus the names that could not be resolved — an unresolved name
 * is the swap-layer break these suites exist to catch.
 */
export function resolveValue(
  value: string,
  declarations: Record<string, string>,
): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  let current = value;
  for (let depth = 0; depth < 16 && current.includes('var('); depth += 1) {
    current = current.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_m, name, fallback) => {
      const next = declarations[name];
      if (next !== undefined) return next;
      if (fallback !== undefined) return fallback.trim();
      unresolved.push(name);
      return '';
    });
  }
  return { value: current.trim().replace(/\s+/g, ' '), unresolved };
}

/** The parsed token layer: motir-core's globals.css plus the design-system sheet. */
export function loadTokenLayer(): {
  css: string;
  rules: Rule[];
  /** The Tier-3 base block — the ONLY place an `--el-*` token is declared. */
  baseBlock: Record<string, string>;
  /** Every `--el-*` token name the Tier-3 base declares. */
  elementTokens: string[];
  /** Declarations of one `[data-palette='<id>']` block, by palette then theme. */
  paletteBlock: (palette: string, theme: 'light' | 'dark') => Record<string, string>;
} {
  const css =
    readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8') +
    readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8');
  const rules = parseRules(css);

  const base = rules.find((rule) => rule.selectors.includes('[data-appearance-scope]'));
  if (!base) throw new Error('Tier-3 base block (`:root, [data-appearance-scope]`) not found');

  const paletteBlock = (palette: string, theme: 'light' | 'dark') => {
    const wanted =
      theme === 'dark'
        ? `[data-palette='${palette}'][data-theme='dark']`
        : `[data-palette='${palette}']`;
    const rule = rules.find((r) => r.selectors.some((s) => s.trim() === wanted));
    return rule?.declarations ?? {};
  };

  return {
    css,
    rules,
    baseBlock: base.declarations,
    elementTokens: Object.keys(base.declarations).filter((name) => name.startsWith('--el-')),
    paletteBlock,
  };
}

/** Fully-resolved value of one `--el-*` token in one context. */
export function resolveToken(
  rules: Rule[],
  ctx: ThemeContext,
  token: string,
): { value: string; unresolved: string[] } {
  const declarations = declaredIn(rules, ctx);
  const declared = declarations[token];
  if (declared === undefined) return { value: '', unresolved: [token] };
  return resolveValue(declared, declarations);
}

// ── Nested subtrees (MOTIR-2077) ────────────────────────────────────────────
// The context model above resolves ONE element — the root — so it cannot express
// the case `[data-theme='light']`, `[data-palette]` and `[data-appearance-scope]`
// exist for: a NESTED element that re-skins its own subtree while <html> keeps a
// different theme. That needs the part of CSS the root model can skip:
// INHERITANCE. A custom property not declared on the element inherits its
// already-COMPUTED value from the parent, and `var()` substitutes at the element
// where the property is declared — which is exactly why re-declaring Tier-0
// `--color-*` on a nested element moves nothing on its own, and why
// `[data-appearance-scope]` (which re-emits the whole Tier-3 `--el-*` layer onto
// that element) is what makes a scoped subtree work.

/**
 * The `data-*` attributes literally present on ONE element. A valueless
 * attribute (`data-appearance-scope`) is spelled with an empty string.
 *
 * Note this is LITERAL, unlike `ThemeContext`: on the root, light means no
 * `data-theme` key at all, but on a nested scope `data-theme='light'` is really
 * there — that asymmetry is the whole point of the light re-assertion block.
 */
export type ElementAttributes = Record<string, string>;

/** Root-first chain of elements, `[<html>, …, the element being resolved]`. */
export type ScopeChain = ElementAttributes[];

const ROOT_ONLY = /:root|(?:^|\])html/;

/** Does this single (non-list) selector match an element with `attributes`? */
function matchesElement(selector: string, attributes: ElementAttributes, isRoot: boolean): boolean {
  const trimmed = selector.trim();
  if (!ROOT_SIMPLE.test(trimmed)) return false; // combinator / class → component-scoped
  if (ROOT_ONLY.test(trimmed) && !isRoot) return false;
  for (const [, attribute, value] of trimmed.matchAll(ATTR_CONDITION)) {
    if (attribute === undefined) return false;
    const present = attributes[attribute];
    if (present === undefined) return false; // `[attr]` and `[attr='v']` both need it
    if (value !== undefined && present !== value) return false;
  }
  return true;
}

/** The declarations one element in the chain carries, in cascade order. */
function declarationsAtLevel(rules: Rule[], chain: ScopeChain, level: number) {
  const attributes = chain[level] ?? {};
  const applicable = rules
    .flatMap((rule) =>
      rule.selectors
        .filter((selector) => matchesElement(selector, attributes, level === 0))
        .map((selector) => ({ rule, specificity: specificity(selector) })),
    )
    .sort((a, b) => {
      if (a.specificity[0] !== b.specificity[0]) return a.specificity[0] - b.specificity[0];
      if (a.specificity[1] !== b.specificity[1]) return a.specificity[1] - b.specificity[1];
      return a.rule.order - b.rule.order;
    });
  const out: Record<string, string> = {};
  for (const { rule } of applicable) Object.assign(out, rule.declarations);
  return out;
}

/**
 * Fully-resolved value of one custom property on the LAST element of `chain`,
 * with real inheritance: a property the element declares resolves its `var()`s
 * against the values computed AT THAT ELEMENT; one it does not declare inherits
 * the parent's already-computed value.
 */
export function resolveTokenInScope(
  rules: Rule[],
  chain: ScopeChain,
  token: string,
): { value: string; unresolved: string[] } {
  const declarations = chain.map((_, level) => declarationsAtLevel(rules, chain, level));
  const unresolved: string[] = [];

  const computed = (level: number, name: string, depth: number): string | undefined => {
    if (level < 0 || depth > 16) return undefined;
    const raw = declarations[level]?.[name];
    if (raw === undefined) return computed(level - 1, name, depth);
    return raw
      .replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_m, referenced, fallback) => {
        const value = computed(level, referenced, depth + 1);
        if (value !== undefined) return value;
        if (fallback !== undefined) return fallback.trim();
        unresolved.push(referenced);
        return '';
      })
      .trim();
  };

  const value = computed(chain.length - 1, token, 0);
  if (value === undefined) return { value: '', unresolved: [token] };
  return { value: value.trim().replace(/\s+/g, ' '), unresolved };
}
