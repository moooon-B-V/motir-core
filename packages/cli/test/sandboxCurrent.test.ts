import { describe, expect, it } from 'vitest';
// A zero-dependency script, deliberately `.mjs` — it runs on a bare runner with
// no install and no build step, and a human can node it from any shell. Its
// typed contract lives beside it in `assert-current.d.mts`.
import {
  assessRelease,
  collectAndAssess,
  compareVersions,
  parseReleaseTags,
  parseVersion,
  main,
  DEFAULT_MAX_DRIFT_DAYS,
  DEFAULT_WATCH_PATHS,
  TAG_PREFIX,
  type AssertCurrentIo,
  type DriftCommit,
  type StalenessResult,
} from '../sandbox/smoke/assert-current.mjs';

// The staleness tripwire (MOTIR-2131). The defect it exists for: `cli-v0.1.0`
// sat eleven commits behind `main` for five days while every internal signal
// stayed green, so the only image anyone could pull printed a credential banner
// naming one of three tiers and `motir login` was not in it at all.
//
// What this suite is FOR. A tripwire that is itself wrong is worse than none —
// it reads as coverage. Two wrong answers matter more than the rest and each
// has its own case below: reporting `current` when the range could not be
// walked (a shallow clone answers "no commits", which looks exactly like up to
// date), and going red on the first merge after a release (which gets the check
// muted within a week, and a muted check is indistinguishable from a passing
// one).
//
// TIME IS INJECTED EVERYWHERE. Every case that ages a commit passes its own
// `now`; nothing here compares a fixture against the wall clock, which is the
// shape that passes until the day it silently does not.

/** A fixed "today" every dated case is measured against. */
const NOW = new Date('2026-08-04T12:00:00.000Z');

/** A commit `days` before {@link NOW}. */
const commitAgedDays = (days: number, subject = 'feat(cli): something'): DriftCommit => ({
  sha: `${days}`.padStart(40, 'a'),
  date: new Date(NOW.getTime() - days * 86_400_000).toISOString(),
  subject,
});

describe('version parsing and ordering', () => {
  it('parses a release version and rejects anything that is not one', () => {
    expect(parseVersion('0.1.1')).toMatchObject({ major: 0, minor: 1, patch: 1, prerelease: null });
    expect(parseVersion('1.2.3-rc.1')).toMatchObject({ prerelease: 'rc.1' });
    // A stray tag must be ignored rather than sorted somewhere arbitrary.
    for (const junk of ['next', '', '1.2', 'v1.2.3', null, undefined, '1.2.3.4']) {
      expect(parseVersion(junk)).toBeNull();
    }
  });

  it('orders numerically, not lexically', () => {
    // The trap this exists for: `0.10.0` sorts BELOW `0.9.0` as a string, so a
    // lexical sort would name the wrong release as newest for every project
    // that reaches a tenth minor.
    const a = parseVersion('0.10.0')!;
    const b = parseVersion('0.9.0')!;
    expect(compareVersions(a, b)).toBe(1);
    expect(compareVersions(b, a)).toBe(-1);
    expect(compareVersions(a, parseVersion('0.10.0')!)).toBe(0);
  });

  it('sorts a prerelease BELOW the release it precedes', () => {
    expect(compareVersions(parseVersion('0.2.0-rc.1')!, parseVersion('0.2.0')!)).toBe(-1);
    expect(compareVersions(parseVersion('0.2.0')!, parseVersion('0.2.0-rc.1')!)).toBe(1);
  });

  it('takes only cli-v* release tags, newest first, ignoring the rest', () => {
    const tags = parseReleaseTags([
      'cli-v0.1.0',
      'design-system-v2.0.0', // another package's lane — not ours
      'cli-vnext', // not a version
      'cli-v0.10.0',
      'cli-v0.2.0',
      '',
    ]);
    expect(tags.map((t) => t.tag)).toEqual(['cli-v0.10.0', 'cli-v0.2.0', 'cli-v0.1.0']);
  });
});

describe('the verdict', () => {
  it('is CURRENT when nothing has touched the watched paths since the tag', () => {
    const result = assessRelease({
      packageVersion: '0.1.1',
      tags: ['cli-v0.1.1'],
      commits: [],
      now: NOW,
    });
    expect(result).toMatchObject({ verdict: 'current', exitCode: 0, latestTag: 'cli-v0.1.1' });
  });

  it('is DRIFTING — and exits 0 — while the oldest commit is inside the window', () => {
    // The load-bearing case. Drift is expected: `release-sandbox.yml` has no
    // push-to-main trigger on purpose. A check that went red here would be
    // muted inside a week, and a muted tripwire reads as coverage.
    const result = assessRelease({
      packageVersion: '0.1.1',
      tags: ['cli-v0.1.1'],
      commits: [commitAgedDays(2), commitAgedDays(1)],
      now: NOW,
    });
    expect(result.verdict).toBe('drifting');
    expect(result.exitCode).toBe(0);
    // ...but the number is still REPORTED, so it is visible before it is fatal.
    expect(result.commitCount).toBe(2);
    expect(result.oldestAgeDays).toBe(2);
  });

  it('is STALE once the OLDEST unreleased commit passes the window', () => {
    const result = assessRelease({
      packageVersion: '0.1.1',
      tags: ['cli-v0.1.1'],
      // Ages deliberately out of order: the verdict turns on the oldest, not on
      // whichever git happened to list first.
      commits: [commitAgedDays(1), commitAgedDays(30), commitAgedDays(3)],
      now: NOW,
    });
    expect(result.verdict).toBe('stale');
    expect(result.exitCode).toBe(1);
    expect(result.oldestAgeDays).toBe(30);
    expect(result.summary).toContain('30 days');
  });

  it('measures the boundary by the oldest commit, exclusive of the limit itself', () => {
    const at = (days: number): StalenessResult =>
      assessRelease({
        packageVersion: '0.1.1',
        tags: ['cli-v0.1.1'],
        commits: [commitAgedDays(days)],
        now: NOW,
        maxDriftDays: 7,
      });
    // Exactly at the limit is still inside it; a day past is not. Pinned
    // because "> vs >=" here is the difference between a check that fires on
    // schedule and one that fires a day early, every time.
    expect(at(7).verdict).toBe('drifting');
    expect(at(8).verdict).toBe('stale');
  });

  it('honours a caller-supplied window', () => {
    const commits = [commitAgedDays(3)];
    expect(
      assessRelease({ packageVersion: '0.1.1', tags: ['cli-v0.1.1'], commits, now: NOW }).verdict,
    ).toBe('drifting');
    expect(
      assessRelease({
        packageVersion: '0.1.1',
        tags: ['cli-v0.1.1'],
        commits,
        now: NOW,
        maxDriftDays: 1,
      }).verdict,
    ).toBe('stale');
  });

  it('is UNTAGGED-BUMP when package.json is ahead of the newest tag', () => {
    // The other half of the check, and a different remedy: nothing is stale,
    // the release is half-cut. Its summary must name the tag to push.
    const result = assessRelease({
      packageVersion: '0.1.1',
      tags: ['cli-v0.1.0'],
      commits: [commitAgedDays(1)],
      now: NOW,
    });
    expect(result.verdict).toBe('untagged-bump');
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain('cli-v0.1.1');
  });

  it('is VERSION-BEHIND-TAG when package.json went backwards past a release', () => {
    const result = assessRelease({
      packageVersion: '0.1.0',
      tags: ['cli-v0.1.0', 'cli-v0.2.0'],
      commits: [],
      now: NOW,
    });
    expect(result.verdict).toBe('version-behind-tag');
    expect(result.exitCode).toBe(1);
    // The opposite remedy from untagged-bump — pushing a tag here would be the
    // wrong fix attempted first, so the summary must say not to.
    expect(result.summary).toContain('Do not re-tag');
  });

  it('would have CAUGHT MOTIR-2131 AT ITS DEFAULT — a matching version is not enough', () => {
    // The regression this whole file exists for, replayed with the real
    // numbers. On 2026-08-04 the version was 0.1.0 and the newest tag was
    // cli-v0.1.0: a version-only guard sees a perfect match and passes. Eleven
    // commits had landed, the oldest five days earlier, so the *drift* arm is
    // what has to fire.
    //
    // NO maxDriftDays HERE, deliberately. The first draft of this suite passed
    // an override and went green while the shipped default (a week) returned
    // exit 0 against the very tree in the card — a test that proves the check
    // can be configured to work rather than that it does. The default is the
    // thing under test.
    const elevenCommits = Array.from({ length: 11 }, (_, i) => commitAgedDays(5 - i * 0.4));
    const result = assessRelease({
      packageVersion: '0.1.0',
      tags: ['cli-v0.1.0'],
      commits: elevenCommits,
      now: NOW,
    });
    expect(result.verdict).toBe('stale');
    expect(result.exitCode).toBe(1);
    expect(result.commitCount).toBe(11);
    expect(result.oldestAgeDays).toBe(5);
  });

  it('counts commits it cannot date, and does not age them into a failure', () => {
    // A commit with an unparseable date still counts as drift — it is real
    // unreleased work — but it cannot push the age past a window, because
    // guessing a date would be inventing the evidence the verdict rests on.
    const result = assessRelease({
      packageVersion: '0.1.1',
      tags: ['cli-v0.1.1'],
      commits: [{ sha: 'a'.repeat(40), date: 'not-a-date', subject: 'chore: x' }],
      now: NOW,
    });
    expect(result.commitCount).toBe(1);
    expect(result.oldestAgeDays).toBeNull();
    expect(result.exitCode).toBe(0);
  });
});

describe('the arms that refuse to answer', () => {
  it('reports NEVER-RELEASED rather than a staleness verdict when no tag exists', () => {
    // A tagless checkout (a shallow CI clone, a fresh fork) is not a repository
    // that is behind, and calling it one would train everyone to ignore the
    // check on day one.
    const result = assessRelease({ packageVersion: '0.1.0', tags: [], now: NOW });
    expect(result).toMatchObject({ verdict: 'never-released', exitCode: 2 });
    expect(result.summary).toContain('fetch-depth: 0');
  });

  it('reports UNREADABLE when package.json declares no usable version', () => {
    for (const version of [undefined, null, '', 'not-a-version']) {
      expect(
        assessRelease({ packageVersion: version, tags: ['cli-v0.1.0'], now: NOW }),
      ).toMatchObject({ verdict: 'unreadable', exitCode: 2 });
    }
  });
});

/** An io whose git reads are fakes, with per-case overrides. */
const fakeIo = (
  over: Partial<AssertCurrentIo> & { lines?: string[] } = {},
): AssertCurrentIo & { lines: string[]; errors: string[] } => {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    readVersion: async () => '0.1.1',
    listTags: async () => ['cli-v0.1.1'],
    commitsBetween: async () => [],
    now: () => NOW,
    log: (line: string) => lines.push(line),
    error: (line: string) => errors.push(line),
    ...over,
    lines,
    errors,
  };
};

describe('collecting from a repository', () => {
  it('walks the range from the NEWEST tag, over the watched paths', async () => {
    const seen: Array<[string, string, string[]]> = [];
    const result = await collectAndAssess(
      fakeIo({
        listTags: async () => ['cli-v0.1.0', 'cli-v0.1.1'],
        commitsBetween: async (tag, ref, paths) => {
          seen.push([tag, ref, paths]);
          return [];
        },
      }),
    );
    expect(seen).toEqual([['cli-v0.1.1', 'HEAD', DEFAULT_WATCH_PATHS]]);
    expect(result.verdict).toBe('current');
    expect(result.watchedPaths).toEqual(DEFAULT_WATCH_PATHS);
  });

  it('passes an explicit ref and path set through', async () => {
    const seen: Array<[string, string, string[]]> = [];
    await collectAndAssess(
      fakeIo({
        commitsBetween: async (tag, ref, paths) => {
          seen.push([tag, ref, paths]);
          return [];
        },
      }),
      { ref: 'origin/main', paths: ['packages/cli', 'pnpm-lock.yaml'] },
    );
    expect(seen).toEqual([['cli-v0.1.1', 'origin/main', ['packages/cli', 'pnpm-lock.yaml']]]);
  });

  it('refuses to answer when the RANGE cannot be walked — never "current"', async () => {
    // The most dangerous wrong answer available to this script. A shallow clone
    // makes `git log <tag>..HEAD` fail or come back empty; reporting 0 commits
    // would render as `current` and quietly assert the opposite of the truth.
    const result = await collectAndAssess(
      fakeIo({
        commitsBetween: async () => {
          throw new Error('fatal: bad revision');
        },
      }),
    );
    expect(result.verdict).toBe('unreadable');
    expect(result.exitCode).toBe(2);
    expect(result.summary).toContain('shallow');
  });

  it('refuses to answer when the repository itself cannot be read', async () => {
    const result = await collectAndAssess(
      fakeIo({
        readVersion: async () => {
          throw new Error('ENOENT');
        },
      }),
    );
    expect(result).toMatchObject({ verdict: 'unreadable', exitCode: 2 });
  });

  it('does not try to walk a range when there is no tag to walk from', async () => {
    let walked = false;
    const result = await collectAndAssess(
      fakeIo({
        listTags: async () => [],
        commitsBetween: async () => {
          walked = true;
          return [];
        },
      }),
    );
    expect(walked).toBe(false);
    expect(result.verdict).toBe('never-released');
  });
});

describe('the CLI', () => {
  it('returns the verdict exit code and annotates a failure for the runner', async () => {
    const io = fakeIo({
      readVersion: async () => '0.1.0',
      listTags: async () => ['cli-v0.1.0'],
      commitsBetween: async () => [commitAgedDays(90)],
    });
    await expect(main([], io)).resolves.toBe(1);
    expect(io.errors.join('\n')).toContain('::error::');
    // The commits themselves, not just the count: the reader's next question is
    // always "behind by WHAT", and answering it turns a red check into a
    // release decision rather than an investigation.
    expect(io.lines.join('\n')).toContain('feat(cli): something');
  });

  it('downgrades a could-not-tell to a WARNING, not an error', async () => {
    const io = fakeIo({ listTags: async () => [] });
    await expect(main([], io)).resolves.toBe(2);
    expect(io.errors.join('\n')).toContain('::warning::');
    expect(io.errors.join('\n')).not.toContain('::error::');
  });

  it('is quiet and green when the release is current', async () => {
    const io = fakeIo();
    await expect(main([], io)).resolves.toBe(0);
    expect(io.errors).toEqual([]);
  });

  it('accepts --max-age-days, --paths, --ref and --json', async () => {
    const seen: Array<[string, string, string[]]> = [];
    const io = fakeIo({
      commitsBetween: async (tag, ref, paths) => {
        seen.push([tag, ref, paths]);
        return [commitAgedDays(3)];
      },
    });
    await expect(
      main(
        ['--max-age-days', '1', '--paths', 'packages/cli,Dockerfile', '--ref', 'main', '--json'],
        io,
      ),
    ).resolves.toBe(1);
    expect(seen).toEqual([['cli-v0.1.1', 'main', ['packages/cli', 'Dockerfile']]]);
    // --json emits ONE parseable document, so a caller can pipe it.
    const parsed: StalenessResult = JSON.parse(io.lines.join('\n'));
    expect(parsed.verdict).toBe('stale');
  });

  it('truncates a very long drift list rather than printing hundreds of lines', async () => {
    const io = fakeIo({
      commitsBetween: async () => Array.from({ length: 25 }, (_, i) => commitAgedDays(1, `c${i}`)),
    });
    await main([], io);
    expect(io.lines.join('\n')).toContain('and 5 more');
  });
});

describe('the defaults it publishes', () => {
  it('names the package-scoped tag prefix and a sane window', () => {
    // A bare `v*` would fire for the app too — the tag prefix is load-bearing,
    // and both release lanes key on this exact string.
    expect(TAG_PREFIX).toBe('cli-v');
    expect(DEFAULT_WATCH_PATHS).toContain('packages/cli');
    // Not "greater than zero" — that would have passed for the week-long
    // window that let MOTIR-2131 through. The window has to sit BELOW the only
    // observed detection time there is: a human found that image stale on day
    // five by pulling it and reading what it printed. A default at or above
    // five means the tripwire always loses that race.
    expect(DEFAULT_MAX_DRIFT_DAYS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_DRIFT_DAYS).toBeLessThan(5);
  });
});
