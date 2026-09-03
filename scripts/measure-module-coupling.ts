/**
 * Measure how coupled each `lib/*` module is to the rest of the app, so the
 * extraction ORDER in `docs/decisions/app-shell-over-packages.md` is a reading
 * rather than an opinion (Story MOTIR-4292 · Subtask MOTIR-4297).
 *
 *   pnpm tsx --tsconfig tsconfig.node.json scripts/measure-module-coupling.ts
 *   … --json          machine-readable, for a diff against the ADR's table
 *   … --min-files 8   the ADR's threshold (the default)
 *
 * ── What it counts, and why each column earns its place ─────────────────────
 *
 *   files            how big the move is.
 *   outward @/       ⭐ THE RANKING KEY: distinct `@/…` specifiers the module
 *                    imports from OUTSIDE itself. Each one is an import that
 *                    must become an injected port before the module can live in
 *                    `packages/*`, because a package may never import the app.
 *   → dirs           the other `lib/*` directories those imports reach. Two
 *                    modules with the same outward count are not equally hard:
 *                    reaching one leaf helper is not reaching `lib/services`.
 *   db / prisma      importers of `@/lib/db` and of the generated client. A
 *                    package that needs either is not a bounded context yet —
 *                    it is the persistence layer wearing one.
 *   importers        files OUTSIDE the module that import it. This is the blast
 *                    radius of the rename to `@motir/<name>`, and it is
 *                    deliberately NOT part of the ranking: a mechanical rename
 *                    of N import lines is cheap, while one outward import that
 *                    has to become a port is not.
 *
 * ⚠️ IT READS IMPORT SPECIFIERS, NOT A TYPE GRAPH. A `import type` costs
 * nothing at runtime and still has to be resolved by whoever builds the package,
 * so both are counted; a dynamic `import()` with a computed specifier is
 * invisible to it, and there are none under `lib/` today (asserted by the
 * `dynamicImports` line in the summary — a non-zero count means this table is
 * incomplete and the ADR's order needs re-reading before it is trusted).
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const LIB = join(ROOT, 'lib');
/** Where an importer can live. `lib/` is the subject; the rest is blast radius. */
const IMPORTER_ROOTS = ['lib', 'app', 'components', 'scripts', 'tests'];

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const minFilesArg = args.indexOf('--min-files');
const MIN_FILES = minFilesArg === -1 ? 8 : Number(args[minFilesArg + 1] ?? 8);

interface ModuleCoupling {
  module: string;
  files: number;
  outward: string[];
  outwardDirs: string[];
  dbImporters: number;
  prismaImporters: number;
  importers: number;
}

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** Every `@/…` specifier a file imports or re-exports, `import type` included. */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s*['"](@\/[^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"](@\/[^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s*['"](@\/[^'"]+)['"]/g,
    /\bimport\(\s*['"](@\/[^'"]+)['"]\s*\)/g,
  ];
  for (const p of patterns) {
    for (const m of source.matchAll(p)) found.push(m[1]!);
  }
  return found;
}

/** A computed dynamic import — the one shape this measurement cannot see. */
const DYNAMIC_COMPUTED = /\bimport\(\s*[^'")]/;

const libDirs = readdirSync(LIB)
  .filter((entry) => !entry.startsWith('.') && statSync(join(LIB, entry)).isDirectory())
  .sort();

const allFiles = walk(LIB);
const importerFiles = IMPORTER_ROOTS.flatMap((r) => walk(join(ROOT, r)));
const sourceOf = new Map(
  [...new Set([...allFiles, ...importerFiles])].map((f) => [f, readFileSync(f, 'utf8')] as const),
);
let dynamicImports = 0;
for (const source of sourceOf.values()) if (DYNAMIC_COMPUTED.test(source)) dynamicImports += 1;

const rows: ModuleCoupling[] = [];
for (const dir of libDirs) {
  const prefix = `lib/${dir}`;
  const files = allFiles.filter((f) => relative(ROOT, f).startsWith(prefix + sep));
  if (files.length < MIN_FILES) continue;

  const outward = new Set<string>();
  const outwardDirs = new Set<string>();
  let dbImporters = 0;
  let prismaImporters = 0;
  for (const file of files) {
    const specs = specifiersOf(sourceOf.get(file)!);
    let usesDb = false;
    let usesPrisma = false;
    for (const spec of specs) {
      const path = spec.slice(2); // strip `@/`
      if (path === 'lib/db') usesDb = true;
      if (path.startsWith('generated/prisma')) usesPrisma = true;
      if (path.startsWith(prefix + '/') || path === prefix) continue;
      outward.add(spec);
      const parts = path.split('/');
      if (parts[0] === 'lib' && parts[1]) outwardDirs.add(`lib/${parts[1]}`);
    }
    if (usesDb) dbImporters += 1;
    if (usesPrisma) prismaImporters += 1;
  }

  const importers = importerFiles.filter((f) => {
    if (relative(ROOT, f).startsWith(prefix + sep)) return false;
    return specifiersOf(sourceOf.get(f)!).some((s) => s.slice(2).startsWith(prefix));
  }).length;

  rows.push({
    module: prefix,
    files: files.length,
    outward: [...outward].sort(),
    outwardDirs: [...outwardDirs].sort(),
    dbImporters,
    prismaImporters,
    importers,
  });
}

// THE RANKING RULE, in one line: fewest outward `@/` imports first, because each
// one is a port to invert; ties break on the number of `lib/*` directories they
// reach, then on size.
rows.sort(
  (a, b) =>
    a.outward.length - b.outward.length ||
    a.outwardDirs.length - b.outwardDirs.length ||
    a.files - b.files,
);

if (asJson) {
  console.log(JSON.stringify({ minFiles: MIN_FILES, dynamicImports, rows }, null, 2));
} else {
  console.log(
    `| module | files | outward \`@/\` | → \`lib/*\` dirs | \`@/lib/db\` | prisma | importers |`,
  );
  console.log(`| --- | ---: | ---: | --- | ---: | ---: | ---: |`);
  for (const r of rows) {
    const dirs = r.outwardDirs.length === 0 ? '—' : r.outwardDirs.map((d) => `\`${d}\``).join(', ');
    console.log(
      `| \`${r.module}\` | ${r.files} | ${r.outward.length} | ${dirs} | ${r.dbImporters} | ${r.prismaImporters} | ${r.importers} |`,
    );
  }
  console.log(
    `\n${rows.length} modules of ${MIN_FILES}+ files · ${allFiles.length} files under \`lib/\` · ` +
      `${dynamicImports} computed dynamic import(s)`,
  );
  const first = rows[0];
  if (first) {
    console.log(`\nfirst by the ranking rule: \`${first.module}\` — outward imports:`);
    for (const spec of first.outward) console.log(`  ${spec}`);
  }
}
