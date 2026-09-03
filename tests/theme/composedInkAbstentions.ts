import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanMutedSurfaceResolution, type MutedSurfaceSite } from './inkContrastScan';

// MOTIR-4251 — the POPULATION behind the render-time ink guard.
//
// `tests/helpers/renderedInkContrast.ts` is the mechanism; this is the set it is
// pointed at. A coverage claim over a population owes its population, and until
// this module the abstention had only ever been described in prose ("every
// composed surface in the product"), which is a sentence rather than a number.
//
// Read it by running the guard that consumes it —
// `tests/theme/composedSurfaceInkCoverage.test.ts` — which prints the count, the
// modules, and the covered/uncovered split. The same call is what produced every
// figure quoted in MOTIR-4251's pull request, so the number in that body is not
// a claim about a command, it IS the command.

/** The file set the static ink guard scans — the same globs, so the same tree. */
export const SCAN_GLOBS = [
  'components/*.tsx',
  'components/**/*.tsx',
  'components/**/*.ts',
  'app/**/*.tsx',
  'app/**/*.ts',
  'lib/**/*.tsx',
  'lib/**/*.ts',
  'packages/design-system/src/**/*.tsx',
  'packages/design-system/src/**/*.ts',
];

export function scannedFiles(repo: string = process.cwd()): string[] {
  return execFileSync('git', ['ls-files', ...SCAN_GLOBS], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/**
 * Every `--el-text-muted` site in the tree the static walk DECLINES to rule on —
 * the abstention, as rows rather than as a sentence.
 */
export function abstainedMutedSites(repo: string = process.cwd()): MutedSurfaceSite[] {
  const out: MutedSurfaceSite[] = [];
  for (const file of scannedFiles(repo)) {
    const text = readFileSync(join(repo, file), 'utf8');
    // The needle before the parse: the scan is a full TSX parse per file, and
    // the overwhelming majority of the tree carries no muted ink at all.
    if (!text.includes('text-(--el-text-muted)')) continue;
    for (const site of scanMutedSurfaceResolution(file, text)) {
      if (site.verdict === 'abstained') out.push(site);
    }
  }
  return out;
}

/** The abstained sites grouped by module, most sites first. */
export function abstainedByModule(sites: readonly MutedSurfaceSite[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const site of sites) counts.set(site.file, (counts.get(site.file) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
