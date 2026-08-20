/**
 * scripts/assert-nft-trace-scope.mjs — fail the build when an entry's output
 * file trace has widened to the WHOLE PROJECT (MOTIR-3219).
 *
 * ## What it is guarding
 *
 * Turbopack traces the files each server entry needs into a `*.nft.json`
 * beside it, and `copyTracedFiles` copies exactly that list into
 * `output: 'standalone'`. When it meets a filesystem read whose path it cannot
 * resolve — `readFileSync(someDynamicValue)` — its fallback is to assume the
 * module could read ANYTHING, and it traces the entire project.
 *
 * That happened on `origin/main` for months. `instrumentation.ts` dynamic-imports
 * five E2E boundary mocks, every one of which reads a fixture from a path an env
 * var supplies, so `instrumentation.js.nft.json` listed **4510 files** — all of
 * `tests/**`, `design/**`, `prisma/migrations/**`, `packages/cli/**`,
 * `scripts/**` — and `.next/standalone` weighed 464 MB.
 *
 * ## Why it reads the ARTIFACT and not the build log
 *
 * Next does say something, once per build:
 *
 *     Encountered unexpected file in NFT list
 *     A file was traced that indicates that the whole project was traced
 *     unintentionally.
 *
 * ...but that message is the WEAKER signal, in three ways, so this gate asserts
 * the trace itself instead:
 *
 *   1. **The warning does not fail the build**, so it can stand for months while
 *      every check is green — which is exactly what it did.
 *   2. **It names ONE file.** Turbopack reports a single warning for the
 *      condition and names whichever module it reaches first, so a partial fix
 *      makes it name the next one and reads like no progress. This gate reports
 *      every offending entry, with what it dragged in.
 *   3. **It can be silenced without being fixed** — `experimental.turbopack.
 *      ignoreIssue` matches on issue title and description. Silencing the
 *      message would leave the 464 MB bundle exactly as it was, and leave this
 *      gate red, which is the right way round.
 *
 * ## The rule
 *
 * A traced file may not live in a directory that NOTHING serves at run time.
 * That is a property of the repository rather than a threshold to tune: a
 * request handler cannot need a Playwright spec, a design mock, a migration SQL
 * file or the CLI package, so any of those appearing in a trace means the
 * tracer gave up and swept the tree. Fixing the read is the remedy — see
 * `lib/test-fixture-file.ts` for the one this card fixed.
 *
 * Run it yourself with `pnpm assert:nft-trace` after a `next build`; CI runs it
 * in the `build` job, right after `pnpm build`.
 *
 * (Only console.warn / console.error are used — both allowed by the project's
 * no-console rule, since stdout/stderr IS a build step's surface.)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = process.cwd();
const SERVER_DIR = join(ROOT, '.next', 'server');

/**
 * Directories no server entry can legitimately need at run time. Each one is
 * either test material, design material, build-time-only tooling, or a
 * source-of-truth the runtime reads through a generated artifact instead.
 */
const NEVER_SERVED = [
  'tests',
  'design',
  'e2e',
  'docs',
  'scripts',
  'packages/cli',
  'prisma/migrations',
  '.github',
];

/** Every `*.nft.json` under `.next/server`, recursively. */
function traceFiles(dir) {
  let found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found = found.concat(traceFiles(path));
    else if (entry.name.endsWith('.nft.json')) found.push(path);
  }
  return found;
}

/** The repo-relative path a trace entry resolves to, or null if it is outside. */
function repoRelative(tracePath, entry) {
  const abs = resolve(join(tracePath, '..'), entry);
  const rel = relative(ROOT, abs);
  return rel.startsWith('..') ? null : rel.split(sep).join('/');
}

function offendersIn(tracePath) {
  const { files } = JSON.parse(readFileSync(tracePath, 'utf8'));
  const hits = new Map();
  for (const entry of files ?? []) {
    const rel = repoRelative(tracePath, entry);
    if (!rel) continue;
    const dir = NEVER_SERVED.find((d) => rel === d || rel.startsWith(`${d}/`));
    if (!dir) continue;
    const bucket = hits.get(dir) ?? [];
    if (bucket.length < 3) bucket.push(rel);
    hits.set(dir, bucket);
  }
  return hits;
}

function main() {
  try {
    statSync(SERVER_DIR);
  } catch {
    console.error(
      `[nft-trace] ${relative(ROOT, SERVER_DIR)} does not exist — run \`next build\` first.`,
    );
    process.exit(1);
  }

  const traces = traceFiles(SERVER_DIR);
  if (traces.length === 0) {
    // An empty result would otherwise read as a pass. It never is: a standalone
    // build always writes at least `instrumentation.js.nft.json`.
    console.error('[nft-trace] no *.nft.json found under .next/server — nothing was checked.');
    process.exit(1);
  }

  let failed = 0;
  for (const trace of traces) {
    const hits = offendersIn(trace);
    if (hits.size === 0) continue;
    failed += 1;
    console.error(`\n[nft-trace] ${relative(ROOT, trace)} traces directories nothing serves:`);
    for (const [dir, examples] of hits) {
      console.error(`  - ${dir}/  e.g. ${examples.join(', ')}`);
    }
  }

  if (failed > 0) {
    console.error(
      `\n[nft-trace] ${failed} entry trace(s) swept the project. This is the MOTIR-3219 condition:` +
        '\n  a filesystem read whose path Turbopack cannot resolve makes it trace everything,' +
        '\n  and `copyTracedFiles` then ships all of it in `output: "standalone"`.' +
        '\n  Find the dynamic read on the import trace `next build` prints and either scope it' +
        '\n  statically or mark it `/* turbopackIgnore: true */` (see lib/test-fixture-file.ts).\n',
    );
    process.exit(1);
  }

  console.warn(`[nft-trace] ${traces.length} entry trace(s) checked — none swept the project.`);
}

main();
