// The LANE DECLARATION reader — one home for "which specs does this Playwright
// config run?", shared by every guard that needs to answer it.
//
// It exists because the answer has exactly one authority — the config's own
// `testDir` + `testMatch` — and a guard that COPIES that glob acquires a second
// one, which drifts silently the moment the config changes. MOTIR-4751 made that
// argument for `tests/e2e-acceptance-lane-imports.test.ts` and parsed the config
// there; MOTIR-4830 needed the same read for `playwright.cloud.config.ts`, so the
// parser moved here rather than being written a second time.
//
// It reaches no filesystem: both functions are pure over text handed to them, so
// nothing that imports them becomes a whole-tree scanner (the predicate
// `tests/ci-structural-guards-lane.test.ts` derives its lane membership from).

/**
 * A Playwright config's own declaration of which files it runs.
 *
 * Parsed from the COMMENT-STRIPPED text: these config headers discuss their
 * globs in prose several times, so a regex over the raw source can match a
 * sentence about the glob instead of the glob.
 */
export function laneDeclarationIn(configSource: string): {
  testDir: string;
  testMatch: string[];
} {
  const code = configSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  const dir = /\btestDir:\s*'([^']+)'/.exec(code);
  const match = /\btestMatch:\s*\[([^\]]*)\]/.exec(code);
  return {
    testDir: dir?.[1] ?? '',
    testMatch: [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    ),
  };
}

/**
 * One glob → one anchored RegExp over a path RELATIVE TO `testDir`, which is
 * what Playwright matches `testMatch` against. `**` spans directory
 * separators, `*` does not.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*' && glob[i + 1] === '*') {
      // `**/` matches zero or more directories; a bare `**` matches anything.
      if (glob[i + 2] === '/') {
        out += '(?:[^/]*\\/)*';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}
