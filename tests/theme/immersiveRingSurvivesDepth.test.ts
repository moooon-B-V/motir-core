// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

// MOTIR-6440 — in the 3D / Immersive style, a Tailwind `ring-*` must survive
// the style's depth shadows.
//
// ── The defect this measures ────────────────────────────────────────────────
// A Tailwind v4 `ring-*` IS a `box-shadow` (`--tw-ring-offset-shadow`,
// `--tw-ring-shadow`), emitted inside `@layer utilities`. 3D / Immersive gives
// surfaces depth with UNLAYERED `box-shadow` rules, and an unlayered
// declaration outranks a layered one whatever their specificity. A rule that
// set the depth ALONE therefore replaced the ring: the roadmap canvas's search
// match, selection and Show-changes emphasis (`ProjectRoadmapCanvas`'s node
// wrapper is `rounded-(--radius-card)` + `ring-2`) and every control's
// `focus-visible:ring` rendered with no ring at all in this style.
//
// ── Why the assertion is over the COMPILED stylesheet ───────────────────────
// Same reason as `reducedMotionSpinner.test.ts`: the question is which
// declaration WINS, and the layer a rule lands in is a property of the
// compilation. happy-dom drops `@layer` rules from the CSSOM, so a DOM-level
// suite here would not see the ring it is supposed to protect.
//
// ── CHROMIUM CROSS-CHECK (2026-09-26) ───────────────────────────────────────
// The real Tailwind compile over `@import 'tailwindcss'` + this theme.css,
// read with `getComputedStyle(el).boxShadow` in headless Chromium:
//   default       card ring-2 / modal ring-2 / button focus-visible:ring-2   RING RING RING
//   3d-immersive  on origin/main before this fix                             none none none
//   3d-immersive  with this fix                                              RING RING RING
// and the 3D card kept all four `--shadow-card` layers under its ring. Read
// with transitions off: the 3D key set transitions `box-shadow` over 90ms, so
// a read taken the instant focus lands sees the ring's start value.

const ROOT = process.cwd();
const THREE_D_SCOPE = "@scope ([data-style='3d-immersive']) to ([data-style])";
const RING_LAYERS = [
  'var(--tw-inset-ring-shadow, 0 0 #0000)',
  'var(--tw-ring-offset-shadow, 0 0 #0000)',
  'var(--tw-ring-shadow, 0 0 #0000)',
];

/**
 * The 3D surfaces that set `box-shadow` and can NEVER carry a ring, so they
 * may keep a depth-only shadow. Each is a structural region, not something a
 * user focuses or a state marks: a board column's panel, the rail and the top
 * bar. A new exemption must earn its place with the same argument.
 */
const RINGLESS_SURFACES = new Set([
  '[data-board-col-panel]',
  "[data-surface='sidebar']",
  "[data-surface='header']",
]);

/** Under forced colors the browser paints no box-shadow at all, ring included. */
const FORCED_COLORS = '(forced-colors: active)';

async function loadStylesheet(id: string, base: string) {
  const path = id.startsWith('.')
    ? resolve(base, id)
    : id === 'tailwindcss'
      ? join(ROOT, 'node_modules/tailwindcss/index.css')
      : join(ROOT, 'node_modules', id);
  return { path, base: dirname(path), content: await readFile(path, 'utf8') };
}

async function compileApp(): Promise<string> {
  const compiler = await compile(await readFile(join(ROOT, 'app/globals.css'), 'utf8'), {
    base: join(ROOT, 'app'),
    loadStylesheet,
    loadModule: async () => {
      throw new Error('this entry loads no JS module');
    },
  });
  // The ring utilities the defect was about, so their `@property`
  // registrations are part of the build exactly as they are in the app.
  return compiler.build([
    'rounded-(--radius-card)',
    'ring-2',
    'ring-offset-2',
    'ring-(--el-accent-on-surface)',
    'focus-visible:ring-2',
  ]);
}

interface ShadowRule {
  selector: string;
  value: string;
  layers: string[];
  scopes: string[];
  media: string[];
}

/**
 * Walk a compiled stylesheet and return every `box-shadow` declaration with
 * its at-rule context. Models brace nesting, `@layer`, `@media` and `@scope`;
 * a style rule's block is consumed whole (the theme nests no rules inside a
 * style rule). Comments are stripped first so a brace inside one cannot skew
 * the nesting.
 */
function boxShadowRules(source: string): ShadowRule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: ShadowRule[] = [];
  const layers: string[] = [];
  const scopes: string[] = [];
  const media: string[] = [];
  const opened: (null | 'layer' | 'scope' | 'media')[] = [];
  let head = '';

  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      const prelude = head.trim().replace(/\s+/g, ' ');
      head = '';
      const layer = /^@layer\s+([\w-]+)$/.exec(prelude);
      const mediaRule = /^@media\s+(.+)$/.exec(prelude);
      if (layer) {
        layers.push(layer[1]!);
        opened.push('layer');
      } else if (mediaRule) {
        media.push(mediaRule[1]!.trim());
        opened.push('media');
      } else if (prelude.startsWith('@scope')) {
        scopes.push(prelude);
        opened.push('scope');
      } else if (prelude.startsWith('@')) {
        opened.push(null);
      } else {
        const end = css.indexOf('}', i);
        const body = css.slice(i + 1, end === -1 ? css.length : end);
        for (const declaration of body.split(';')) {
          const match = /^\s*box-shadow\s*:\s*([\s\S]+)$/.exec(declaration);
          if (match) {
            found.push({
              selector: prelude,
              value: match[1]!.trim().replace(/\s+/g, ' '),
              layers: [...layers],
              scopes: [...scopes],
              media: [...media],
            });
          }
        }
        i = end === -1 ? css.length : end;
      }
      continue;
    }
    if (ch === '}') {
      const what = opened.pop();
      if (what === 'layer') layers.pop();
      if (what === 'scope') scopes.pop();
      if (what === 'media') media.pop();
      head = '';
      continue;
    }
    head += ch;
  }
  return found;
}

describe('3D / Immersive keeps a Tailwind ring on every surface it gives depth to (MOTIR-6440)', () => {
  let rules: ShadowRule[] = [];
  const load = async () => {
    if (rules.length === 0) rules = boxShadowRules(await compileApp());
    return rules;
  };

  it(
    'the ring utility is a layered box-shadow, and the 3D depth rules are unlayered — the premise',
    { timeout: 60_000 },
    async () => {
      const all = await load();
      const ring = all.find((r) => r.selector === '.ring-2');
      expect(ring?.layers).toEqual(['utilities']);
      expect(ring?.value).toContain('var(--tw-ring-shadow)');

      const threeD = all.filter((r) => r.scopes.includes(THREE_D_SCOPE));
      expect(threeD.length).toBeGreaterThan(10);
      for (const rule of threeD) expect(rule.layers).toEqual([]);
    },
  );

  it(
    'every 3D box-shadow that can meet a ring composes the ring layers FIRST',
    { timeout: 60_000 },
    async () => {
      const offenders = (await load())
        .filter((r) => r.scopes.includes(THREE_D_SCOPE))
        .filter((r) => !r.media.includes(FORCED_COLORS))
        .filter((r) => !RINGLESS_SURFACES.has(r.selector))
        .filter((r) => !r.value.startsWith(RING_LAYERS.join(', ')))
        .map((r) => `${r.selector} → box-shadow: ${r.value}`);
      expect(offenders).toEqual([]);
    },
  );

  it(
    'the card-radius panel keeps its resting depth under the ring (AC 3)',
    { timeout: 60_000 },
    async () => {
      const card = (await load()).find(
        (r) => r.scopes.includes(THREE_D_SCOPE) && r.selector === '.rounded-\\(--radius-card\\)',
      );
      expect(card?.value).toBe([...RING_LAYERS, 'var(--shadow-card)'].join(', '));
    },
  );
});

describe('the roadmap canvas marks a card with a ring on the card radius — the surface this protects', () => {
  it('the node wrapper is `rounded-(--radius-card)` and rings matched / selected / emphasised nodes', () => {
    const source = readFileSync(join(ROOT, 'components/planning/ProjectRoadmapCanvas.tsx'), 'utf8');
    expect(source).toContain("'relative rounded-(--radius-card) transition-opacity");
    expect(source).toMatch(
      /selected \|\| matched \|\| emphasised\s*\?\s*'ring-2 ring-\(--el-accent-on-surface\) ring-offset-2/,
    );
  });
});
