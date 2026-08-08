import { describe, expect, it } from 'vitest';
import {
  ensureSessionBranchOnOrigin,
  execCommand,
  GitError,
  openSessionPr,
  pushSessionBranchIfAhead,
  runIdFromDate,
  sessionBranchCommits,
  sessionBranchHasCommits,
  sessionBranchName,
  type CommandResult,
  type CommandRunner,
} from '../src/git.js';

// The CLI's ONLY git surface (Subtask 7.9.4 · MOTIR-882), gated here (7.9.5).
//
// Every function takes an injectable runner, so the whole decision matrix is
// testable without a repository, a network or `gh`. What matters is not that the
// right strings are produced but that the CLI cannot damage a user's checkout:
// it never checks out, never creates a local branch, never rewinds a session
// branch that already exists, and never merges anything. Each of those is a
// negative assertion on the recorded command log.

/** A runner that answers from a table and records every call. */
function scriptedRunner(answers: (bin: string, args: string[]) => CommandResult | undefined): {
  run: CommandRunner;
  log: string[];
} {
  const log: string[] = [];
  const run: CommandRunner = (bin, args) => {
    log.push(`${bin} ${args.join(' ')}`);
    return answers(bin, args) ?? { exitCode: 0, stdout: '', stderr: '' };
  };
  return { run, log };
}

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = 'boom'): CommandResult => ({ exitCode: 1, stdout: '', stderr });

describe('naming', () => {
  it('stamps a filesystem-and-git-safe run id from a date', () => {
    expect(runIdFromDate(new Date(2026, 6, 29, 1, 2, 3))).toBe('20260729-010203');
    expect(runIdFromDate(new Date(2026, 10, 5, 23, 59, 9))).toBe('20261105-235909');
  });

  it('the session branch carries NO work item key — a session PR spans many items', () => {
    expect(sessionBranchName('20260729-010203')).toBe('motir/auto-20260729-010203');
    expect(sessionBranchName('x')).not.toMatch(/MOTIR-\d+/);
  });
});

describe('execCommand — the production runner', () => {
  it('captures stdout and a zero exit', () => {
    const result = execCommand(
      process.execPath,
      ['-e', 'process.stdout.write("hi")'],
      process.cwd(),
    );
    expect(result).toEqual({ exitCode: 0, stdout: 'hi', stderr: '' });
  });

  it('captures a non-zero exit and stderr instead of throwing', () => {
    const result = execCommand(
      process.execPath,
      ['-e', 'process.stderr.write("nope"); process.exit(4)'],
      process.cwd(),
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toBe('nope');
  });

  it('reports a missing binary as exit 127 rather than throwing', () => {
    const result = execCommand('motir-no-such-binary', [], process.cwd());
    expect(result.exitCode).toBe(127);
    expect(result.stderr).not.toBe('');
  });
});

describe('ensureSessionBranchOnOrigin', () => {
  it('creates the branch from origin/main WITHOUT touching the working tree', () => {
    const { run, log } = scriptedRunner((bin, args) =>
      bin === 'git' && args[0] === 'rev-parse' ? fail('') : ok(),
    );

    expect(ensureSessionBranchOnOrigin('/repo', 'motir/auto-1', run)).toBe('created');
    expect(log).toEqual([
      'git fetch origin',
      'git rev-parse --verify --quiet refs/remotes/origin/motir/auto-1',
      'git push origin refs/remotes/origin/main:refs/heads/motir/auto-1',
    ]);
    // The safety properties, stated as negatives.
    expect(log.some((cmd) => cmd.includes('checkout'))).toBe(false);
    expect(log.some((cmd) => cmd.includes('branch'))).toBe(false);
  });

  it('REUSES a branch that already exists on origin — a resumed run must not rewind it', () => {
    const { run, log } = scriptedRunner(() => ok());

    expect(ensureSessionBranchOnOrigin('/repo', 'motir/auto-1', run)).toBe('already_on_origin');
    expect(log.some((cmd) => cmd.startsWith('git push'))).toBe(false);
  });

  it('raises a GitError naming the step that failed', () => {
    const fetchFails = scriptedRunner((bin, args) =>
      args[0] === 'fetch' ? fail('network down') : ok(),
    );
    expect(() => ensureSessionBranchOnOrigin('/repo', 'b', fetchFails.run)).toThrow(GitError);
    expect(() => ensureSessionBranchOnOrigin('/repo', 'b', fetchFails.run)).toThrow(
      /git fetch origin failed: network down/,
    );

    const pushFails = scriptedRunner((bin, args) => {
      if (args[0] === 'rev-parse') return fail('');
      if (args[0] === 'push') return { exitCode: 2, stdout: '', stderr: '' };
      return ok();
    });
    // No stderr and no stdout → the message falls back to the exit code.
    expect(() => ensureSessionBranchOnOrigin('/repo', 'b', pushFails.run)).toThrow(
      /creating b on origin failed: exit 2/,
    );
  });
});

describe('pushSessionBranchIfAhead', () => {
  it('does nothing when there is no LOCAL branch (the agent used a worktree)', () => {
    const { run, log } = scriptedRunner(() => fail(''));
    expect(pushSessionBranchIfAhead('/repo', 'b', run)).toBe('no_local_branch');
    expect(log).toHaveLength(1);
  });

  it('does nothing when the local branch is already pushed', () => {
    const { run } = scriptedRunner((bin, args) => (args[0] === 'rev-list' ? ok('0') : ok()));
    expect(pushSessionBranchIfAhead('/repo', 'b', run)).toBe('up_to_date');
  });

  it('pushes when the local branch is ahead — the agent that integrated but never pushed', () => {
    const { run, log } = scriptedRunner((bin, args) => (args[0] === 'rev-list' ? ok('2') : ok()));
    expect(pushSessionBranchIfAhead('/repo', 'b', run)).toBe('pushed');
    expect(log).toContain('git push origin b');
  });

  it('pushes when the ahead-count itself could not be read (better to try than to lose work)', () => {
    const { run } = scriptedRunner((bin, args) => {
      if (args[0] === 'rev-list') return fail('no upstream');
      return ok();
    });
    expect(pushSessionBranchIfAhead('/repo', 'b', run)).toBe('pushed');
  });

  it('raises a GitError when the push itself fails', () => {
    const { run } = scriptedRunner((bin, args) => {
      if (args[0] === 'rev-list') return ok('1');
      if (args[0] === 'push') return fail('rejected');
      return ok();
    });
    expect(() => pushSessionBranchIfAhead('/repo', 'b', run)).toThrow(/pushing b failed: rejected/);
  });
});

describe('sessionBranchHasCommits — an empty branch gets no pull request', () => {
  it('is true only for a positive commit count', () => {
    const counted = (stdout: string): boolean =>
      sessionBranchHasCommits('/repo', 'b', scriptedRunner(() => ok(stdout)).run);
    expect(counted('3')).toBe(true);
    expect(counted('0')).toBe(false);
  });

  it('is false when the count cannot be read at all', () => {
    expect(sessionBranchHasCommits('/repo', 'b', scriptedRunner(() => fail()).run)).toBe(false);
  });
});

describe("sessionBranchCommits — the agents' own messages (MOTIR-2411)", () => {
  // ⚠️ THE RECORD SEPARATORS ARE THE POINT. A commit body is arbitrary prose and
  // will eventually contain any printable marker someone picks — `---`, `===`,
  // a row of dashes in a table. `%x1f` / `%x1e` are control characters git emits
  // literally and no author types, so the parse cannot be broken by content.
  const RS = '\x1e';
  const FS = '\x1f';

  it('splits subject from body, OLDEST first', () => {
    const log = `feat(a): first${FS}Because the old path was wrong.${RS}\nfix(b): second${FS}And B needed it.${RS}\n`;
    const commits = sessionBranchCommits('/repo', 'b', scriptedRunner(() => ok(log)).run);

    expect(commits).toEqual([
      { subject: 'feat(a): first', body: 'Because the old path was wrong.' },
      { subject: 'fix(b): second', body: 'And B needed it.' },
    ]);
  });

  it("reads the range in THIS repo's cwd against THIS repo's branch", () => {
    // The multi-repo scoping, asserted on the CWD the command ran in — a run
    // opens one pull request per repo, and a range read anywhere else would put
    // another repo's commits in this body. `scriptedRunner`'s log drops the cwd,
    // and the cwd is the whole claim, so this one records it.
    const seen: { cwd: string; args: string[] }[] = [];
    const run: CommandRunner = (_bin, args, cwd) => {
      seen.push({ cwd, args });
      return ok('');
    };
    sessionBranchCommits('/repos/motir-ai', 'motir/auto-9', run);

    expect(seen[0]?.cwd).toBe('/repos/motir-ai');
    expect(seen[0]?.args).toContain('origin/main..origin/motir/auto-9');
    expect(seen[0]?.args).toContain('--reverse');
  });

  it('a commit with NO body yields an empty body, not a missing entry', () => {
    const commits = sessionBranchCommits(
      '/repo',
      'b',
      scriptedRunner(() => ok(`chore: thin${FS}${RS}\n`)).run,
    );
    expect(commits).toEqual([{ subject: 'chore: thin', body: '' }]);
  });

  it('a body containing the marker-ish prose a human writes survives', () => {
    const body = 'Rejected:\n\n---\n\n| a | b |\n| --- | --- |\n';
    const commits = sessionBranchCommits(
      '/repo',
      'b',
      scriptedRunner(() => ok(`feat: x${FS}${body}${RS}\n`)).run,
    );
    expect(commits).toHaveLength(1);
    expect(commits[0]!.body).toContain('| --- | --- |');
  });

  it('a FAILED read is an empty list, never a throw', () => {
    // By the time this runs the work is integrated and pushed. A git hiccup must
    // degrade the body, not abandon the pull request — the same discipline
    // `openSessionPr` applies to a missing `gh`.
    expect(sessionBranchCommits('/repo', 'b', scriptedRunner(() => fail()).run)).toEqual([]);
  });

  it('an empty range is an empty list', () => {
    expect(sessionBranchCommits('/repo', 'b', scriptedRunner(() => ok('')).run)).toEqual([]);
  });
});

describe('openSessionPr — reported, never thrown', () => {
  const input = { branch: 'motir/auto-1', title: 'Motir auto run', body: 'the body' };

  it('returns the EXISTING pull request rather than opening a second one', () => {
    const { run, log } = scriptedRunner((bin, args) =>
      args[1] === 'list' ? ok('https://github.test/pull/7') : ok(),
    );

    expect(openSessionPr('/repo', input, run)).toEqual({
      url: 'https://github.test/pull/7',
      outcome: 'existing',
    });
    expect(log.some((cmd) => cmd.includes('pr create'))).toBe(false);
  });

  it('opens one and reads the URL off gh’s last line', () => {
    const { run, log } = scriptedRunner((bin, args) => {
      if (args[1] === 'list') return ok('');
      if (args[1] === 'create') return ok('Creating pull request…\nhttps://github.test/pull/9\n');
      return ok();
    });

    expect(openSessionPr('/repo', input, run)).toEqual({
      url: 'https://github.test/pull/9',
      outcome: 'opened',
    });
    // Against main, from the session branch — and NEVER a merge.
    expect(log.some((cmd) => cmd.includes('--base main'))).toBe(true);
    expect(log.some((cmd) => cmd.includes('pr merge'))).toBe(false);
  });

  it('REPORTS a gh failure with the manual fallback instead of throwing away the run', () => {
    const { run } = scriptedRunner((bin, args) => {
      if (args[1] === 'list') return ok('');
      return { exitCode: 127, stdout: '', stderr: 'gh: command not found' };
    });

    const result = openSessionPr('/repo', input, run);
    expect(result.outcome).toBe('failed');
    expect(result.url).toBeNull();
    expect(result.message).toContain('gh: command not found');
  });

  it('falls back to the exit code when gh says nothing at all', () => {
    const { run } = scriptedRunner((bin, args) =>
      args[1] === 'list' ? ok('') : { exitCode: 3, stdout: '', stderr: '' },
    );
    expect(openSessionPr('/repo', input, run).message).toContain('gh exited 3');
  });

  it('treats an unreadable `pr list` as "no existing PR" and opens one', () => {
    const { run } = scriptedRunner((bin, args) => {
      if (args[1] === 'list') return fail('not authenticated');
      return ok('https://github.test/pull/11');
    });
    expect(openSessionPr('/repo', input, run).outcome).toBe('opened');
  });

  it('reports a created PR with no URL on stdout as opened-without-a-link', () => {
    const { run } = scriptedRunner((bin, args) => (args[1] === 'list' ? ok('') : ok('')));
    expect(openSessionPr('/repo', input, run)).toEqual({ url: null, outcome: 'opened' });
  });
});
