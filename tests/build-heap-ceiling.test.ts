import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The BUILD's heap ceiling is set in TWO places and they must agree (MOTIR-1789).
//
// `next build` compiles and then runs TypeScript in a build worker, and node 22's
// default old-space (~4.1GB) does not hold both phases. The compile succeeds, the
// check starts, and the worker dies with SIGABRT and a native stack naming nothing
// in the diff. It is not one pathological type: measured on one box, same
// toolchain, same node_modules, `tsc --noEmit --extendedDiagnostics` reported
// 5.36GB on `main` against 5.54GB with this story on top — a 3.4% delta over 54
// added files. The tree had grown to the edge and a story crossed it.
//
// ⚠️ WHY TWO PLACES, AND WHY A TEST RATHER THAN A COMMENT. `package.json`'s
// `build` script covers CI's `build` job and Vercel, both of which run it. The
// Dockerfile does NOT: it calls `pnpm exec next build` directly, so the script's
// ceiling never reaches the image.
//
// ⚠️ AND THE IMAGE IS NOT BUILT ON A PULL REQUEST — `Deploy to Fly` is
// `main`-push only. So the two paths cannot check each other: a branch that
// raised only the script would go green with the image path never exercised, and
// the OOM would land on the DEPLOY, after the pull request merged clean. That is
// the gap this file stands in for. Like `ci-server-action-salt.test.ts`, the
// failure it guards is not a bug somebody writes — it is a number somebody
// updates in one file while tidying.

const ROOT = process.cwd();
const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

/** The `--max-old-space-size` a `next build` invocation is prefixed with. */
function ceilingOn(source: string, invocation: RegExp): number | null {
  const line = source.split('\n').find((l) => invocation.test(l));
  expect(line, `no line matching ${invocation} — the build invocation moved`).toBeTruthy();
  const found = /--max-old-space-size=(\d+)/.exec(line ?? '');
  return found?.[1] === undefined ? null : Number(found[1]);
}

describe('both `next build` invocations raise the heap, to the SAME value', () => {
  // Node's own default, and the value both paths demonstrably die at. Stated as
  // the floor rather than pinning the exact ceiling, so raising the ceiling again
  // needs no edit here — only LOSING it does.
  const NODE_DEFAULT_MB = 4096;

  it("the `build` script's ceiling is above the default that OOMs", () => {
    const script = ceilingOn(pkg, /"build":/);
    expect(script, 'package.json `build` lost its --max-old-space-size').not.toBeNull();
    expect(script!).toBeGreaterThan(NODE_DEFAULT_MB);
  });

  it("the Dockerfile's ceiling is above the default that OOMs", () => {
    const image = ceilingOn(dockerfile, /pnpm exec next build/);
    expect(image, 'the Dockerfile lost its --max-old-space-size').not.toBeNull();
    expect(image!).toBeGreaterThan(NODE_DEFAULT_MB);
  });

  it('⚠️ the two agree — the image builds on a lane no pull request runs', () => {
    // The whole point. They are separate literals in separate files, and only
    // one of them is exercised before a merge.
    expect(ceilingOn(dockerfile, /pnpm exec next build/)).toBe(ceilingOn(pkg, /"build":/));
  });
});
