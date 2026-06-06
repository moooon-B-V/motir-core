// Side-effect-only bootstrap: load .env BEFORE any sibling script imports
// `@/lib/db` (which constructs the Prisma client at module-load time and
// throws if DATABASE_URL is unset). next dev / Prisma / Vitest / Playwright
// each have their own .env loader; tsx-run scripts in this folder don't, so
// they `import './_loadEnv'` as their first import.
//
// Why a separate file: esbuild (tsx's transformer) treats .ts as ESM and
// hoists ALL `import` statements above any interleaved top-level code in
// the same module — so `loadEnv()` written between two imports still runs
// after the imports resolve. ESM hoisting is per-module, so a side-effect
// import of THIS file runs the loader before later imports in the caller.
import { config as loadEnv } from 'dotenv';

loadEnv();
