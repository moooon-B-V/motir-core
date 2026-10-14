// pruneUnmatchedRules — drop the style rules a rendered mock can never match
// (MOTIR-8565).
//
// `renderMock` compiles Tailwind over the markup with `theme.css` as input.
// Tailwind writes a UTILITY only for a class the markup carries, but it copies
// every plain rule of the input stylesheet through whole — so a component-scoped
// rule such as `.style-vignette[data-style='aurora'] > .sv-canvas { … }` lands
// in every mock, including the ones that render no `StyleVignette` at all.
// A rule nothing matches is not harmless in a design asset: it is a measure a
// reader can lift off the stylesheet and call "the value the asset draws"
// (MOTIR-4150), and motir-core's design guard fails a mock that declares one
// (`tests/design-mock-utility-correspondence.test.ts`, direction (B)).
//
// ⚠️ IT ONLY EVER DROPS A RULE THAT CANNOT MATCH. A rule goes when EVERY
// selector in its list needs a class the markup does not carry. "Needs" is read
// conservatively, so a doubtful rule stays:
//   • a class inside a functional pseudo-class — `:not(.fixed)`,
//     `:is(.border-b, .border-t)`, `:where(.group):hover *` — is NOT needed:
//     `:not` matches when the class is absent and `:is` with one present member;
//   • an attribute selector's value is not read as a class (`[data-x='a.b']`);
//   • a rule nested inside another style rule is kept or dropped with its parent;
//   • `@layer utilities` is left alone — Tailwind wrote every rule in it from the
//     markup's own candidates — and so are `@keyframes`, `@font-face`,
//     `@property` and every other at-rule that holds no style rules.

/** One parsed node: a block (`prelude { … }`) or a statement (`@import …;`, a declaration). */
type CssNode =
  | { kind: 'block'; prelude: string; children: CssNode[]; raw: string }
  | { kind: 'text'; raw: string };

/** At-rules whose blocks hold style rules — the only ones the pruner walks into. */
const GROUPING_AT_RULES = /^@(?:media|supports|layer|container|scope|document)\b/i;

/** Split CSS into top-level nodes, recursing into every block. Strings, comments and escapes are respected. */
function parse(css: string): CssNode[] {
  let i = 0;

  function readNodes(untilClose: boolean): CssNode[] {
    const nodes: CssNode[] = [];
    let start = i;
    let buffer = '';
    while (i < css.length) {
      const ch = css[i]!;
      if (ch === '\\') {
        buffer += css.slice(i, i + 2);
        i += 2;
      } else if (ch === '"' || ch === "'") {
        const end = closingQuote(css, i);
        buffer += css.slice(i, end + 1);
        i = end + 1;
      } else if (ch === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2);
        const stop = end === -1 ? css.length : end + 2;
        buffer += css.slice(i, stop);
        i = stop;
      } else if (ch === '{') {
        const prelude = buffer;
        i += 1;
        const children = readNodes(true);
        nodes.push({ kind: 'block', prelude, children, raw: css.slice(start, i) });
        start = i;
        buffer = '';
      } else if (ch === '}') {
        if (untilClose) {
          if (i > start) nodes.push({ kind: 'text', raw: css.slice(start, i) });
          i += 1;
          return nodes;
        }
        // A stray `}` at the top level: keep it verbatim rather than lose bytes.
        i += 1;
        buffer += ch;
      } else if (ch === ';') {
        i += 1;
        nodes.push({ kind: 'text', raw: css.slice(start, i) });
        start = i;
        buffer = '';
      } else {
        buffer += ch;
        i += 1;
      }
    }
    if (css.slice(start).length) nodes.push({ kind: 'text', raw: css.slice(start) });
    return nodes;
  }

  return readNodes(false);
}

/** The index of the quote that closes the string opening at `open`. */
function closingQuote(text: string, open: number): number {
  const quote = text[open];
  let i = open + 1;
  while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
  return Math.min(i, text.length - 1);
}

/** Split a selector list on its top-level commas. */
function splitSelectorList(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < prelude.length; i += 1) {
    const ch = prelude[i]!;
    if (ch === '\\') {
      current += prelude.slice(i, i + 2);
      i += 1;
    } else if (ch === '"' || ch === "'") {
      const end = closingQuote(prelude, i);
      current += prelude.slice(i, end + 1);
      i = end;
    } else {
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        out.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  out.push(current);
  return out;
}

/** CSS identifier un-escaping: `\(` → `(`, `\:` → `:`, `\32 xl` → `2xl`. */
export function unescapeCssIdent(ident: string): string {
  return ident.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|([\s\S]))/g,
    (_, hex?: string, char?: string) =>
      hex !== undefined ? String.fromCodePoint(Number.parseInt(hex, 16)) : char!,
  );
}

/**
 * The classes ONE complex selector cannot match without — every `.class` outside
 * a parenthesised group (a functional pseudo-class's argument) and outside an
 * attribute selector. Exported for its own test only.
 */
export function requiredClasses(selector: string): string[] {
  const classes: string[] = [];
  let depth = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i]!;
    if (ch === '\\') {
      i += 1;
    } else if (ch === '"' || ch === "'") {
      i = closingQuote(selector, i);
    } else if (ch === '(' || ch === '[') {
      depth += 1;
    } else if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
    } else if (ch === '.' && depth === 0) {
      let j = i + 1;
      let ident = '';
      while (j < selector.length) {
        const c = selector[j]!;
        if (c === '\\') {
          // An escape: a hex run plus one optional whitespace, or one literal character.
          const hex = /^\\[0-9a-fA-F]{1,6}[ \t\n]?/.exec(selector.slice(j));
          const step = hex ? hex[0].length : 2;
          ident += selector.slice(j, j + step);
          j += step;
        } else if (/[-_a-zA-Z0-9\u0080-￿]/.test(c)) {
          ident += c;
          j += 1;
        } else break;
      }
      if (ident) classes.push(unescapeCssIdent(ident));
      i = j - 1;
    }
  }
  return classes;
}

/** True when no selector in the rule's list can match markup carrying only `carried`. */
function cannotMatch(prelude: string, carried: ReadonlySet<string>): boolean {
  const selectors = splitSelectorList(prelude.replace(/\/\*[\s\S]*?\*\//g, ' '));
  return selectors.every((selector) =>
    requiredClasses(selector).some((name) => !carried.has(name)),
  );
}

function prune(nodes: CssNode[], carried: ReadonlySet<string>): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.raw;
      continue;
    }
    const prelude = node.prelude.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    if (prelude.startsWith('@')) {
      // Walk only the grouping at-rules, and never `@layer utilities`.
      if (GROUPING_AT_RULES.test(prelude) && !/^@layer\s+utilities\s*$/i.test(prelude)) {
        const inner = prune(node.children, carried);
        // A group the prune emptied goes with its rules; one that was empty already stays.
        if (inner.trim() === '' && node.children.some((child) => child.raw.trim() !== '')) continue;
        out += `${node.prelude}{${inner}}`;
      } else {
        out += node.raw;
      }
    } else if (!cannotMatch(prelude, carried)) {
      out += node.raw;
    }
  }
  return out;
}

/**
 * The compiled stylesheet minus every style rule no element of the markup can
 * match, given the classes the markup carries. A stylesheet with nothing to drop
 * comes back byte-identical.
 */
export function pruneUnmatchedRules(css: string, carried: Iterable<string>): string {
  return prune(parse(css), new Set(carried));
}
