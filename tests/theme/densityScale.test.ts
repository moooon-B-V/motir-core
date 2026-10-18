import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-8901 — the DENSITY STEPS the own-box (padding / height) axis of the
// shape swap routes to. The vocabulary is MOTIR-2336's approved decision
// (Option 1): each step is DERIVED from the base token it scales, in ONE shared
// rule on `:root, [data-style]`, so a style that moves a base moves every step
// with it and nothing is written per style.
//
// This file pins the declaration. The browser proof that a step re-resolves
// inside a NESTED `[data-style]` scope is `tests/e2e/density-nested-scope.spec.ts`
// — a node test can model the cascade but only a browser can show the computed
// length, which is the thing that matters.

const THEME = readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8');

/** Strip block comments so prose quoting a token name cannot satisfy a match. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}
const CODE = stripComments(THEME);

/** base token → [reference px, the derived step sizes]. */
const SCALE = {
  '--spacing-card-padding': [24, [16, 12, 8, 4]],
  '--spacing-control-x': [10, [16, 12, 8, 6, 4, 2]],
  '--spacing-control-y': [6, [8, 4, 2]],
  '--spacing-chip-x': [10, [8, 6, 4, 2]],
  '--height-control': [36, [28, 32, 40, 48]],
} as const satisfies Record<string, readonly [number, readonly number[]]>;

const EXPECTED_NAMES = Object.entries(SCALE).flatMap(([base, [, steps]]) =>
  steps.map((n) => `${base}-${n}`),
);

/** Every top-level `selector { body }` block, brace-balanced. */
function topLevelBlocks(css: string): Array<{ selector: string; body: string }> {
  const blocks: Array<{ selector: string; body: string }> = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  let selector = '';
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        selector = css.slice(selectorStart, i).trim();
        bodyStart = i + 1;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ selector, body: css.slice(bodyStart, i) });
        selectorStart = i + 1;
      }
    } else if (ch === ';' && depth === 0) {
      selectorStart = i + 1;
    }
  }
  return blocks;
}

const BLOCKS = topLevelBlocks(CODE);

const DENSITY_BLOCKS = BLOCKS.filter((b) =>
  EXPECTED_NAMES.some((name) => new RegExp(`${name}\\s*:`).test(b.body)),
);

/** Any derived-looking name, to prove no step outside the approved 21 exists. */
const DERIVED_NAME =
  /--(?:spacing-[a-z-]+-x|spacing-[a-z-]+-y|spacing-card-padding|height-control)-\d+\s*:/g;

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

describe('density scale — the shared rule', () => {
  it('declares exactly the 21 approved step names, and no other derived density name', () => {
    const declared = [...CODE.matchAll(DERIVED_NAME)].map((m) => m[0].replace(/\s*:$/, ''));
    expect(EXPECTED_NAMES).toHaveLength(21);
    expect([...declared].sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it('declares every step in ONE rule whose selector list is exactly `:root, [data-style]`', () => {
    expect(DENSITY_BLOCKS).toHaveLength(1);
    const { selector, body } = DENSITY_BLOCKS[0]!;
    expect(selector.split(',').map((s) => s.trim())).toEqual([':root', '[data-style]']);
    const names = [...declarations(body).keys()];
    expect(names.sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it('declares no step in @theme or in any bare [data-style="…"] block', () => {
    const offenders = BLOCKS.filter(
      (b) => b !== DENSITY_BLOCKS[0] && /^(@theme|\[data-style=)/.test(b.selector),
    ).filter((b) => EXPECTED_NAMES.some((name) => new RegExp(`${name}\\s*:`).test(b.body)));
    expect(offenders.map((b) => b.selector)).toEqual([]);
  });

  it('derives each step from the right base and reference: round(nearest, calc(var(base) * N / ref), 1px)', () => {
    const decls = declarations(DENSITY_BLOCKS[0]!.body);
    for (const [base, [ref, steps]] of Object.entries(SCALE)) {
      for (const n of steps) {
        expect({ name: `${base}-${n}`, value: decls.get(`${base}-${n}`) }).toEqual({
          name: `${base}-${n}`,
          value: `round(nearest, calc(var(${base}) * ${n} / ${ref}), 1px)`,
        });
      }
    }
  });
});

describe('density scale — every style resolves each step from its OWN base', () => {
  const theme = BLOCKS.find((b) => b.selector === '@theme')!;
  const themeBases = declarations(theme.body);
  const styleBlocks = BLOCKS.flatMap((b) => {
    const m = /^\[data-style='([a-z0-9-]+)'\]$/.exec(b.selector);
    return m ? [{ id: m[1]!, decls: declarations(b.body) }] : [];
  });

  function basePx(styleDecls: Map<string, string>, base: string): number {
    const raw = styleDecls.get(base) ?? themeBases.get(base);
    const m = /^(\d+(?:\.\d+)?)px$/.exec(raw ?? '');
    if (!m) throw new Error(`${base} is not a px length: ${raw}`);
    return Number(m[1]);
  }

  it('sees the eleven registered styles', () => {
    expect(styleBlocks.map((s) => s.id)).toContain('warm-editorial');
    expect(styleBlocks.length).toBeGreaterThanOrEqual(10);
  });

  it('warm-editorial renders every step at exactly its named pixel value', () => {
    const warm = styleBlocks.find((s) => s.id === 'warm-editorial')!;
    const got: Record<string, number> = {};
    for (const [base, [ref, steps]] of Object.entries(SCALE)) {
      for (const n of steps) got[`${base}-${n}`] = Math.round((basePx(warm.decls, base) * n) / ref);
    }
    const want = Object.fromEntries(
      EXPECTED_NAMES.map((name) => [name, Number(name.split('-').pop())]),
    );
    expect(got).toEqual(want);
  });

  it('every style resolves each step as round(base * N / ref) from its own base, and keeps the scale ordered', () => {
    for (const style of styleBlocks) {
      for (const [base, [ref, steps]] of Object.entries(SCALE)) {
        const b = basePx(style.decls, base);
        const resolved = [...steps]
          .sort((x, y) => x - y)
          .map((n) => ({ n, px: Math.round((b * n) / ref) }));
        // A style whose base equals the reference reproduces the named pixel
        // value; any other style scales it. Either way a larger step is never
        // smaller than a smaller one, so the vocabulary stays a scale.
        if (b === ref)
          for (const { n, px } of resolved)
            expect({ style: style.id, base, n, px }).toEqual({ style: style.id, base, n, px: n });
        const pxs = resolved.map((r) => r.px);
        expect({ style: style.id, base, pxs }).toEqual({
          style: style.id,
          base,
          pxs: [...pxs].sort((x, y) => x - y),
        });
      }
    }
  });
});
