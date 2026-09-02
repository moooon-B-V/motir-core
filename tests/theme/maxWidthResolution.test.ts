// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

// MOTIR-4084 — the width a capped block ACTUALLY renders at, measured against
// the real compiled stylesheet.
//
// ── What was wrong, and why nothing caught it ──────────────────────────────
// The run section's empty-state body was `max-w-md`. Every check passed —
// typecheck, lint, and `tests/components/RunSection.test.tsx`, which asserts the
// copy is present, which it is — and the paragraph rendered as a 16px column,
// one word per line, twenty-two lines tall, in a panel ~1900px wide. Nothing in
// the suite measured a WIDTH, so nothing could see it.
//
// The mechanism is a namespace collision one layer below the component:
// `packages/design-system/theme.css` declares `--spacing-*` inside `@theme`, and
// Tailwind v4 resolves `max-w-<name>` against that namespace in preference to the
// default `--container-<name>`. `.max-w-md` is therefore `var(--spacing-md)` —
// 16px — and the class name says 28rem.
//
// ── Why this measurement and not a browser ─────────────────────────────────
// The question is what the STYLESHEET hands the layout engine, and the answer is
// fully determined before any element exists: a block-level `<p>` in a container
// wider than its cap renders at exactly `min(container, max-width)`. So the
// measurement here is the resolved `max-width` in px, taken from the stylesheet
// `app/globals.css` really compiles to — through `tailwindcss`'s own `compile()`,
// the same door `tests/theme/reducedMotionSpinner.test.ts` uses — and the width
// is derived from it against a fixed 1000px container. A browser would run the
// same arithmetic on the same input; it would add a browser to the sharded run
// and answer nothing this cannot.
//
// ⚠️ THE BOUND IS FIXED, NEVER A RATIO (`≥ 300px in a 1000px container`). A
// ratio-shaped assertion — "the cap is a sensible fraction of its container" —
// passes at 16px in a 16px box and is exactly the assertion this defect would
// have survived.
//
// ── The counterfactual is asserted, not assumed ────────────────────────────
// The last test pins the live behaviour of a NAMED step at under 40px. It is
// what makes the passing measurements above mean something: if the shadowing
// ever stops (a Tailwind change, a theme change), that test goes red and says
// so, rather than leaving five green assertions that no longer measure anything.

const ROOT = process.cwd();

/** The container this measures against, and the floor a capped block must clear. */
const CONTAINER_PX = 1000;
const FLOOR_PX = 300;

const REM_PX = 16;

/**
 * The capped blocks this project ships, each with the file that paints it.
 *
 * The file is not decoration: the test below reads each one and fails if the
 * utility it records is no longer there, so a fixture cannot drift into
 * measuring a class nobody renders.
 */
const CAPPED_BLOCKS = [
  {
    file: 'app/(authed)/items/[key]/_components/RunSection.tsx',
    where: 'the run section’s empty-state body — the reported defect',
    utility: 'max-w-[28rem]',
  },
  {
    file: 'app/(authed)/runs/_components/RunLogPane.tsx',
    where: 'the log-silence body in the run modal',
    utility: 'max-w-[20rem]',
  },
  {
    file: 'app/(admin)/admin/users/[userId]/page.tsx',
    where: 'the admin read-only notice',
    utility: 'max-w-[20rem]',
  },
  {
    file: 'components/planning/PlanProposalList.tsx',
    where: 'the plan proposal list’s empty state',
    utility: 'max-w-[24rem]',
  },
  {
    file: 'app/tokens/date-picker/page.tsx',
    where: 'the date-picker token gallery’s sections',
    utility: 'max-w-[20rem]',
  },
] as const;

/** A named step, measured as the counterfactual the fixed bound exists for. */
const COLLAPSING_UTILITY = 'max-w-md';

/** Resolve an `@import` the way the app's bundler does. */
async function loadStylesheet(id: string, base: string) {
  const path = id.startsWith('.')
    ? resolve(base, id)
    : id === 'tailwindcss'
      ? join(ROOT, 'node_modules/tailwindcss/index.css')
      : join(ROOT, 'node_modules', id);
  return { path, base: dirname(path), content: await readFile(path, 'utf8') };
}

/** The real `app/globals.css`, compiled for `candidates`. */
async function compileGlobals(candidates: readonly string[]): Promise<string> {
  const entry = await readFile(join(ROOT, 'app/globals.css'), 'utf8');
  const compiler = await compile(entry, {
    base: join(ROOT, 'app'),
    loadStylesheet,
    loadModule: async () => {
      throw new Error('app/globals.css loads no JS module');
    },
  });
  return compiler.build([...candidates]);
}

/** The `max-width` declaration the compiled sheet emits for one utility. */
function declaredMaxWidth(css: string, utility: string): string {
  // The selector is the class name with CSS-escaped punctuation: `max-w-[28rem]`
  // is emitted as `.max-w-\[28rem\]`.
  const selector = utility.replace(/[[\].]/g, (c) => `\\\\?\\${c}`);
  const rule = new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`).exec(css);
  if (!rule) throw new Error(`the compiled stylesheet emits no rule for \`${utility}\``);
  const value = /max-width:\s*([^;]+);?/.exec(rule[1]!);
  if (!value) throw new Error(`\`${utility}\` emits no max-width: ${rule[1]!.trim()}`);
  return value[1]!.trim();
}

/**
 * A CSS length in px, resolving one level of `var(--token)` against the
 * compiled sheet's own declarations — which is exactly the indirection the
 * defect hides in: the class says `md`, the rule says `var(--spacing-md)`, and
 * only the token's value says 16px.
 *
 * Returns `null` for a unit this cannot resolve (`ch`, `%`, `calc(…)`), so a
 * caller reports "unmeasurable" rather than a fabricated number.
 */
function resolvePx(value: string, tokens: ReadonlyMap<string, string>): number | null {
  const seen = new Set<string>();
  let current = value.trim();
  while (/^var\(\s*(--[\w-]+)\s*\)$/.test(current)) {
    const name = /^var\(\s*(--[\w-]+)\s*\)$/.exec(current)![1]!;
    if (seen.has(name)) return null; // a cycle is not a length
    seen.add(name);
    const next = tokens.get(name);
    if (next === undefined) return null;
    current = next.trim();
  }
  const px = /^(-?\d+(?:\.\d+)?)px$/.exec(current);
  if (px) return Number(px[1]);
  const rem = /^(-?\d+(?:\.\d+)?)rem$/.exec(current);
  if (rem) return Number(rem[1]) * REM_PX;
  return null;
}

/** Every `--token: value` the compiled sheet declares. */
function tokensIn(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of css.matchAll(/(--[\w-]+):\s*([^;{}]+);/g)) {
    if (!tokens.has(match[1]!)) tokens.set(match[1]!, match[2]!.trim());
  }
  return tokens;
}

/** What a block-level element renders at inside `container`, given its cap. */
function renderedWidth(container: number, maxWidth: number): number {
  return Math.min(container, maxWidth);
}

const ALL_UTILITIES = [...CAPPED_BLOCKS.map((b) => b.utility), COLLAPSING_UTILITY];
const CSS = await compileGlobals(ALL_UTILITIES);
const TOKENS = tokensIn(CSS);

describe('the width a capped block renders at (MOTIR-4084)', () => {
  it('resolves lengths, and says so rather than guessing when it cannot', () => {
    // The resolver is the whole measurement, so it is asserted on fixtures
    // before it is trusted on the tree — including the `var()` indirection the
    // defect lives in, and the units it must refuse.
    const tokens = new Map([
      ['--spacing-md', '16px'],
      ['--container-md', '28rem'],
      ['--loop', 'var(--loop)'],
    ]);
    expect(resolvePx('28rem', tokens)).toBe(448);
    expect(resolvePx('16px', tokens)).toBe(16);
    expect(resolvePx('var(--spacing-md)', tokens)).toBe(16);
    expect(resolvePx('var(--container-md)', tokens)).toBe(448);
    expect(resolvePx('var(--loop)', tokens)).toBeNull();
    expect(resolvePx('var(--nothing-declares-this)', tokens)).toBeNull();
    expect(resolvePx('46ch', tokens)).toBeNull();
    expect(resolvePx('calc(100% - 2rem)', tokens)).toBeNull();
  });

  it.each(CAPPED_BLOCKS)('renders ≥ 300px in a 1000px container — $where', ({ file, utility }) => {
    // The fixture is tied to the shipped source: a utility this file records
    // but the component no longer paints measures nothing.
    const source = readFileSync(join(ROOT, file), 'utf8');
    expect(source, `${file} no longer paints \`${utility}\``).toContain(utility);

    const declared = declaredMaxWidth(CSS, utility);
    const px = resolvePx(declared, TOKENS);
    expect(px, `\`${utility}\` resolves to \`${declared}\`, which is not a px length`).not.toBe(
      null,
    );
    expect(
      renderedWidth(CONTAINER_PX, px!),
      `\`${utility}\` → \`${declared}\` → ${px}px. In a ${CONTAINER_PX}px container that block ` +
        `renders ${renderedWidth(CONTAINER_PX, px!)}px wide, under the ${FLOOR_PX}px floor — ` +
        `the text wraps at one word per line. See MOTIR-4084.`,
    ).toBeGreaterThanOrEqual(FLOOR_PX);
  });

  it('a NAMED step still collapses — the counterfactual the floor exists for', () => {
    // Not a preference about Tailwind: it is what makes the five assertions above
    // measurements rather than tautologies. If this goes red the shadowing is
    // gone, and `tests/theme/namedMaxWidthUtilities.test.ts`'s premise — and its
    // ban — should be re-read before anything is loosened.
    const declared = declaredMaxWidth(CSS, COLLAPSING_UTILITY);
    expect(declared).toBe('var(--spacing-md)');
    const px = resolvePx(declared, TOKENS);
    expect(px).not.toBeNull();
    expect(
      px!,
      `\`${COLLAPSING_UTILITY}\` no longer resolves against the spacing namespace ` +
        `(it is now ${declared} = ${px}px)`,
    ).toBeLessThan(FLOOR_PX);
  });
});
