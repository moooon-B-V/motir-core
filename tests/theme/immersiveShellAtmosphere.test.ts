import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-4230 — the SHELL-CANVAS guard for the 3D / Immersive atmosphere.
//
// ── The defect ──────────────────────────────────────────────────────────────
// 3D / Immersive's identity is a whole-page atmosphere plus surface depth: the
// stylesheet's IMMERSIVE BACKGROUND block paints three palette-derived radial
// gradients, and it painted them on `body`. On a SIGNED-IN route the shell root
// (`components/ui/AppLayout.tsx`, and the platform-admin `AdminShell`) is a
// `h-dvh overflow-hidden` box carrying `bg-(--el-page-bg)` — an OPAQUE fill over
// the whole viewport. So the atmosphere was painted and then covered: every card
// had its 3D tokens while the frame they sit in stayed flat, on every screen a
// user actually works on. Nothing was red, because nothing asked.
//
// The fix gives both shells a `data-app-shell` hook and puts that hook in the
// atmosphere rule's own selector list, so the canvas the shell paints IS the
// canvas `body` would have shown.
//
// ── Why a SOURCE guard ──────────────────────────────────────────────────────
// The same argument `tests/theme/shellViewportUnits.test.ts` makes for the
// viewport units, plus one that is specific to this measurement: the property
// under test is `background-image: <a var()-bearing gradient stack>` inside an
// `@scope` block, and the DOM implementations available to a unit lane resolve
// neither — a `background: var(--x)` reads back as `rgba(0, 0, 0, 0)` and
// `@scope` is not implemented at all. A computed-style assertion here would be
// green on the broken source AND on the fixed one, which is worse than no test.
// So the unit lane asserts the WIRING, and the rendered half lives in
// `tests/e2e/shell-immersive-atmosphere.spec.ts`, where a real browser resolves
// the cascade and the assertion can actually fail.
//
// ── What is enforced ────────────────────────────────────────────────────────
// 1. EVERY SHELL ROOT CARRIES THE HOOK. The shell set is DERIVED (a class
//    literal stating both `h-dvh` and `overflow-hidden`), not listed, so a third
//    shell added later joins this guard without anyone remembering to extend a
//    constant — the same derivation, and the same reason for it, as MOTIR-3286's.
// 2. ONE RULE PAINTS BOTH. `body` and `[data-app-shell]` must be members of the
//    SAME rule. Two rules restating one gradient stack is a copy that drifts on
//    the first tune, and a canvas that disagrees with its frame about what the
//    canvas is was the whole defect.
// 3. THE ATMOSPHERE STAYS PALETTE-DERIVED and carries NO MOTION. Both are
//    acceptance criteria of the card: it must work under light and dark palettes
//    (so: `--el-*` reads, never a raw hue) and must not introduce motion for a
//    reduced-motion user (so: no `animation` / `transition` on the canvas, and
//    the rule is not gated behind a motion query in either direction).

const ROOT = resolve(__dirname, '..', '..');

const THEME_CSS_PATH = 'packages/design-system/theme.css';

/** The shell-canvas hook, as it appears in JSX and in CSS. */
const HOOK_ATTR = 'data-app-shell';
const HOOK_SELECTOR = '[data-app-shell]';

const SCAN_ROOTS = ['app', 'components', 'packages/design-system/src'] as const;

/** Every `.ts` / `.tsx` file under `dir`, repo-relative with forward slashes. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

const SOURCE_FILES = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)));

/** Source with comments stripped — a guard that reads prose as code proves nothing. */
function code(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The shell roots: a file is a shell if ONE class-name literal in it states both
 * `h-dvh` and `overflow-hidden`. Derived rather than listed — see the header.
 */
const SHELLS = SOURCE_FILES.map((file) => ({ file, src: code(file) })).filter(({ src }) =>
  [...src.matchAll(/['"`]([^'"`]*)['"`]/g)].some(
    (m) => /\bh-dvh\b/.test(m[1]!) && /\boverflow-hidden\b/.test(m[1]!),
  ),
);

const THEME_CSS = readFileSync(join(ROOT, THEME_CSS_PATH), 'utf8');

/**
 * The `@scope ([data-style='3d-immersive']) …` block that paints the atmosphere:
 * the one whose inner rule declares a `background-image` of radial gradients.
 * Located by CONTENT rather than by comment text, so re-wording the prose above
 * it cannot silently empty this guard.
 */
function immersiveAtmosphereBlocks(): { selector: string; body: string }[] {
  const css = THEME_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const open = /@scope\s*\(\[data-style='3d-immersive'\]\)\s*to\s*\(\[data-style\]\)\s*\{/g;
  const out: { selector: string; body: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = open.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    const inner = css.slice(m.index + m[0].length, i - 1);
    open.lastIndex = i;
    const brace = inner.indexOf('{');
    if (brace === -1) continue;
    const body = inner.slice(brace + 1, inner.lastIndexOf('}'));
    if (/background-image\s*:/.test(body) && /radial-gradient\(/.test(body)) {
      out.push({ selector: inner.slice(0, brace).trim(), body });
    }
  }
  return out;
}

const ATMOSPHERE_BLOCKS = immersiveAtmosphereBlocks();
const ATMOSPHERE = ATMOSPHERE_BLOCKS[0] ?? null;

describe('the 3D / Immersive shell-canvas guard (MOTIR-4230)', () => {
  it('finds the shells and the atmosphere rule at all — the scan is not vacuous', () => {
    // Without this every assertion below passes on an empty set, which is how a
    // totality test dies quietly.
    expect(SOURCE_FILES.length).toBeGreaterThan(200);
    expect(SHELLS.map((s) => s.file).sort(), 'the derived shell set').toEqual([
      'app/(admin)/_components/AdminShell.tsx',
      'components/ui/AppLayout.tsx',
    ]);
    expect(ATMOSPHERE, 'the IMMERSIVE BACKGROUND rule in theme.css').not.toBeNull();
  });

  it('gives every full-viewport shell root the `data-app-shell` hook', () => {
    const offenders = SHELLS.filter(({ src }) => !src.includes(HOOK_ATTR)).map(
      ({ file }) =>
        `${file} — the shell root states h-dvh + overflow-hidden but carries no ${HOOK_ATTR}`,
    );
    expect(
      offenders,
      'A full-viewport shell root paints an opaque `--el-page-bg` over the whole ' +
        "viewport, so it is the last thing between a style's `body`-level " +
        'atmosphere and the user. Without the hook the stylesheet cannot repaint ' +
        'that canvas and the frame goes flat under 3D / Immersive.',
    ).toEqual([]);
  });

  it('paints `body` and the shell canvas from ONE rule, never two copies', () => {
    const parts = ATMOSPHERE!.selector.split(',').map((p) => p.trim());
    expect(parts, 'the atmosphere selector list').toContain('body');
    expect(parts, 'the atmosphere selector list').toContain(HOOK_SELECTOR);

    // …and there is exactly ONE such rule. A second one is what a drifting copy
    // looks like: the frame and the canvas each painting their own version of
    // the atmosphere, agreeing on the day it is written and never again.
    expect(
      ATMOSPHERE_BLOCKS.map((b) => b.selector),
      'exactly one 3d-immersive rule paints the atmosphere',
    ).toHaveLength(1);
  });

  it('fixes the attachment on both members so the canvas and the frame agree', () => {
    // `background-attachment: fixed` resolves each layer against the VIEWPORT
    // rather than against its own box, which is what makes the shell's repaint
    // pixel-identical to the body's rather than merely similar.
    expect(ATMOSPHERE!.body).toMatch(/background-attachment\s*:\s*fixed/);
  });

  it('keeps the atmosphere palette-derived — light and dark, never a raw hue', () => {
    expect(ATMOSPHERE!.body).toMatch(/var\(--el-/);
    expect(ATMOSPHERE!.body, 'no hex literal — the palette axis owns the hue').not.toMatch(
      /#[0-9a-fA-F]{3,8}\b/,
    );
  });

  it('introduces no motion — a reduced-motion user gets the same static depth', () => {
    expect(ATMOSPHERE!.body).not.toMatch(/\b(?:animation|transition)\s*:/);
    // And the rule is not gated behind a motion query in EITHER direction: the
    // atmosphere is static depth and carries the identity, so suppressing it for
    // a reduced-motion user would take the style away rather than calm it.
    const css = THEME_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const at = css.indexOf(ATMOSPHERE!.selector);
    expect(at).toBeGreaterThan(0);
    const before = css.slice(Math.max(0, at - 400), at);
    expect(before, 'the atmosphere sits outside any prefers-reduced-motion block').not.toMatch(
      /@media\s*\(prefers-reduced-motion/,
    );
  });
});
