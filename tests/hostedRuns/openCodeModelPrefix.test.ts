import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE `anthropic/` PREFIX IS ADDED IN ONE PLACE (MOTIR-6483 AC3;
// `docs/decisions/hosted-agent-run.md` §7, *one id, two spellings, never mixed*).
//
// The gateway's key allow-list, `DispatchRun.model` and `implementationModel`
// hold the BARE id; only OpenCode's `--model` flag takes the prefixed one, and a
// prefixed id on the allow-list gets every model call refused with 403. So
// `toOpenCodeModel` in `lib/services/hostedRunModelService.ts` is the only
// module allowed to write the prefix.
//
// SCOPE: the shipped source trees — `lib/`, `app/`, `components/` and every
// `packages/*` source file (the CLI and the hosted-agent image included) —
// skipping `node_modules`, build output and tests (a test asserts the prefixed
// value, which is not adding it). The tell is a STRING LITERAL that starts with
// `anthropic/` and goes on to BUILD a value — an interpolation, a concatenation
// or a literal model id. Comment lines are dropped first, and a placeholder such
// as `anthropic/<model id>` in an error message documents the expected shape
// rather than writing it, so neither counts.

const ROOT = join(__dirname, '..', '..');
const TREES = ['lib', 'app', 'components', 'packages'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  'build',
  'coverage',
  'tests',
  '__tests__',
]);
const SOURCE = /\.(ts|tsx|js|mjs|cjs|sh)$/;
const THE_ONE_HOME = 'lib/services/hostedRunModelService.ts';
const PREFIX_LITERAL = /['"`]anthropic\/(?:\$\{|['"`]|[A-Za-z0-9])/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .join('\n');
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(path);
    } else if (SOURCE.test(name) && !/\.test\.|\.spec\./.test(name)) {
      yield path;
    }
  }
}

describe('the anthropic/ model prefix', () => {
  it(`is written by ${THE_ONE_HOME} and by no other module`, () => {
    const offenders: string[] = [];
    let homeWritesIt = false;
    for (const tree of TREES) {
      for (const file of walk(join(ROOT, tree))) {
        const rel = relative(ROOT, file);
        if (!PREFIX_LITERAL.test(codeOnly(readFileSync(file, 'utf8')))) continue;
        if (rel === THE_ONE_HOME) homeWritesIt = true;
        else offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
    expect(homeWritesIt).toBe(true);
  });
});
