import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-3219: nothing `instrumentation.ts` reaches may do its own
// filesystem I/O.
//
// Turbopack traces each server entry's files into a `*.nft.json`, and
// `copyTracedFiles` ships exactly that list in `output: 'standalone'`. When it
// meets a read whose path it cannot resolve — `readFileSync(fromAnEnvVar)` —
// its fallback is to trace the WHOLE PROJECT. `instrumentation.ts`
// dynamic-imports five E2E boundary mocks, every one of which reads a fixture
// from an env-supplied path, so `instrumentation.js.nft.json` listed 4510 files
// (all of `tests/**`, `design/**`, `prisma/migrations/**`, `packages/cli/**`)
// and `.next/standalone` weighed 464 MB.
//
// It survived for months because the only thing that noticed was a Turbopack
// WARNING, which does not fail a build — and which names just ONE module,
// whichever it reaches first, so unwiring the named one only promotes the next
// (MOTIR-3219 established that by experiment). `scripts/assert-nft-trace-scope.mjs`
// is the total check and runs in CI's `build` job against the real `.nft.json`.
//
// THIS test is the cheap, deterministic half: it fails in `pnpm test`, in
// seconds, naming the file — no build required. It asserts the two structural
// halves of the fix:
//
//   1. A module `instrumentation.ts` pulls in does not bind `node:fs` itself.
//      It goes through `lib/test-fixture-file`, which is where the WHY is
//      written down and the only place the marker has to be maintained.
//   2. Every fs call in `lib/test-fixture-file.ts` carries
//      `/* turbopackIgnore: true */`. That module is the sanctioned exception,
//      so an unmarked call added to it is the one way to reintroduce the bug
//      while satisfying (1).
//
// It reaches ONE level: a mock that imported some other module which read a
// file would satisfy both assertions. That is deliberate — the build-time gate
// is what closes the general case, and a guard that tried to walk the import
// graph in a regex would be the kind that gets deleted rather than obeyed.

const ROOT = process.cwd();
const FIXTURE_MODULE = 'lib/test-fixture-file.ts';

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** Strip line and block comments, so a prose mention of `node:fs` never matches. */
const codeOf = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => (m.includes('turbopackIgnore') ? m : ''))
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

/**
 * The modules whose filesystem reads land in `instrumentation.js.nft.json`:
 * everything `instrumentation.ts` imports out of `lib/`, plus every
 * `lib/test-*-mock.ts` — so a mock written but not yet wired in is covered too,
 * and one wired in under a name this pattern does not match is covered anyway.
 */
function subjects(): string[] {
  const instrumentation = codeOf(read('instrumentation.ts'));
  const imported = [...instrumentation.matchAll(/import\(\s*'@\/(lib\/[\w-]+)'\s*\)/g)].map(
    (m) => `${m[1]}.ts`,
  );
  const mocks = readdirSync(join(ROOT, 'lib'))
    .filter((f) => /^test-.*-mock\.ts$/.test(f))
    .map((f) => `lib/${f}`);
  return [...new Set([...imported, ...mocks])].sort();
}

/** The local names a module binds out of `node:fs` / `node:fs/promises`. */
function fsBindings(source: string): string[] {
  const names: string[] = [];
  for (const m of codeOf(source).matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'node:fs(?:\/promises)?'/g,
  )) {
    for (const spec of m[1]!.split(',')) {
      const local = spec
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (local) names.push(local);
    }
  }
  // A namespace or default import binds the whole module under one name.
  for (const m of codeOf(source).matchAll(
    /import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+'node:fs(?:\/promises)?'/g,
  )) {
    names.push(m[1]!);
  }
  return names;
}

describe('nothing instrumentation.ts reaches does its own fs I/O (MOTIR-3219)', () => {
  const files = subjects();

  it('has a non-empty subject set', () => {
    // An empty list would make every assertion below vacuously true — which is
    // precisely the shape a renamed mock or a rewritten instrumentation would
    // produce, and it would read as a pass.
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files).toContain('lib/test-ai-jobs-mock.ts');
    expect(files).toContain('lib/test-code-health-mock.ts');
  });

  it.each(files)('%s binds no node:fs of its own', (file) => {
    expect(fsBindings(read(file))).toEqual([]);
  });
});

describe(`every fs call in ${FIXTURE_MODULE} is marked turbopackIgnore (MOTIR-3219)`, () => {
  const source = read(FIXTURE_MODULE);
  const bindings = fsBindings(source);

  it('binds node:fs — it is the one module that may', () => {
    // If this module stopped importing fs the loop below would assert nothing,
    // so the count is part of the guard rather than a description of it.
    expect(bindings.length).toBeGreaterThanOrEqual(4);
  });

  it.each(bindings)('%s() is called with the ignore comment on its path argument', (name) => {
    const calls = [...codeOf(source).matchAll(new RegExp(`\\b${name}\\s*\\(([^)]*)\\)`, 'g'))];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1]!.trimStart()).toMatch(/^\/\*\s*turbopackIgnore:\s*true\s*\*\//);
    }
  });
});

describe("CI's build job asserts the trace did not widen (MOTIR-3219)", () => {
  // The structural assertions above cannot see a dynamic read reached through
  // one more module, so the build-time gate is the total check — and a workflow
  // file is not type-checked, linted or executed by any other suite, so this is
  // the only thing that keeps the step wired.
  const ci = read('.github/workflows/ci.yml')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('runs the gate after `pnpm build`, in the job that produces .next/server', () => {
    const buildAt = ci.indexOf('run: pnpm build');
    const gateAt = ci.indexOf('run: pnpm assert:nft-trace');
    expect(buildAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(buildAt);
  });

  it('lets the step FAIL — no pipe, no `|| true`', () => {
    // A pipeline reports the LAST command's status, which is how an assertion
    // like this silently stops asserting (`notes.html` #219's shape).
    const step = /^\s*run:\s*(pnpm assert:nft-trace.*)$/m.exec(ci)?.[1] ?? '';
    expect(step).toBe('pnpm assert:nft-trace');
  });

  it('is reachable from package.json', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['assert:nft-trace']).toBe('node scripts/assert-nft-trace-scope.mjs');
  });
});
