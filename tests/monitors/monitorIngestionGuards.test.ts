import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE GUARDS COVERAGE CANNOT SEE (Story MOTIR-4929 · Subtask MOTIR-5583) —
// structural facts about the ingestion surface that no unit test would notice
// breaking, because each is the ABSENCE of a second way to do something.
//
//   · PLACEMENT comes from one place: a monitor-filed bug's `folderId` is only
//     ever `bugDestinationService.resolve`'s return, and no `parentId` is set;
//   · ONE production caller of `listIssuesSince` — the ingestion service;
//   · the story's seam suite TRAPS outbound fetch to sentry.io and asserts its
//     record is empty, so "no test reaches Sentry" is measured, not assumed.
//
// Text scans over the tree: no database, no render, only `node:fs`/`node:path`
// — the structural-guard lane's profile (`tests/helpers/structuralGuardLane.ts`).

const ROOT = process.cwd();
const INGESTION = join(ROOT, 'lib', 'services', 'monitorIngestionService.ts');

/** Strip `//` and block comments, so prose that NAMES a call is not a call. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'generated') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

/** The body of the `workItemsService.createWorkItem({ … })` argument object. */
function createCallArguments(source: string): string[] {
  const bodies: string[] = [];
  const marker = 'workItemsService.createWorkItem(';
  let at = source.indexOf(marker);
  while (at !== -1) {
    const open = source.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      if (source[end] === '}') depth -= 1;
      if (depth === 0) break;
    }
    bodies.push(source.slice(open, end + 1));
    at = source.indexOf(marker, end);
  }
  return bodies;
}

/**
 * The placement verdict for one source text — kept a pure function so the
 * guard's OWN failure mode is asserted below, on a deliberately broken copy.
 */
function placementViolations(source: string): string[] {
  const src = code(source);
  const violations: string[] = [];
  if (!/const\s*\{\s*folderId\s*\}\s*=\s*await\s+bugDestinationService\.resolve\(/.test(src)) {
    violations.push('folderId is not destructured from bugDestinationService.resolve');
  }
  const calls = createCallArguments(src);
  if (calls.length === 0) violations.push('no workItemsService.createWorkItem call found');
  for (const body of calls) {
    if (/\bparentId\b/.test(body)) violations.push('a created bug is given a parentId');
    // Shorthand `folderId,` (the resolver's binding) is the ONLY legal form.
    const folder = body.match(/\bfolderId\b\s*(:[^,}\n]*)?/g) ?? [];
    for (const occurrence of folder) {
      if (occurrence.includes(':')) {
        violations.push(`folderId is computed in place: "${occurrence.trim()}"`);
      }
    }
    if (folder.length === 0) violations.push('a created bug carries no folderId at all');
  }
  return violations;
}

describe('PLACEMENT comes from one place', () => {
  it('a monitor-filed bug is placed only by bugDestinationService.resolve — no parentId', () => {
    expect(placementViolations(readFileSync(INGESTION, 'utf8'))).toEqual([]);
  });

  it('BITES on a deliberately broken placement (a fixed folderId, a parentId)', () => {
    const real = readFileSync(INGESTION, 'utf8');
    const fixedFolder = real.replace(
      /(workItemsService\.createWorkItem\(\s*\{[\s\S]*?)\bfolderId,/,
      "$1folderId: 'folder-hardcoded',",
    );
    expect(fixedFolder).not.toBe(real);
    expect(placementViolations(fixedFolder).join('\n')).toMatch(/computed in place/);

    const withParent = real.replace(
      /(workItemsService\.createWorkItem\(\s*\{)/,
      "$1 parentId: 'x',",
    );
    expect(placementViolations(withParent).join('\n')).toMatch(/parentId/);
  });
});

describe('ONE production caller of listIssuesSince', () => {
  it('outside tests/, only the ingestion service calls it (the providers define it)', () => {
    const callers = [
      ...walk(join(ROOT, 'lib')),
      ...walk(join(ROOT, 'app')),
      ...walk(join(ROOT, 'scripts')),
    ]
      .filter((file) => /\.listIssuesSince\(/.test(code(readFileSync(file, 'utf8'))))
      .map((file) => relative(ROOT, file));
    expect(callers).toEqual(['lib/services/monitorIngestionService.ts']);
  });
});

describe('the story suite cannot reach sentry.io', () => {
  it('the seam suite traps sentry.io fetches and asserts the record is empty', () => {
    const seams = readFileSync(
      join(ROOT, 'tests', 'integration', 'monitors', 'monitorIngestionSeams.test.ts'),
      'utf8',
    );
    expect(seams).toMatch(/globalThis\.fetch\s*=/);
    expect(seams).toMatch(/sentry\\\.io/);
    expect(seams).toMatch(/expect\(sentryRequests\)\.toEqual\(\[\]\)/);
  });
});
