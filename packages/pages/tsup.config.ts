import { defineConfig, type Options } from 'tsup';

type EsbuildPlugin = NonNullable<Options['esbuildPlugins']>[number];

// Build config for @motir/pages, copied from @motir/orchestrator's (MOTIR-5757).
//
//  • TWO entries since the page editor landed (MOTIR-7275): `index`, the barrel,
//    and `editor`, the React page editor. The editor is a client component and
//    the rest of the package is server code (the schema, the conversions, the
//    save procedure), so they cannot share one output: a `'use client'` on the
//    barrel would turn every server import of it into a client reference, and
//    none on the editor would let Next render it as a server component.
//  • So the barrel's `./editor` import is kept EXTERNAL (`editorAsSibling`
//    below) and rewritten to the sibling output, the thin-barrel shape
//    `@motir/design-system` uses (its `build-index-barrel.mjs`), and ONLY the
//    editor's output carries the directive: esbuild keeps an ENTRY file's
//    directive prologue, which `src/editor/index.ts` opens with.
//    `test/editor/build.test.ts` reads the built files and holds both halves.
//  • `treeshake` OFF: tsup's tree-shaking is a Rollup pass, and Rollup strips a
//    module-level directive. esbuild already drops dead code in each entry.
//  • `fractional-indexing` stays EXTERNAL (tsup auto-externalises
//    `dependencies`), so the app and the package share one copy of the key
//    generator and so one ordering of keys. React is a peer and external too.
//  • BOTH formats, for the reason orchestrator's config gives: Playwright
//    transpiles helpers to CommonJS, so once the app imports this package its
//    barrel will be `require`d as well as imported.

const EDITOR_ENTRY = /^\.\/editor$/;

/** Resolve the barrel's `./editor` to the sibling output of the same format. */
const editorAsSibling: EsbuildPlugin = {
  name: 'pages-editor-as-sibling',
  setup(build) {
    const extension = build.initialOptions.format === 'cjs' ? 'cjs' : 'js';
    build.onResolve({ filter: EDITOR_ENTRY }, (args) =>
      args.importer.endsWith('src/index.ts')
        ? { path: `./editor.${extension}`, external: true }
        : undefined,
    );
  },
};

export default defineConfig([
  {
    // NOT `tsconfig.json`: that one is the composite project the root solution
    // file references, and tsup's declaration build refuses a composite config
    // (TS6307). See `tsconfig.tsup.json`.
    tsconfig: 'tsconfig.tsup.json',
    entry: { index: 'src/index.ts', editor: 'src/editor/index.ts' },
    format: ['esm', 'cjs'],
    target: 'es2022',
    outDir: 'dist',
    dts: true,
    clean: true,
    sourcemap: true,
    // Splitting OFF, as in `@motir/design-system`: a shared chunk would carry
    // no directive, and the barrel reaches the editor only through the sibling.
    splitting: false,
    treeshake: false,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    esbuildPlugins: [editorAsSibling],
  },
]);
