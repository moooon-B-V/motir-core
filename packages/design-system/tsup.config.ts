import { defineConfig } from 'tsup';

// Build config for @motir/design-system. Mirrors the @motir/cli precedent
// (tsup + ESM + dts), with the differences a React component library needs:
//
//  • Multi-file entry (`src/**`) rather than one bundled entry, so each source
//    file emits its OWN output chunk and its `'use client'` directive is
//    preserved per-file (tsup hoists the directive onto the emitted chunk).
//    A single bundle would collapse the RSC-safe registries + init-script and
//    the client provider/primitives into one chunk with one directive — which
//    would wrongly mark the server-safe modules as client. Keeping the file
//    graph 1:1 preserves the client/server boundary the ADR (§5) fixes.
//  • `dts` for the published type surface.
//  • react / react-dom / next stay external (peers); the runtime deps
//    (radix, lucide, cva, clsx, tailwind-merge) are auto-externalized by tsup
//    from `dependencies`, so they resolve from the consumer's node_modules.
export default defineConfig({
  entry: ['src/**/*.ts', 'src/**/*.tsx'],
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist',
  dts: true,
  // Splitting OFF: code-splitting hoists shared modules into directive-less
  // chunks, which STRIPS the per-file `'use client'` banner (verified). With
  // splitting off, each entry is emitted 1:1 and tsup preserves its directive,
  // so the client components stay client and the RSC-safe modules stay server —
  // the boundary the ADR (§5) fixes. Some shared code (e.g. `cn`) duplicates
  // across entries; that's the accepted cost of correct directives.
  splitting: false,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: ['react', 'react-dom', 'react/jsx-runtime', 'next'],
  // NOTE: esbuild strips directive prologues (`'use client'`), and tsup has no
  // reliable built-in preservation. The `build` script runs
  // `scripts/preserve-use-client.mjs` immediately after tsup to re-add the
  // directive to each emitted file whose SOURCE declared one — so the client
  // components stay client-module boundaries for a Next (RSC) consumer (ADR §5).
});
