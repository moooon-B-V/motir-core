import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { ESLint } from 'eslint';

// THE EMIT SEAM (Story MOTIR-3415 · Subtask MOTIR-3456; re-based by MOTIR-3418).
//
// Every event goes through `sendEvent` / `sendSystemEvent` / `dispatchSystemEvent`,
// because that module is the ONE description of what emitting means — the
// workspace-scoping invariant, the post-commit best-effort contract, and whatever
// the emit path grows next. An emitter that reaches the queue directly is an
// emitter none of that reaches, and for four `system.*` events that was exactly
// the state of the tree, under a green lint run.
//
// ⚠️ WHAT THE SEAM GUARDS CHANGED; THAT IT MUST BE GUARDED DID NOT. When this
// file was written the module was where the per-job CUTOVER SWITCH was read, so a
// bypassing emitter enqueued on neither engine. MOTIR-3418 deleted the switch
// with the second engine, and the bypass is no less a bug: a direct
// `dispatchEventToEngine` skips the tenant assertion and turns a post-commit
// notification failure into a 500 on a request the database already committed.
//
// ⚠️ THE LINT RULE ALONE IS NOT SUFFICIENT, which is why this file exists beside
// it. `JOB_ENGINE_RESTRICTION` cannot fire inside `lib/jobs/**`, where the import
// is legitimate — and one of the five original bypassing call sites
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

/**
 * The only file entitled to call `dispatchEventToEngine(...)`.
 *
 * ⚠️ IT USED TO BE TWO. `lib/jobs/dlq.ts` was the second, because a DLQ replay
 * re-EMITTED the dead run's original event. MOTIR-3418's engine-only replay
 * writes the `job_event` + `job_queue` pair itself — a fresh run rather than a
 * re-emit, so the operator's explicit replay is not swallowed by the dedup index
 * — and it therefore no longer goes through the dispatcher at all.
 */
const ALLOWED_DISPATCH_CALLERS = ['lib/jobs/sendEvent.ts'];

/**
 * Every `dispatchEventToEngine(...)` CALL in one file, found on the TypeScript
 * AST.
 *
 * ⚠️ IT COUNTS CALLS, NOT OCCURRENCES OF THE STRING, and that distinction is the
 * whole reason this is an AST walk rather than a grep. The tree names the
 * function in comments and in this file's own prose, and a regex counts those
 * too. A comment is not a call and neither is a sentence inside a string.
 */
function dispatchCallCount(absPath: string): number {
  const source = ts.createSourceFile(
    absPath,
    readFileSync(absPath, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  let count = 0;
  const visit = (node: ts.Node): void => {
    // Both call shapes: the bare import (`dispatchEventToEngine(…)`) and a
    // namespace access (`jobDispatcher.dispatchEventToEngine(…)`), because a
    // bypass written either way is the same bypass.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const named =
        (ts.isIdentifier(callee) && callee.text === 'dispatchEventToEngine') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'dispatchEventToEngine');
      if (named) count += 1;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return count;
}

describe('the emit seam — nothing reaches the dispatcher but sendEvent', () => {
  // ⚠️ AN EXPLICIT TIMEOUT, because this walks every `.ts` under lib/app/scripts
  // through the TypeScript parser. It is comfortably fast on its own and several
  // times slower under v8 coverage instrumentation, which is the lane that
  // matters: a guard that only goes red in the coverage job reads as a flake.
  it(
    'calls dispatchEventToEngine in exactly one file, counting CALLS rather than the string',
    { timeout: 120_000 },
    () => {
      const files = SOURCE_ROOTS.flatMap((root) => sourceFilesUnder(join(REPO_ROOT, root)));

      const callers = files
        .map((absPath) => ({
          path: relative(REPO_ROOT, absPath),
          calls: dispatchCallCount(absPath),
        }))
        .filter((f) => f.calls > 0)
        .map((f) => f.path)
        .sort();

      // Named rather than counted, so a failure says WHICH file appeared. The
      // dispatcher's own definition is excluded — it declares the function, it
      // does not call it.
      expect(callers.filter((p) => p !== 'lib/jobs/engine/dispatcher.ts')).toEqual(
        ALLOWED_DISPATCH_CALLERS,
      );
    },
  );

  it('does not count the name where it appears in prose', () => {
    // The guard above is only trustworthy if it demonstrably ignores these. Each
    // of these files NAMES the function in a comment and calls it nowhere.
    expect(dispatchCallCount(join(REPO_ROOT, 'lib/jobs/dlq.ts'))).toBe(0);
    expect(dispatchCallCount(join(REPO_ROOT, 'lib/jobs/engine/subscribers.ts'))).toBe(0);
    expect(dispatchCallCount(join(REPO_ROOT, 'scripts/worker.ts'))).toBe(0);
  });

  it('the four formerly-bypassing emitters do not reach the engine directly', () => {
    // ⚠️ THE IMPORT THEY USED TO CARRY WAS `@/lib/jobs/client` — our own thin
    // wrapper around the vendor SDK, which the package-level lint rule did not
    // restrict, which is how four `system.*` emitters bypassed the seam under a
    // green lint run. That file is gone (MOTIR-3418) and so is the wrapper; what
    // a bypass would import now is the engine itself.
    const converted = [
      'lib/billing/seatSync.ts',
      'lib/ciFleet/bootDispatch.ts',
      'lib/github/indexEnqueue.ts',
      'lib/jobs/definitions/ciRunnerFleet.ts',
    ];
    for (const rel of converted) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(text, `${rel} reaches the job engine directly`).not.toMatch(
        /from '@\/lib\/jobs\/engine\//,
      );
    }
  });
});

describe('the ESLint boundary around @/lib/jobs/engine', () => {
  // The rule is what stops a SIXTH bypass being added, so it is asserted by
  // running the real flat config over a fixture rather than by reading it.
  //
  // ⚠️ IT USED TO BE THE BOUNDARY AROUND `@/lib/jobs/client` (MOTIR-3418). That
  // rule existed because the PACKAGE-level one guarded a door nobody used: every
  // bypassing emitter imported our own wrapper, one file over, which was not the
  // vendor SDK and so was never restricted. Both the wrapper and the package
  // rule are gone; `JOB_ENGINE_RESTRICTION` is the survivor, and it is stated in
  // terms of OUR module graph for exactly the reason that lesson taught.
  async function lint(filePath: string, code: string): Promise<ESLint.LintResult[]> {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    return eslint.lintText(code, { filePath: join(REPO_ROOT, filePath) });
  }

  const IMPORTS_ENGINE =
    "import { dispatchEventToEngine } from '@/lib/jobs/engine/dispatcher';\n" +
    'export const x = dispatchEventToEngine;\n';

  it('REFUSES the import from an ordinary service', async () => {
    const [result] = await lint('lib/services/__boundaryFixture.ts', IMPORTS_ENGINE);
    const restricted = result!.messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted.length).toBeGreaterThan(0);
    expect(restricted[0]!.message).toMatch(/sendEvent\(\) \/ defineJob\(\)/);
  });

  it('REFUSES it from an app route, which is where an emitter usually lives', async () => {
    const [result] = await lint('app/api/__boundaryFixture/route.ts', IMPORTS_ENGINE);
    expect(result!.messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it('PERMITS it inside the jobs runtime and the worker', async () => {
    for (const path of ['lib/jobs/__boundaryFixture.ts', 'scripts/worker.ts']) {
      const [result] = await lint(path, IMPORTS_ENGINE);
      const restricted = result!.messages.filter(
        (m) => m.ruleId === 'no-restricted-imports' && /jobs\/engine/.test(m.message),
      );
      expect(restricted, `${path} should be allowed to import the engine`).toHaveLength(0);
    }
  });
});
