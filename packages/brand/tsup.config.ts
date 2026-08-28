import { defineConfig } from 'tsup';

// Build config for @motir/brand. Mirrors @motir/design-system's, minus the two
// post-build fixups — and the reason it can drop them is worth stating, because
// the day it stops being true they must both come back.
//
// Nothing in this package is a CLIENT component: `BrandMark` renders plain
// markup, holds no state and calls no hook, so no source file carries a
// `'use client'` directive. That removes both hazards MOTIR-1538 recorded:
// there is no directive for esbuild to strip (`preserve-use-client.mjs`), and
// the bundled `dist/index.js` entry cannot eagerly pull a client-only API into
// a React Server Component (`build-index-barrel.mjs`).
//
// ⚠️ ADD A CLIENT COMPONENT HERE AND BOTH STEPS BECOME REQUIRED AGAIN, and the
// failure is silent until a server import crashes `next build` with "importing
// createContext into a React Server Component". `test/rsc-safe.test.ts` is the
// guard that turns that from a surprise into a red test: it asserts no source
// file declares `'use client'`, so adding one fails HERE, next to this comment,
// rather than in a consumer's build weeks later.
//
// Multi-file entry (`src/**`) keeps the file graph 1:1 with the output for the
// same reason the design system does — it is what makes a per-file directive
// meaningful if one is ever added.
export default defineConfig({
  entry: ['src/**/*.ts', 'src/**/*.tsx'],
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist',
  dts: true,
  splitting: false,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
