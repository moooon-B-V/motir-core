import { beforeAll, describe, expect, it } from 'vitest';

import {
  filesForIncludePattern,
  filesForThresholdKey,
  includePatterns,
  reportableFiles,
  thresholdKeys,
} from './helpers/coverageGate';

/**
 * MOTIR-2449 — the coverage gate's own guard.
 *
 * A per-file threshold that matches NO file is not an error in Vitest:
 * `resolveThresholds` builds an empty coverage map for that glob and every
 * percentage on an empty map passes. So an entry somebody wrote on purpose can
 * stop protecting its file — or never protect it at all — while the config
 * still reads as protection in review and CI stays green. That is the one
 * failure mode a coverage gate cannot survive, because the whole value of the
 * gate is in the files nobody is currently looking at.
 *
 * Twenty entries were in exactly that state before this test existed: a Next.js
 * route group is a literal `(authed)` directory, but `(` is grouping syntax to
 * the matcher, so `app/(authed)/…` resolved to nothing. Rewriting the twenty
 * paths fixes twenty files; failing the build on an unmatched key is what fixes
 * the class — including the case where a path is correct today and silently
 * stops matching when a directory is renamed or a route group is introduced.
 */
describe('the coverage gate resolves every pattern it names', () => {
  // ⚠️ Glob ONCE, and give that one call a budget of its own.
  //
  // `reportableFiles()` resolves the whole `coverage.include` set against the
  // tree and is memoised at module scope, so every case below is a cache hit —
  // but the FIRST case pays it, and `vitest.config.ts`'s `testTimeout` is 15 s,
  // sized for a database test rather than a whole-tree glob. Under `vitest run
  // --coverage` the v8 provider instruments every module the resolution touches,
  // and on a CI runner with three shards competing for the box that first case
  // times out while passing locally — a failure that reads as a broken guard
  // rather than a slow one (MOTIR-2815; the same shape `tests/rls/
  // test-call-site-guard.test.ts` and `test-singleton-statement-guard.test.ts`
  // hit, and the same remedy they took).
  //
  // Hoisting it here does not weaken an assertion: every `expect` below is
  // unchanged and still fails on a pattern that reaches no file. It moves the
  // cost to the one place that can honestly carry a budget.
  beforeAll(async () => {
    await reportableFiles();
  }, 60_000);

  it('has no `coverage.include` pattern that resolves to no file', async () => {
    const dead: string[] = [];
    for (const pattern of includePatterns) {
      if ((await filesForIncludePattern(pattern)).length === 0) dead.push(pattern);
    }

    expect(
      dead,
      `These \`coverage.include\` patterns match no file on disk, so the files they name are ` +
        `absent from every coverage report:\n  ${dead.join('\n  ')}\n` +
        `Either the file moved (fix the path) or the pattern is unresolvable — a Next.js route ` +
        `group must be written as \`app/**/…\`, never the literal \`app/(authed)/…\`, because ` +
        `the parentheses are grouping syntax to the matcher.`,
    ).toEqual([]);
  });

  it('has no `coverage.thresholds` key that gates no file', async () => {
    const dead: string[] = [];
    for (const key of thresholdKeys) {
      if ((await filesForThresholdKey(key)).length === 0) dead.push(key);
    }

    expect(
      dead,
      `These \`coverage.thresholds\` keys match no file in the coverage report, so they gate ` +
        `NOTHING and pass unconditionally:\n  ${dead.join('\n  ')}\n` +
        `A key only gates a file that \`coverage.include\` also resolves to — check both halves, ` +
        `and write a route group as \`app/**/…\` rather than \`app/(authed)/…\`.`,
    ).toEqual([]);
  });

  it('reports the route-group components the literal-path form used to hide', async () => {
    const files = await reportableFiles();

    expect(files).toEqual(
      expect.arrayContaining([
        'app/(authed)/settings/account/_components/ConnectCliPanel.tsx',
        'app/(authed)/settings/project/code-access/_components/CodeAccessSettings.tsx',
        'app/(authed)/settings/project/repositories/_components/RepositoriesRoom.tsx',
        'app/(auth)/device/_components/DeviceApproval.tsx',
        'app/(public)/docs/sandbox/page.tsx',
      ]),
    );
  });

  it('proves the literal route-group path is what fails, so nobody writes it back', async () => {
    const component = 'app/(authed)/settings/account/_components/ConnectCliPanel.tsx';

    // The file exists at exactly this path…
    expect(await reportableFiles()).toContain(component);
    // …and naming it verbatim still resolves to nothing.
    expect(await filesForIncludePattern(component)).toEqual([]);
    // The wildcard form is what reaches it.
    expect(
      await filesForIncludePattern('app/**/settings/account/_components/ConnectCliPanel.tsx'),
    ).toEqual([component]);
  });
});
