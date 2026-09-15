import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isRegisteredGateKind, UNREGISTERED_GATE_KINDS } from '@/lib/approvalGates/registry';

// THE STORY'S GUARDS (Story MOTIR-4882 · MOTIR-5519, §3) — the properties no coverage
// number can see. (c) and the runtime half of (b) are asserted in the journey
// (`tests/integration/mergeStoryJourney.test.ts`); (e) is
// `tests/approval-gate-one-language.test.ts`.

/** A file with its comments stripped — every guard here asserts an ABSENCE, and these
 *  files discuss exactly those absences in prose. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

/** The modules that may speak GitHub's merge dialect: the provider, and GitHub's own. */
const HOST_LAYERS = ['lib/git/providers/', 'lib/github/'];

/**
 * The E2E seam that IMPERSONATES GitHub's merge API for the acceptance lane
 * (`E2E_TEST_GITHUB_MERGE`, Story MOTIR-4909 · MOTIR-5572). It is GitHub's side of the
 * wire — `instrumentation.ts` mounts it on the MockAgent only under that flag, and it
 * ANSWERS the merge path and the queue mutation rather than making either — so it speaks
 * the dialect by construction. Named by exact path, never by a `lib/test-*` glob: any
 * other file that learns the dialect is still an offence.
 */
const HOST_IMPERSONATORS = ['lib/test-github-merge-mock.ts'];

/**
 * What a GitHub MERGE looks like in source: the REST merge path, the queue mutation, or
 * an import of the provider module (where GitHub's merge response shapes live).
 */
const HOST_MERGE_TELLS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'the pulls/{n}/merge path', pattern: /pulls\/[^\s'"`]*\/merge\b/ },
  { name: 'the enqueuePullRequest mutation', pattern: /\benqueuePullRequest\b/ },
  { name: 'an import of the GitHub provider', pattern: /from\s+'@\/lib\/git\/providers\/github'/ },
];

/** The offences in one file — the detector the guard runs, exported to its own control. */
function hostMergeOffences(path: string, source: string): string[] {
  if (HOST_LAYERS.some((layer) => path.startsWith(layer))) return [];
  if (HOST_IMPERSONATORS.includes(path)) return [];
  const code = codeOf(source);
  return HOST_MERGE_TELLS.filter((tell) => tell.pattern.test(code)).map(
    (tell) => `${path}: ${tell.name}`,
  );
}

describe('guard (a) — no GitHub merge above the provider', () => {
  it('no file outside lib/git/providers/ and lib/github/ names a merge path, the queue mutation or the provider', () => {
    // The search, quoted: `git ls-files lib app components` → every .ts/.tsx, comments
    // stripped, matched against HOST_MERGE_TELLS.
    const files = execFileSync('git', ['ls-files', 'lib', 'app', 'components'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => /\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(100);

    const offences = files.flatMap((f) => hostMergeOffences(f, fs.readFileSync(f, 'utf8')));
    expect(offences).toEqual([]);
  });

  it('the CONTROL — a fetch to pulls/1/merge added under lib/services/ is caught', () => {
    const planted = `export async function mergeIt() {
  await fetch('https://api.github.com/repos/acme/web/pulls/1/merge', { method: 'PUT' });
}`;
    expect(hostMergeOffences('lib/services/plantedService.ts', planted)).toEqual([
      'lib/services/plantedService.ts: the pulls/{n}/merge path',
    ]);
    // …and the same text is legitimate inside the provider.
    expect(hostMergeOffences('lib/git/providers/github.ts', planted)).toEqual([]);
    // …and inside the ONE named impersonator, but not in any other test seam beside it.
    const answered = `reply({ data: { enqueuePullRequest: { mergeQueueEntry: { id } } } });`;
    expect(hostMergeOffences('lib/test-github-merge-mock.ts', answered)).toEqual([]);
    expect(hostMergeOffences('lib/test-github-repos-mock.ts', answered)).toEqual([
      'lib/test-github-repos-mock.ts: the enqueuePullRequest mutation',
    ]);
    // A mention in prose is not an offence.
    expect(
      hostMergeOffences('lib/services/x.ts', '// calls pulls/1/merge through the seam'),
    ).toEqual([]);
  });
});

describe('guard (b) — one status writer: the merge path writes no work_item status', () => {
  it('neither the handler, the entry point nor the auto merge moves a card', () => {
    for (const file of [
      'lib/approvalGates/pullRequestMergeHandler.ts',
      'lib/services/pullRequestMergeService.ts',
      'lib/services/pullRequestAutoMergeService.ts',
    ]) {
      const code = codeOf(fs.readFileSync(file, 'utf8'));
      expect(code, file).not.toMatch(/\bupdateStatus\(|\bapplyStatusTransition\(/);
      expect(code, file).not.toMatch(/workItemRepository\.update\(/);
    }
  });
});

describe('guard (d) — registry totality', () => {
  it('pull_request_merge is a registered kind and not a declared hole', () => {
    expect(isRegisteredGateKind('pull_request_merge')).toBe(true);
    expect(UNREGISTERED_GATE_KINDS).not.toContain('pull_request_merge');
  });
});
