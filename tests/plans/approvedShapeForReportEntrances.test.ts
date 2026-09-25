import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// THE INVENTORY for the UNGATED verdict read (Story MOTIR-5544 · Subtask
// MOTIR-6284) — the shape of `tests/approvalGates/planDecisionEntrances.test.ts`'s
// THE INVENTORY half.
//
// `plansService.resolveApprovedShapeForReport` computes the approved-shape
// verdict and the approving plan WITHOUT asserting `ai:view_plan`
// (`docs/decisions/run-found-trigger-dispatched-path.md`, *Its key*). That is
// correct only while its ONE caller — the run-found report service — never hands
// the result back: it answers its own caller with an acknowledgement only. The
// read compiles and passes every other test from any other file, so the only
// thing keeping it single-caller after it lands is THIS guard. A second caller
// is a leak the day someone finds it convenient.
//
// `lib/services/runFoundReportService.ts` does not exist yet (MOTIR-6285); the
// allow-list names it so the service card can land without editing the guard.

const ROOT = process.cwd();
const PRODUCT_DIRS = ['app', 'components', 'lib', 'packages/cli/src'];
const NAME = 'resolveApprovedShapeForReport';

/** The ONLY production files that may reference the read: its definition, and
 *  the one service that may call it. */
const ALLOWED_REFERRERS: readonly string[] = [
  'lib/services/plansService.ts',
  'lib/services/runFoundReportService.ts',
];

function collect(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(rel));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** Source with its comments stripped — prose ABOUT the read is not a reference. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

/**
 * THE PREDICATE: every file, other than the allowed two, whose CODE names the
 * read. Fed the real tree below, and a synthetic list to prove it can fail.
 */
function unexpectedReferrers(files: ReadonlyArray<{ path: string; code: string }>): string[] {
  return files
    .filter((f) => !ALLOWED_REFERRERS.includes(f.path))
    .filter((f) => stripComments(f.code).includes(NAME))
    .map((f) => f.path)
    .sort();
}

const TREE = PRODUCT_DIRS.flatMap(collect)
  .sort()
  .map((rel) => ({ path: rel, code: fs.readFileSync(path.join(ROOT, rel), 'utf8') }));

describe('THE INVENTORY — the ungated verdict read has exactly one allowed caller', () => {
  it('no production file outside the allow-list references it, on the tree as committed', () => {
    expect(TREE.length).toBeGreaterThan(100);
    expect(unexpectedReferrers(TREE)).toEqual([]);
  });

  it('the read is really DEFINED where the allow-list says — the guard is not vacuous', () => {
    const plans = TREE.find((f) => f.path === 'lib/services/plansService.ts');
    expect(plans).toBeDefined();
    expect(stripComments(plans!.code)).toMatch(new RegExp(`async ${NAME}\\(`));
  });

  it('FAILS when a third production file references it — a route, a tool, anything', () => {
    const synthetic = [
      { path: 'lib/services/plansService.ts', code: `async ${NAME}() {}` },
      { path: 'lib/services/runFoundReportService.ts', code: `plansService.${NAME}(p, w, c)` },
      { path: 'lib/mcp/tools/leakyTool.ts', code: `await plansService.${NAME}(p, w, c);` },
      { path: 'app/api/v1/leak/route.ts', code: `const { ${NAME} } = plansService;` },
      // Prose alone is not a reference.
      { path: 'lib/services/innocent.ts', code: `// see plansService.${NAME}\nexport {};` },
    ];
    expect(unexpectedReferrers(synthetic)).toEqual([
      'app/api/v1/leak/route.ts',
      'lib/mcp/tools/leakyTool.ts',
    ]);
  });
});
