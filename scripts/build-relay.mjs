// Bundle the TERMINAL RELAY's entrypoint into ONE self-contained ESM file
// (Story MOTIR-6861 · MOTIR-6940, `docs/decisions/agent-terminal.md` Q1).
//
// The relay is the `motir-relay` Fly app, run from motir-core's SAME image, so it
// is built and staged exactly as the worker is (`scripts/build-worker.mjs`, whose
// header carries the whole argument: the runtime image is a Next standalone
// output, `lib/` is not in it, so a second process brings its own bundle). This
// file differs from that one in three lines — the entry, the output, and two
// more externals:
//
//   * `ws` is INLINED — it is pure JavaScript and is not in the standalone
//     `node_modules` (which holds only what Next traced for the server).
//   * `bufferutil` / `utf-8-validate` stay EXTERNAL — `ws`'s optional native
//     accelerators, `require`d inside a try/catch. Absent at runtime, `ws` falls
//     back to JavaScript; marked external so the bundler does not fail to
//     resolve what is meant to be optional.
//   * every other external is the worker's, for the worker's measured reason.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The worker's external set (`scripts/build-worker.mjs`): native and present in the image. */
const WORKER_EXTERNALS = ['pg', 'pg-native', 'argon2', 'sharp'];

const result = await esbuild.build({
  entryPoints: [path.join(root, 'scripts/relay.ts')],
  outfile: path.join(root, '.relay/relay.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // `@/…` is the app's tsconfig path alias.
  alias: { '@': root },
  plugins: [
    {
      // `server-only` stubbed, for the worker's reason: a server process by construction.
      name: 'stub-server-only',
      setup(build) {
        build.onResolve({ filter: /^server-only$/ }, () => ({
          path: 'server-only',
          namespace: 'stub-server-only',
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub-server-only' }, () => ({
          contents: 'export {};',
          loader: 'js',
        }));
      },
    },
  ],
  external: [...WORKER_EXTERNALS, 'bufferutil', 'utf-8-validate'],
  // ESM has no require / __dirname / __filename; CJS dependencies inlined expect them.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`relay bundle: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
