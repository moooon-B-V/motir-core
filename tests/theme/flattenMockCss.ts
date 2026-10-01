// MOTIR-7179 — the design lane's CSS READER, flattened to what happy-dom parses.
//
// ── The defect this closes ──────────────────────────────────────────────────
// `@motir/design-system`'s `renderMock` (MOTIR-6961) compiles a mock with
// Tailwind v4's own `compile()`, and that output is modern CSS: cascade layers
// (`@layer theme, base, components, utilities`), and CSS NESTING inside style
// rules — `&:hover { @media (hover: hover) { … } }` for every state variant and
// `@supports (color: color-mix(…)) { … }` for every colour fallback. happy-dom
// 20.9, the engine both rendering guards (`mockStateInkScan`,
// `design-dark-parity`) ask what a mock COMPUTED, parses neither:
//
//   1. Every rule inside an `@layer { … }` block is DROPPED — no
//      `CSSLayerBlockRule`, no child rules, and nothing reaches the cascade.
//   2. A style rule holding ANY nested rule loses the declarations BEFORE it,
//      and the nested rule itself: `.c { color: red; &:hover { color: blue } }`
//      parses as `.c { }`.
//
// So a mock rendered the sanctioned way read as ZERO style rules: the state
// guard abstained on the whole asset, and the dark-parity check found every
// token unset. Each author who hit it hand-unwrapped the generated CSS — a
// different edit every time, and one that deleted the very rules the guards
// exist to measure.
//
// ── What this does, and what it deliberately leaves alone ───────────────────
// It rewrites the text of every `<style>` element before the engine sees it,
// into the subset happy-dom DOES parse, preserving what the cascade means:
//
//   • NESTING is lowered. A nested style rule's selector is resolved against
//     its parent's (`&` substituted; no `&` ⇒ a descendant), and a nested
//     at-rule (`@media`, `@supports`, `@container`, …) becomes a top-level
//     group wrapping the PARENT's selector. Declarations keep their SOURCE
//     ORDER: a run of declarations after a nested block is emitted after that
//     block, so `color: red; @supports (…) { color: blue }` still ends blue
//     where the condition holds.
//   • LAYERS are unwrapped, and their PRIORITY is kept the way flat CSS can
//     express it — by order. Layered content is emitted layer by layer in the
//     order the layers were first named (`@layer a, b;` statements included),
//     and every unlayered rule after all of them, because unlayered beats
//     layered. ⚠️ ONE residual divergence, stated rather than hidden: in a real
//     engine layer order beats SPECIFICITY, and here specificity still decides
//     between a layered and an unlayered rule that both match. Tailwind's own
//     output does not depend on that (its utilities are single classes and its
//     base rules are element selectors), and a mock that did would need a real
//     browser to rule on it anyway.
//   • Everything happy-dom already parses is passed through as it was
//     written: `@scope` (lower bound included — probed), top-level `@media` /
//     `@supports`, `@keyframes`, `@font-face`, `@property`.
//
// A sheet this cannot parse — unbalanced braces, an unterminated string or
// comment — is returned UNCHANGED, so the reader can never be worse than the
// engine on its own.

type Node =
  | { kind: 'decl'; text: string }
  | { kind: 'statement'; text: string }
  | { kind: 'block'; prelude: string; body: string; children: Node[] | null };

/** Grouping at-rules: their body is rules (or, nested in a style rule, a rule body). */
const GROUPING = new Set(['media', 'supports', 'container', 'scope', 'document', 'starting-style']);

class Unparseable extends Error {}

/**
 * Index of the first `stop` character at nesting depth 0 from `from`, skipping
 * comments, strings, escapes and anything inside `()` / `[]` — or -1.
 */
function scan(css: string, from: number, stops: string): number {
  let depth = 0;
  for (let i = from; i < css.length; i += 1) {
    const ch = css[i]!;
    if (ch === '\\') {
      i += 1;
    } else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) throw new Unparseable('unterminated comment');
      i = end + 1;
    } else if (ch === '"' || ch === "'") {
      i = skipString(css, i);
    } else if (ch === '(' || ch === '[') {
      depth += 1;
    } else if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && stops.includes(ch)) {
      return i;
    }
  }
  return -1;
}

function skipString(css: string, start: number): number {
  const quote = css[start];
  for (let i = start + 1; i < css.length; i += 1) {
    if (css[i] === '\\') i += 1;
    else if (css[i] === quote) return i;
  }
  throw new Unparseable('unterminated string');
}

/** The index of the `}` closing the block whose `{` is at `open`. */
function closeOf(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const ch = css[i]!;
    if (ch === '\\') i += 1;
    else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) throw new Unparseable('unterminated comment');
      i = end + 1;
    } else if (ch === '"' || ch === "'") i = skipString(css, i);
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Unparseable('unbalanced braces');
}

const stripComments = (text: string) => {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\') {
      out += ch + (text[i + 1] ?? '');
      i += 1;
    } else if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      out += text.slice(i, end + 1);
      i = end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Unparseable('unterminated comment');
      i = end + 1;
    } else out += ch;
  }
  return out;
};

/** Parse a list of declarations, statements and blocks. */
function parse(css: string): Node[] {
  const nodes: Node[] = [];
  let i = 0;
  while (i < css.length) {
    const stop = scan(css, i, ';{}');
    if (stop === -1) {
      const tail = stripComments(css.slice(i)).trim();
      if (tail) nodes.push({ kind: 'decl', text: tail });
      break;
    }
    if (css[stop] === '}') throw new Unparseable('stray closing brace');
    const head = stripComments(css.slice(i, stop)).trim();
    if (css[stop] === ';') {
      if (head) nodes.push({ kind: head.startsWith('@') ? 'statement' : 'decl', text: head });
      i = stop + 1;
      continue;
    }
    const close = closeOf(css, stop);
    const body = css.slice(stop + 1, close);
    const name = atName(head);
    // Only bodies that can hold rules are parsed; `@keyframes`, `@font-face`,
    // `@property` and friends are passed through verbatim.
    const parsed = name === null || name === 'layer' || GROUPING.has(name);
    nodes.push({ kind: 'block', prelude: head, body, children: parsed ? parse(body) : null });
    i = close + 1;
  }
  return nodes;
}

function atName(prelude: string): string | null {
  const match = /^@([-a-zA-Z]+)/.exec(prelude);
  return match ? match[1]!.toLowerCase() : null;
}

/** Split a selector list on its top-level commas (escaped commas are part of a class). */
function splitList(selector: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const comma = scan(selector, from, ',');
    if (comma === -1) break;
    parts.push(selector.slice(from, comma).trim());
    from = comma + 1;
  }
  parts.push(selector.slice(from).trim());
  return parts.filter(Boolean);
}

/** Replace every unescaped `&` outside strings with `parent`. */
function substituteNesting(selector: string, parent: string): string | null {
  let out = '';
  let found = false;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i]!;
    if (ch === '\\') {
      out += ch + (selector[i + 1] ?? '');
      i += 1;
    } else if (ch === '"' || ch === "'") {
      const end = skipString(selector, i);
      out += selector.slice(i, end + 1);
      i = end;
    } else if (ch === '&') {
      out += parent;
      found = true;
    } else out += ch;
  }
  return found ? out : null;
}

/**
 * A nested selector resolved against its parent's list — the cross product, so
 * no `:is()` is needed for a simple parent. A COMPLEX parent (one carrying a
 * combinator) is wrapped in `:is()` so `.x &` keeps meaning "a match of the
 * parent inside `.x`" rather than requiring `.x` above the parent's own chain.
 */
function resolveSelectors(prelude: string, parents: string[] | null): string[] {
  const own = splitList(prelude);
  if (!parents) return own;
  const out: string[] = [];
  for (const parent of parents) {
    const simple = scan(parent, 0, ' >+~\t\n') === -1;
    const p = simple ? parent : `:is(${parent})`;
    for (const child of own) {
      const substituted = substituteNesting(child, p);
      // No `&`: a descendant — which also reads a leading combinator
      // (`> .x`) right, since `p > .x` is what it means.
      out.push(substituted ?? `${p} ${child}`);
    }
  }
  return out;
}

/**
 * Emit a list of nodes as flat CSS. `selectors` is the enclosing style rule's
 * resolved list — non-null inside a style rule's body, where a declaration
 * belongs to it and a nested at-rule wraps it.
 */
function emit(nodes: Node[], selectors: string[] | null, layers: Layers | null): string {
  let out = '';
  let run: string[] = [];
  const flush = () => {
    if (run.length && selectors) out += `${selectors.join(', ')} { ${run.join('; ')}; }\n`;
    run = [];
  };
  for (const node of nodes) {
    if (node.kind === 'decl') {
      run.push(node.text);
      continue;
    }
    flush();
    if (node.kind === 'statement') {
      // `@layer a, b;` declares an ORDER and nothing else; it is recorded, not emitted.
      if (atName(node.text) === 'layer') layers?.declare(node.text.slice('@layer'.length));
      // `@import` / `@charset` / `@namespace` are only valid before every rule,
      // so at the top level they are hoisted ahead of the re-ordered layers.
      else if (layers && !selectors) layers.statements += `${node.text};\n`;
      else out += `${node.text};\n`;
      continue;
    }
    const name = atName(node.prelude);
    if (name === null) {
      out += emit(node.children ?? [], resolveSelectors(node.prelude, selectors), null);
    } else if (name === 'layer') {
      const inner = emit(node.children ?? [], selectors, null);
      // Only a TOP-LEVEL layer is re-ordered; one nested in a group or another
      // layer is unwrapped where it stands.
      if (layers && !selectors) layers.add(node.prelude.slice('@layer'.length), inner);
      else out += inner;
    } else if (node.children) {
      out += `${node.prelude} {\n${emit(node.children, selectors, null)}}\n`;
    } else {
      out += `${node.prelude} {${node.body}}\n`;
    }
  }
  flush();
  return out;
}

/** Layered content, held by layer and emitted in declaration order. */
class Layers {
  statements = '';
  private order: string[] = [];
  private content = new Map<string, string>();
  private anonymous = 0;

  declare(names: string) {
    for (const name of names.split(',').map((n) => n.trim()))
      if (name && !this.order.includes(name)) this.order.push(name);
  }

  add(name: string, css: string) {
    const key = name.trim() || `\u0000anonymous-${(this.anonymous += 1)}`;
    this.declare(key);
    this.content.set(key, (this.content.get(key) ?? '') + css);
  }

  /** The hoisted statements, then every layer's content in declaration order. */
  css(): string {
    return this.statements + this.order.map((name) => this.content.get(name) ?? '').join('');
  }
}

/** The properties a PAINT reader reads: ink, ground, and the tokens both resolve through. */
const PAINT_PROPERTY = /^(?:--[\w-]+|color|background|background-color)$/i;

/**
 * Drop every declaration that cannot change what a paint reader computes, and
 * so every rule left with none.
 *
 * ⚠️ THIS IS THE LANE'S BUDGET, MEASURED (MOTIR-7179). happy-dom re-parses each
 * rule's selector text on every `matches()` inside `getComputedStyle`, caching
 * nothing — profiled on `design/shell/context-row.mock.html`, 65% of the state
 * arm's time was `SelectorParser.getSelectorGroups`. A compiled Tailwind sheet
 * is mostly LAYOUT utilities (`flex`, `gap-2`, `px-3`, …), which no colour the
 * guards read depends on, and flattening is what put them all in front of the
 * engine. Inheritance of `color` and `var()` resolution need only the three
 * properties and the custom properties kept here.
 *
 * A LOSSY reading, deliberately: a guard that reads LAYOUT through this reader
 * must not pass `paintOnly`.
 */
function prunePaint(nodes: Node[]): Node[] {
  const out: Node[] = [];
  for (const node of nodes) {
    if (node.kind === 'decl') {
      const property = node.text.slice(0, node.text.indexOf(':')).trim();
      if (PAINT_PROPERTY.test(property)) out.push(node);
    } else if (node.kind === 'block' && node.children) {
      out.push({ ...node, children: prunePaint(node.children) });
    } else {
      out.push(node);
    }
  }
  return out;
}

export interface FlattenOptions {
  /** Keep only paint declarations — see `prunePaint`. For readers of colour only. */
  paintOnly?: boolean;
}

/** Flatten one stylesheet's text. Unparseable input comes back unchanged. */
export function flattenCss(css: string, options: FlattenOptions = {}): string {
  try {
    const layers = new Layers();
    const tree = parse(css);
    const unlayered = emit(options.paintOnly ? prunePaint(tree) : tree, null, layers);
    return layers.css() + unlayered;
  } catch (error) {
    if (error instanceof Unparseable) return css;
    throw error;
  }
}

/**
 * Flatten the text of every `<style>` element in a document, leaving the markup
 * alone. HTML comments are matched FIRST and passed through: an asset's header
 * comment that merely mentions "the <style> below" would otherwise open a match
 * inside the comment and swallow its `-->` (`design/brand/brand-mark.mock.html`).
 */
export function flattenMockCss(html: string, options: FlattenOptions = {}): string {
  return html.replace(
    /<!--[\s\S]*?-->|(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
    (match: string, open?: string, css?: string, close?: string) =>
      open === undefined ? match : `${open}${flattenCss(css!, options)}${close}`,
  );
}
