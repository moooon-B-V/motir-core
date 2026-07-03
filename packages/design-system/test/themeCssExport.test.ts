import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// MOTIR-1530 — lock the PACKAGING seam of the token CSS: the `@theme` preset +
// the three-axis token layers ship as the `@motir/design-system/theme.css`
// export, and the package's `exports` map + `files` allowlist actually point a
// consumer (motir-core's globals.css `@import`, the starter's the same) at a
// real, well-formed stylesheet. A consumer resolves this file purely through
// the published `exports` string `"./theme.css": "./theme.css"` — so if the
// export were dropped, renamed, or left out of `files`, the consumer's build
// would break at the CSS layer. These assertions are the package-side guard for
// that (the consumer-side resolution smoke lives in motir-core's
// tests/theme/designSystemPackageResolution.test.ts).

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgJson = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>;
  files: string[];
};

describe('@motir/design-system — package exports map', () => {
  it('declares both public entry points (the JS barrel and the token CSS)', () => {
    expect(pkgJson.exports['.']).toBeDefined();
    expect(pkgJson.exports['./theme.css']).toBe('./theme.css');
  });

  it('maps the token-CSS export to a file listed in the published `files` allowlist', () => {
    // `files` is what npm actually packs; a `./theme.css` export not covered by
    // it would resolve locally but 404 for an installed consumer.
    expect(pkgJson.files).toContain('theme.css');
    expect(existsSync(join(PKG_ROOT, 'theme.css'))).toBe(true);
  });

  it('ships the `.` barrel as ESM (`import` condition) resolving to the built dist', () => {
    const dot = pkgJson.exports['.'] as { types?: string; import?: string };
    expect(dot.import).toBe('./dist/index.js');
    expect(pkgJson.files).toContain('dist');
    // The build ran in postinstall; the barrel the export points at must exist.
    expect(existsSync(join(PKG_ROOT, 'dist/index.js'))).toBe(true);
  });
});

describe('@motir/design-system — theme.css `@theme` preset + three axis layers', () => {
  const css = readFileSync(join(PKG_ROOT, 'theme.css'), 'utf8');

  it('exposes the Tailwind v4 `@theme` preset block a consumer imports for its tokens', () => {
    // The consumer does `@import 'tailwindcss'; @import '@motir/design-system/theme.css';`
    // and Tailwind v4 reads the `@theme` block from the imported CSS — so this
    // block IS the distributed design-token preset.
    expect(css).toMatch(/@theme\s*\{/);
  });

  it('ships a selector layer for each of the three swap axes', () => {
    expect(css).toContain('[data-style='); // Axis 2 — shape/feel
    expect(css).toContain('[data-palette='); // Axis 1 — colour
    expect(css).toContain('[data-type='); // Axis 3 — typography
  });

  it('defines the documented Tier-3 `--el-*` colour contract the primitives bind to', () => {
    // The exact token map motir-core/CLAUDE.md freezes as the component colour
    // contract. A consumer's `components/ui/*` reference these `--el-*` tokens;
    // if the extracted CSS stopped shipping one, every surface using it breaks.
    const EL_CONTRACT = [
      '--el-text',
      '--el-text-strong',
      '--el-text-muted',
      '--el-text-inverted',
      '--el-accent',
      '--el-accent-text',
      '--el-accent-on-surface',
      '--el-highlight',
      '--el-surface',
      '--el-surface-soft',
      '--el-muted',
      '--el-border',
      '--el-border-soft',
      '--el-border-strong',
      '--el-link',
      '--el-danger',
      '--el-success',
      '--el-warning',
      '--el-info',
      '--el-type-epic',
      '--el-type-story',
      '--el-type-task',
      '--el-type-bug',
      '--el-type-subtask',
    ];
    for (const token of EL_CONTRACT) {
      // A definition, not a mere reference: `--el-x:` (allow surrounding space).
      expect(css, `theme.css must DEFINE ${token}`).toMatch(new RegExp(`\\${token}\\s*:`));
    }
  });

  it('defines the element-semantic SHAPE tokens the style axis swaps', () => {
    const SHAPE_CONTRACT = [
      '--radius-btn',
      '--radius-card',
      '--radius-input',
      '--radius-modal',
      '--radius-badge',
      '--radius-control',
      '--spacing-card-padding',
      '--spacing-control-x',
      '--height-btn-md',
      '--height-input',
      '--shadow-card',
      '--shadow-modal',
    ];
    for (const token of SHAPE_CONTRACT) {
      expect(css, `theme.css must DEFINE ${token}`).toMatch(new RegExp(`\\${token}\\s*:`));
    }
  });
});
