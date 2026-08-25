// Bundle the worker entrypoint into ONE self-contained ESM file (MOTIR-3421).
//
// WHY A BUNDLE. The runtime image is a Next.js STANDALONE output: its
// `node_modules` is the minimal set Next traced for the SERVER's entries, and
// the Dockerfile explicitly refuses to depend on `lib/` source arriving there as
// a tracing side effect ("Next's tracer happens to sweep the repo root into the
// standalone output today ... it is a tracing side effect a Next upgrade could
// withdraw without a word"). So the worker cannot import the app's modules from
// that tree, and it brings its own bundle — exactly as `/app/migrate` brings its
// own Prisma CLI, for the same reason.
//
// WHAT STAYS EXTERNAL, and why each one is deliberate:
//   * `@prisma/client` / the generated client and `@prisma/adapter-pg` / `pg`
//     load native engines and platform binaries; bundling them breaks the engine
//     resolution that reads paths relative to the package.
//   * `inngest` is external because the worker does not use it — `defineJob`
//     still calls `inngest.createFunction`, so the import survives, and marking
//     it external keeps the SDK out of a bundle that never invokes it.
// Everything else — every `lib/**` module the worker reaches — is inlined, which
// is the point.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = await esbuild.build({
  entryPoints: [path.join(root, 'scripts/worker.ts')],
  outfile: path.join(root, '.worker/worker.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // `@/…` is the app's tsconfig path alias; esbuild does not read tsconfig paths
  // for a bare build, so it is declared here.
  alias: { '@': root },
  plugins: [
    {
      // `server-only` is a Next.js MARKER package: importing it from a client
      // bundle is meant to fail the build, and it has no resolution outside
      // Next's own bundler. Three services the worker reaches import it. Stubbing
      // it to an empty module is correct rather than a workaround — the worker is
      // a server process by construction, which is the exact property the marker
      // asserts. (The E2E lane hits the same wall for the same reason.)
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
  // ⚠️ NATIVE and ENGINE-BACKED packages stay EXTERNAL — bundling them cannot
  // work, and each failure mode is different:
  //   * `argon2` is a native addon whose CJS entry calls `gypBuild(__dirname)`
  //     to locate its compiled binding. Inlined into an ESM bundle it dies at
  //     module-init with `__dirname is not defined` — and it is reached
  //     transitively (jobServices → assignableMembersService → lib/workspaces →
  //     lib/auth → passwords), not because the worker hashes anything.
  //   * `@prisma/client` / the generated client / `@prisma/adapter-pg` / `pg`
  //     resolve engines and platform binaries from paths relative to their own
  //     package directory.
  //   * `sharp` is the same class as argon2.
  //   * `inngest` is external because the worker does not invoke it — `defineJob`
  //     still calls `createFunction`, so the import survives, and this keeps an
  //     unused SDK out of the bundle.
  // Everything else — every `lib/**` module the worker reaches — is INLINED,
  // which is the point: the runtime image's `node_modules` is Next's minimal
  // traced set and does not contain them.
  //
  // ⚠️ THE EXTERNAL SET IS EXACTLY WHAT THE RUNTIME IMAGE ALREADY CONTAINS, and
  // that was MEASURED rather than assumed. Running `next build` and listing
  // `.next/standalone/node_modules` gives seven entries — `@aws-sdk`, `argon2`,
  // `next`, `pg`, `react`, `react-dom` and a nested `.pnpm` — and NOT
  // `@prisma/client`, `@prisma/adapter-pg` or `inngest`, which Next inlines into
  // its server chunks instead. So anything external that is not in that list
  // would resolve at build time here and fail at runtime in the image, which is
  // the worst shape a packaging bug can take.
  //
  // `argon2` and `pg` are external because they are NATIVE and present:
  //   * `argon2`'s CJS entry calls `gypBuild(__dirname)` to find its compiled
  //     binding; inlined into an ESM bundle it dies at module-init with
  //     `__dirname is not defined`. It is reached transitively (jobServices →
  //     assignableMembersService → lib/workspaces → lib/auth → passwords), not
  //     because the worker hashes anything.
  //   * `pg` opens sockets and optionally loads `pg-native`.
  //
  // Everything else is INLINED, including `@prisma/client`, the generated client
  // and `@prisma/adapter-pg`. That is possible because this schema uses the
  // `prisma-client` generator with `runtime = "nodejs"` and a DRIVER ADAPTER —
  // the generated output is plain TypeScript with no `.node` binary and no query
  // engine to locate, so there is nothing for a bundler to break. A schema that
  // went back to the binary engine would invalidate this line, which is why the
  // reason is written down rather than left as a list.
  external: ['pg', 'pg-native', 'argon2', 'sharp'],
  // Node builtins that some transitive dependency may reference dynamically.
  // ESM has no `require`, `__dirname` or `__filename`, and CJS dependencies
  // inlined by the bundler expect all three. Recreating them from
  // `import.meta.url` is the standard shim and is what lets a CJS transitive
  // dependency load unchanged.
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
console.log(`worker bundle: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
