import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'tailwindcss';

// MOTIR-5459 — what a class list ACTUALLY resolves to, read off the stylesheet
// `app/globals.css` really compiles to.
//
// ── Why the class names are not the answer ─────────────────────────────────
// Two utilities on one element that both set a property do not resolve in the
// order the `className` lists them. They resolve in the order Tailwind EMITS
// them, and that order is Tailwind's own sort. `line-clamp-2 block` reads as
// "clamp, then make it block-level"; the compiled sheet says:
//
//   .line-clamp-2 { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
//   .block        { display: block; }
//
// `.block` comes second, so it wins `display`, and `-webkit-line-clamp` does
// nothing on a box that is not a `-webkit-box`. A test asserting the class is
// PRESENT passes on exactly that element.
//
// happy-dom applies no Tailwind stylesheet, so `getComputedStyle` cannot answer
// this either. The cascade is fully determined by the compiled sheet, though, so
// it is folded here: every utility's own declarations, in emission order, last
// write wins — the same arithmetic a browser runs on the same input.
//
// Same compile door as `tests/theme/maxWidthResolution.test.ts`. This module
// reads single files only and walks no tree, so importing it does not make a
// spec a whole-tree scanner (`tests/helpers/structuralGuardLane.ts`).

export const REPO = resolve(__dirname, '..', '..');

export interface UtilityCompiler {
  build(candidates: string[]): string;
}

/** Resolve an `@import` the way the app's bundler does. */
async function loadStylesheet(id: string, base: string) {
  const path = id.startsWith('.')
    ? resolve(base, id)
    : id === 'tailwindcss'
      ? join(REPO, 'node_modules/tailwindcss/index.css')
      : join(REPO, 'node_modules', id);
  return { path, base: dirname(path), content: await readFile(path, 'utf8') };
}

/** The real `app/globals.css` compiler. `build(candidates)` emits their rules. */
export async function compileGlobals(): Promise<UtilityCompiler> {
  const entry = await readFile(join(REPO, 'app/globals.css'), 'utf8');
  return compile(entry, {
    base: join(REPO, 'app'),
    loadStylesheet,
    loadModule: async () => {
      throw new Error('app/globals.css loads no JS module');
    },
  });
}

/**
 * Split `md:hover:!block` into its variant chain (`md:hover:`) and the utility
 * (`block`). A `:` inside `[…]` or `(…)` belongs to an arbitrary value, not to a
 * variant, and the `!` important marker is dropped: it does not change which
 * property the utility sets.
 */
export function splitVariant(token: string): { variant: string; utility: string } {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) cut = i;
  }
  return {
    variant: token.slice(0, cut + 1),
    utility: token.slice(cut + 1).replace(/^!|!$/g, ''),
  };
}

export interface UtilityRule {
  /** Where the rule starts in the compiled sheet — its cascade position. */
  offset: number;
  /** The rule's own top-level declarations, property → value. */
  declarations: ReadonlyMap<string, string>;
}

/**
 * The rule the compiled sheet emits for one un-prefixed utility, or `null` when
 * it emits none (not a utility, or a class Tailwind does not know).
 */
export function utilityRule(css: string, utility: string): UtilityRule | null {
  // The selector is the class name with every non-identifier character
  // CSS-escaped: `mt-0.5` is emitted as `.mt-0\.5`, `text-(--x)` as `.text-\(--x\)`.
  const selector = utility.replace(/[^\w-]/g, (c) => `\\\\\\${c}`);
  const match = new RegExp(`(^|[\\s{};])\\.${selector}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  if (!match) return null;
  const declarations = new Map<string, string>();
  for (const part of match[2]!.split(';')) {
    // A nested block (`&:hover { … }`) ends the rule's own declarations.
    if (part.includes('{')) break;
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
  }
  return { offset: match.index + match[1]!.length, declarations };
}

/**
 * The declarations an element carrying `classTokens` ends up with, from its
 * un-prefixed utilities: every rule folded in emission order, last write wins.
 * Variant-prefixed tokens are skipped — they apply only under their variant.
 */
export function resolveDeclarations(
  css: string,
  classTokens: readonly string[],
): Map<string, string> {
  const rules = classTokens
    .map(splitVariant)
    .filter((t) => t.variant === '')
    .map((t) => utilityRule(css, t.utility))
    .filter((r): r is UtilityRule => r !== null)
    .sort((a, b) => a.offset - b.offset);
  const resolved = new Map<string, string>();
  for (const rule of rules) {
    for (const [property, value] of rule.declarations) resolved.set(property, value);
  }
  return resolved;
}
