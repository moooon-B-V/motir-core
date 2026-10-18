import { describe, expect, it } from 'vitest';
import {
  commandWords,
  isFingerprintedPath,
  workflowFingerprint,
  workflowStructure,
} from '@/lib/ciFleet/workflowFingerprint';

// MOTIR-8870: the digest moves when a runner, a reusable workflow, an action or an
// executable changes, and stays put for the edits that blocked the switch twice.

const CI = '.github/workflows/ci.yml';

function ci(extraSteps = '', runsOn = "${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}"): string {
  return `
name: CI
on: [push]
jobs:
  test:
    runs-on: ${runsOn}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: |
          pnpm test
          pnpm coverage:a
${extraSteps}
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: flyctl deploy
`;
}

const fp = (text: string) => workflowFingerprint([{ path: CI, text }]);

describe('commandWords', () => {
  it('takes the first word of each simple command', () => {
    expect(
      commandWords(
        ['set -euo pipefail', 'A=1 B=2 pnpm test && gh pr list | jq .', 'cd x; make -j4'].join(
          '\n',
        ),
      ).sort(),
    ).toEqual(['cd', 'gh', 'jq', 'make', 'pnpm', 'set']);
  });

  it('skips comments, shell keywords and here-document bodies', () => {
    const script = [
      '# gh would be a tool',
      'if [ -f x ]; then',
      '  cat <<EOF',
      'curl is only text here',
      'EOF',
      'fi',
    ].join('\n');
    expect(commandWords(script).sort()).toEqual(['[', 'cat']);
    expect(commandWords('if gh pr view; then make; fi').sort()).toEqual(['gh', 'make']);
  });

  it('joins a backslash continuation into one command', () => {
    expect(commandWords('docker build \\\n  --tag x \\\n  .')).toEqual(['docker']);
  });

  it('sees a command inside $( ) and backticks', () => {
    expect(commandWords('echo "$(gh api x)"').sort()).toEqual(['echo', 'gh']);
  });
});

describe('workflowFingerprint', () => {
  it('is stable for the same files in any order of keys and files', () => {
    const a = workflowFingerprint([
      { path: CI, text: ci() },
      {
        path: '.github/workflows/b.yml',
        text: 'jobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ls\n',
      },
    ]);
    const b = workflowFingerprint([
      {
        path: '.github/workflows/b.yml',
        text: 'jobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ls\n',
      },
      { path: CI, text: ci() },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not move for a new step that uses only tools the repository already uses', () => {
    const added = `      - name: Coverage (graph-scaling)
        if: \${{ !cancelled() }}
        run: pnpm coverage:graph-scaling
      - uses: pnpm/action-setup@v4
      - run: pnpm exec tsx scripts/x.ts snapshot`;
    expect(fp(ci(added))).toBe(fp(ci()));
  });

  it('does not move for an action version bump, a comment or a changed argument', () => {
    const bumped = ci()
      .replace('checkout@v4', 'checkout@v6')
      .replace('--frozen-lockfile', '--prefer-offline');
    expect(fp(`# note\n${bumped}`)).toBe(fp(ci()));
  });

  it('moves when a job changes its runner', () => {
    expect(fp(ci('', 'ubuntu-latest'))).not.toBe(fp(ci()));
  });

  it('moves when a job is added or removed', () => {
    expect(
      fp(`${ci()}  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm lint\n`),
    ).not.toBe(fp(ci()));
  });

  it('moves for a new executable', () => {
    expect(fp(ci('      - run: gh pr comment 1'))).not.toBe(fp(ci()));
  });

  it('moves for a new action', () => {
    expect(fp(ci('      - uses: docker/setup-qemu-action@v3'))).not.toBe(fp(ci()));
  });

  it('moves for a new shell', () => {
    expect(fp(ci('      - run: print(1)\n        shell: python3 {0}'))).not.toBe(fp(ci()));
  });

  it('moves when a reusable workflow is called', () => {
    const called = `${ci()}  image:\n    uses: ./.github/workflows/image.yml\n`;
    expect(fp(called)).not.toBe(fp(ci()));
  });

  it('reads a local composite action, and ignores every other file', () => {
    const action = '.github/actions/x/action.yml';
    const base = [{ path: CI, text: ci() }];
    const withAction = (run: string) => [
      ...base,
      {
        path: action,
        text: `runs:\n  using: composite\n  steps:\n    - run: ${run}\n      shell: bash\n`,
      },
    ];
    expect(workflowFingerprint(withAction('gh api x'))).not.toBe(
      workflowFingerprint(withAction('ls')),
    );
    expect(workflowFingerprint([...base, { path: 'README.md', text: 'gh' }])).toBe(
      workflowFingerprint(base),
    );
  });

  it('throws on invalid YAML rather than calling it unchanged', () => {
    expect(() => fp('jobs: [unclosed')).toThrow();
  });
});

describe('isFingerprintedPath / workflowStructure', () => {
  it('names the workflow files and composite actions only', () => {
    expect(isFingerprintedPath('.github/workflows/ci.yml')).toBe(true);
    expect(isFingerprintedPath('.github/workflows/ci.yaml')).toBe(true);
    expect(isFingerprintedPath('.github/actions/pnpm/action.yml')).toBe(true);
    expect(isFingerprintedPath('.github/workflows/nested/x.yml')).toBe(false);
    expect(isFingerprintedPath('.github/dependabot.yml')).toBe(false);
  });

  it('records runner and reusable call per job, and the repository-wide sets', () => {
    const s = workflowStructure([
      { path: CI, text: ci(`      - run: print(1)\n        shell: python3 {0}`) },
    ]);
    expect(s.jobs[`${CI}#deploy`]).toEqual({ runsOn: 'ubuntu-latest', calls: null });
    expect(s.actions).toEqual(['actions/checkout', 'pnpm/action-setup']);
    expect(s.commands).toContain('flyctl');
    expect(s.shells).toEqual(['python3 {0}']);
  });
});
