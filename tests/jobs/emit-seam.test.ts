import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { ESLint } from 'eslint';

// THE EMIT SEAM (Story MOTIR-3415 · Subtask MOTIR-3456).
//
// Every event goes through `sendEvent` / `sendSystemEvent` / `dispatchSystemEvent`,
// because that module is where the per-job cutover switch is read. An emitter
// that reaches the Inngest client directly is an emitter the switch cannot
// route — and for four `system.*` events that was exactly the state of the tree,
// under a green lint run.
//
// ⚠️ THE LINT RULE ALONE IS NOT SUFFICIENT, which is why this file exists beside
// it. `INNGEST_CLIENT_RESTRICTION` cannot fire inside `lib/jobs/**`, where the
// import is legitimate — and one of the five bypassing call sites
// (`lib/jobs/definitions/ciRunnerFleet.ts`) lived exactly there. So the call
// SITES are asserted over the tree as well as the imports.

const REPO_ROOT = join(__dirname, '..', '..');

/** The source roots an emitter could plausibly live in. */
const SOURCE_ROOTS = ['lib', 'app', 'scripts'];

/** Every `.ts`/`.tsx` file under `dir`, recursively. No glob dependency — the
 *  tree-walking guards in this suite all enumerate with `readdirSync`. */
function sourceFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFilesUnder(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** The only two files entitled to call `inngest.send(...)`. */
const ALLOWED_SEND_CALLERS = ['lib/jobs/dlq.ts', 'lib/jobs/sendEvent.ts'];

/**
 * Every `inngest.send(...)` CALL in one file, found on the TypeScript AST.
 *
 * ⚠️ IT COUNTS CALLS, NOT OCCURRENCES OF THE STRING, and that distinction is the
 * whole reason this is an AST walk rather than a grep. The tree contains the
 * text `inngest.send()` in at least six comments and one seed-fixture STRING
 * literal (`scripts/plan-seed/data/story-1.6.ts`), and a regex counts all seven.
 * A comment is not a call and neither is a sentence inside a string.
 */
function inngestSendCallCount(absPath: string): number {
  const source = ts.createSourceFile(
    absPath,
    readFileSync(absPath, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'send' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'inngest'
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return count;
}

describe('the emit seam — nothing reaches the Inngest client but sendEvent and the DLQ replay', () => {
  // ⚠️ AN EXPLICIT TIMEOUT, because this walks every `.ts` under lib/app/scripts
  // through the TypeScript parser. It is comfortably fast on its own and several
  // times slower under v8 coverage instrumentation, which is the lane that
  // matters: a guard that only goes red in the coverage job reads as a flake.
  it(
    'calls inngest.send in exactly two files, counting CALLS rather than the string',
    { timeout: 120_000 },
    () => {
      const files = SOURCE_ROOTS.flatMap((root) => sourceFilesUnder(join(REPO_ROOT, root)));

      const callers = files
        .map((absPath) => ({
          path: relative(REPO_ROOT, absPath),
          calls: inngestSendCallCount(absPath),
        }))
        .filter((f) => f.calls > 0)
        .map((f) => f.path)
        .sort();

      // Named rather than counted, so a failure says WHICH file appeared.
      expect(callers).toEqual(ALLOWED_SEND_CALLERS);
    },
  );

  it('does not count the string where it appears in prose or in a seed fixture', () => {
    // The guard above is only trustworthy if it demonstrably ignores these.
    // `story-1.6.ts` carries `inngest.send()` inside a STRING, which is the case
    // a comment-stripper alone would still miscount.
    expect(inngestSendCallCount(join(REPO_ROOT, 'scripts/plan-seed/data/story-1.6.ts'))).toBe(0);
    expect(inngestSendCallCount(join(REPO_ROOT, 'lib/jobs/client.ts'))).toBe(0);
    expect(inngestSendCallCount(join(REPO_ROOT, 'lib/env.ts'))).toBe(0);
    expect(inngestSendCallCount(join(REPO_ROOT, 'lib/services/jobScheduleHealthService.ts'))).toBe(
      0,
    );
    expect(inngestSendCallCount(join(REPO_ROOT, 'lib/jobs/engine/dispatcher.ts'))).toBe(0);
  });

  it('the four formerly-bypassing emitters no longer import the Inngest client', () => {
    const converted = [
      'lib/billing/seatSync.ts',
      'lib/ciFleet/bootDispatch.ts',
      'lib/github/indexEnqueue.ts',
      'lib/jobs/definitions/ciRunnerFleet.ts',
    ];
    for (const rel of converted) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(text, `${rel} still imports the Inngest client`).not.toMatch(
        /from '@\/lib\/jobs\/client'/,
      );
    }
  });
});

describe('the ESLint boundary around @/lib/jobs/client', () => {
  // The rule is what stops a SIXTH bypass being added, so it is asserted by
  // running the real flat config over a fixture rather than by reading it.
  async function lint(filePath: string, code: string): Promise<ESLint.LintResult[]> {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    return eslint.lintText(code, { filePath: join(REPO_ROOT, filePath) });
  }

  const IMPORTS_CLIENT =
    "import { inngest } from '@/lib/jobs/client';\nexport const x = inngest;\n";

  it('REFUSES the import from an ordinary service', async () => {
    const [result] = await lint('lib/services/__boundaryFixture.ts', IMPORTS_CLIENT);
    const restricted = result!.messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted.length).toBeGreaterThan(0);
    expect(restricted[0]!.message).toMatch(/sendEvent\(\) \/ sendSystemEvent\(\)/);
  });

  it('REFUSES it from an app route, which is where an emitter usually lives', async () => {
    const [result] = await lint('app/api/__boundaryFixture/route.ts', IMPORTS_CLIENT);
    expect(result!.messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it('PERMITS it inside the jobs runtime, the worker and the serve route', async () => {
    for (const path of [
      'lib/jobs/__boundaryFixture.ts',
      'scripts/worker.ts',
      'app/api/inngest/__boundaryFixture.ts',
    ]) {
      const [result] = await lint(path, IMPORTS_CLIENT);
      const restricted = result!.messages.filter(
        (m) => m.ruleId === 'no-restricted-imports' && /jobs\/client/.test(m.message),
      );
      expect(restricted, `${path} should be allowed to import the client`).toHaveLength(0);
    }
  });
});
