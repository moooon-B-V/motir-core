import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-1315 — the Hand-Drawn / Indie style roughens framed surfaces via a
// `::after` overlay warped by #hd-rough, but it only hooked the full-box
// `.border` utility, so the APP SHELL frame (the sidebar rail's `border-r` and
// the top bar's `border-b`) stayed machine-straight. The fix draws the rough ink
// directly on the shell's data-surface hosts. This pins both halves of that
// contract: the CSS rules exist (palette-derived, filtered) AND the shell
// components emit the data-surface hooks the rules target.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
// The design-system token layer moved into `@motir/design-system/theme.css`
// (MOTIR-1527); app/globals.css now only `@import`s it + keeps app base styles.
// Read the UNION so these runtime-contract assertions see the full token layer.
const GLOBALS_CSS = read('app/globals.css') + read('packages/design-system/theme.css');
const TOPNAV = read('app/(authed)/_components/TopNav.tsx');
const SIDEBAR = read('components/ui/Sidebar.tsx');

// ⚠️ MOTIR-3997 MOVED THE ANCHOR. These rules used to read
// `[data-style='hand-drawn-indie'] [data-surface='sidebar']::after`; the style
// axis's material layer now ships scope-anchored, so the style is named in an
// `@scope` PRELUDE and the rule inside it carries only the rest of the selector:
//
//   @scope ([data-style='hand-drawn-indie']) to ([data-style]) {
//     [data-surface='sidebar']::after { … }
//   }
//
// (`to (…)` is a scoping LIMIT, so a nested `[data-style]` — a scoped
// StyleVignette tile — stops the layer at the boundary. See
// docs/decisions/scoped-preview-isolation.md.) The old pattern matches NONE of
// the rewritten rules, so this file failed loudly rather than silently, which is
// how it should be: the assertions below are about the rules' BODIES, and a
// finder that quietly matched nothing would have left them asserting over an
// empty population.
const scopedAfterRule = (surface: string) =>
  new RegExp(
    `@scope \\(\\[data-style='hand-drawn-indie'\\]\\) to \\(\\[data-style\\]\\)\\s*\\{` +
      `\\s*\\[data-surface='${surface}'\\]::after\\s*\\{([^}]*)\\}`,
  );

describe('Hand-Drawn style — app shell frame (MOTIR-1315)', () => {
  it('roughens the sidebar rail right edge and the top-bar bottom edge via #hd-rough', () => {
    for (const surface of ['sidebar', 'header']) {
      const m = GLOBALS_CSS.match(scopedAfterRule(surface));
      expect(m, `missing hand-drawn ::after rule for [data-surface='${surface}']`).not.toBeNull();
      const body = m![1];
      // Warped by the shared roughen filter.
      expect(body).toContain('url(#hd-rough)');
      // Palette-DERIVED ink (the surface-material contract: no raw hex hue).
      expect(body).toContain('var(--el-border-strong)');
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it('draws a single directional edge per host (rail = right, header = bottom)', () => {
    const rail = GLOBALS_CSS.match(scopedAfterRule('sidebar'))![1];
    expect(rail).toContain('border-right');

    const header = GLOBALS_CSS.match(scopedAfterRule('header'))![1];
    expect(header).toContain('border-bottom');
  });

  it('the shell chrome emits the data-surface hooks the rules target', () => {
    // The rail already emitted data-surface="sidebar"; the top bar now does too.
    expect(SIDEBAR).toContain('data-surface="sidebar"');
    expect(TOPNAV).toContain('data-surface="header"');
  });
});
