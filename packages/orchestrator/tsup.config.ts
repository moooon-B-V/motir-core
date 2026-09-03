import { defineConfig } from 'tsup';

// Build config for @motir/orchestrator, in the mould of @motir/design-system's
// with the differences a SERVER-SIDE package needs:
//
//  • ONE bundled entry rather than a multi-file graph. The design system splits
//    per file to preserve each one's `'use client'` directive; nothing here is a
//    React component and nothing here has a directive, so a single bundle is the
//    simpler artefact.
//  • `decimal.js` stays EXTERNAL — tsup auto-externalises `dependencies`, so the
//    consumer resolves it from its own node_modules and there is one copy of the
//    money type in the process rather than two.
//  • node20 target: this package runs in the Next server runtime and in the
//    worker process, never in a browser.
export default defineConfig({
  // NOT `tsconfig.json`: that one is the composite project the root solution
  // file references, and tsup's declaration build compiles through a synthetic
  // project that a composite config refuses (TS6307). See `tsconfig.tsup.json`.
  tsconfig: 'tsconfig.tsup.json',
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
