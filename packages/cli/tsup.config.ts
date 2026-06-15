import { defineConfig } from 'tsup';

// Build config for the `motir` binary. Toolchain pick (the 7.9.1 card asked to
// evaluate + record): commander (the CLI framework) + tsup (the bundler). See
// the README for the rationale.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  // The SDK + commander are real runtime deps installed alongside the package —
  // don't inline them; resolve from node_modules at run time.
  bundle: true,
  noExternal: [],
  // The bin entry needs a shebang so `motir` runs directly.
  banner: { js: '#!/usr/bin/env node' },
  outDir: 'dist',
});
