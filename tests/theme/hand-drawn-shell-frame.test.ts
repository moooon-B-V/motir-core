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
const GLOBALS_CSS = read('app/globals.css');
const TOPNAV = read('app/(authed)/_components/TopNav.tsx');
const SIDEBAR = read('components/ui/Sidebar.tsx');

describe('Hand-Drawn style — app shell frame (MOTIR-1315)', () => {
  it('roughens the sidebar rail right edge and the top-bar bottom edge via #hd-rough', () => {
    for (const surface of ['sidebar', 'header']) {
      const re = new RegExp(
        `\\[data-style='hand-drawn-indie'\\]\\s*\\[data-surface='${surface}'\\]::after\\s*\\{([^}]*)\\}`,
      );
      const m = GLOBALS_CSS.match(re);
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
    const rail = GLOBALS_CSS.match(
      /\[data-style='hand-drawn-indie'\]\s*\[data-surface='sidebar'\]::after\s*\{([^}]*)\}/,
    )![1];
    expect(rail).toContain('border-right');

    const header = GLOBALS_CSS.match(
      /\[data-style='hand-drawn-indie'\]\s*\[data-surface='header'\]::after\s*\{([^}]*)\}/,
    )![1];
    expect(header).toContain('border-bottom');
  });

  it('the shell chrome emits the data-surface hooks the rules target', () => {
    // The rail already emitted data-surface="sidebar"; the top bar now does too.
    expect(SIDEBAR).toContain('data-surface="sidebar"');
    expect(TOPNAV).toContain('data-surface="header"');
  });
});
