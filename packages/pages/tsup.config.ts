import { defineConfig } from 'tsup';

// Build config for @motir/pages, copied from @motir/orchestrator's (MOTIR-5757).
//
//  • ONE bundled entry: nothing here is a React component yet, so nothing
//    carries a `'use client'` directive that a per-file split would preserve.
//  • `fractional-indexing` stays EXTERNAL (tsup auto-externalises
//    `dependencies`), so the app and the package share one copy of the key
//    generator and so one ordering of keys.
//  • BOTH formats, for the reason orchestrator's config gives: Playwright
//    transpiles helpers to CommonJS, so once the app imports this package its
//    barrel will be `require`d as well as imported.
export default defineConfig({
  // NOT `tsconfig.json`: that one is the composite project the root solution
  // file references, and tsup's declaration build refuses a composite config
  // (TS6307). See `tsconfig.tsup.json`.
  tsconfig: 'tsconfig.tsup.json',
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'node20',
  outDir: 'dist',
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
