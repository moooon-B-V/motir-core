import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PUBLISHED_PACKAGES,
  deriveTags,
  formatPlan,
  introducedAt,
  pinTags,
} from '../../scripts/releaseTags.mjs';

// MOTIR-7717 — a tag goes on the commit that SET its version, never on `HEAD`.
//
// The lane used to tag only when the changesets sync found nothing pending,
// treating that as "the Version Packages pull request just merged". A changeset
// that reached `main` before the merge made the merge run report a pending
// changeset, skip the tag step and stay green: 0.9.0 / 0.4.0 were never
// published. Tagging now runs on every push, so `HEAD` can carry source whose
// changeset is still pending — and a tag there would publish it under the older
// number. The first half of this file pins the pure walk; the second half runs
// the real runner against a real git history in a temporary repository, which
// is the only place "the commit that moved the version" means anything.

const RUNNER = join(process.cwd(), 'scripts/push-release-tags.mjs');

type Pkg = { name: string; dir: string; tagPrefix: string; lane: string };
const PACKAGES = PUBLISHED_PACKAGES as Pkg[];

describe('introducedAt — the walk back to the commit that set a version', () => {
  const at =
    (versions: Record<string, string | undefined>) =>
    (sha: string): unknown =>
      versions[sha];

  it('returns the oldest commit of the newest run declaring the version', () => {
    // Newest first: c3 bumped a dependency, c2 moved the version, c1 is older.
    const sha = introducedAt({
      version: '0.9.0',
      shas: ['c3', 'c2', 'c1'],
      versionAt: at({ c3: '0.9.0', c2: '0.9.0', c1: '0.8.2' }),
    });
    expect(sha).toBe('c2');
  });

  it('returns the creating commit when the version never changed', () => {
    expect(
      introducedAt({
        version: '0.1.0',
        shas: ['c2', 'c1'],
        versionAt: at({ c2: '0.1.0', c1: '0.1.0' }),
      }),
    ).toBe('c1');
  });

  it('stops at the first different version rather than finding an older equal one', () => {
    // A version that was left and came back is owed on its RETURN, not on the
    // first time it appeared.
    expect(
      introducedAt({
        version: '1.0.0',
        shas: ['c4', 'c3', 'c2', 'c1'],
        versionAt: at({ c4: '1.0.0', c3: '1.1.0-rc.0', c2: '1.0.0', c1: '0.9.0' }),
      }),
    ).toBe('c4');
  });

  it('returns null when the newest commit does not declare the version', () => {
    expect(
      introducedAt({ version: '2.0.0', shas: ['c1'], versionAt: at({ c1: '1.0.0' }) }),
    ).toBeNull();
    expect(introducedAt({ version: '2.0.0', shas: [], versionAt: at({}) })).toBeNull();
  });
});

describe('pinTags — a tag with no commit is REFUSED, never defaulted to HEAD', () => {
  const plan = deriveTags({
    versions: { '@motir/cli': '0.4.0', '@motir/brand': '0.2.1', '@motir/design-system': '0.1.2' },
    existingTags: ['runner-v1.0.0', 'cli-v0.4.0'],
  });

  it('carries the located commit on every created tag and names it in the report', () => {
    const pinned = pinTags(plan, ({ name }: { name: string }) =>
      name === '@motir/brand' ? 'b'.repeat(40) : 'd'.repeat(40),
    );
    expect(pinned.problems).toEqual([]);
    expect(pinned.create.map((t: { tag: string; commit: string }) => [t.tag, t.commit])).toEqual([
      ['brand-v0.2.1', 'b'.repeat(40)],
      ['design-system-v0.1.2', 'd'.repeat(40)],
    ]);
    expect(pinned.skipped.map((t: { tag: string }) => t.tag)).toEqual(['cli-v0.4.0']);
    expect(formatPlan(pinned)).toContain(`tag      brand-v0.2.1 at ${'b'.repeat(12)}`);
  });

  it('moves a tag whose commit cannot be found into the problems', () => {
    const pinned = pinTags(plan, ({ name }: { name: string }) =>
      name === '@motir/brand' ? null : 'd'.repeat(40),
    );
    expect(pinned.create.map((t: { tag: string }) => t.tag)).toEqual(['design-system-v0.1.2']);
    expect(pinned.problems).toHaveLength(1);
    expect(pinned.problems[0]).toContain('brand-v0.2.1');
    expect(pinned.problems[0]).toContain('refusing to guess');
  });
});

describe('push-release-tags --dry-run against a real history (MOTIR-7717)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** A throwaway repository holding the three published manifests. */
  function repo(): { dir: string; git: (...args: string[]) => string } {
    const dir = mkdtempSync(join(tmpdir(), 'motir-release-tags-'));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    git('init', '-q', '-b', 'main');
    return { dir, git };
  }

  function writeVersion(
    dir: string,
    pkg: Pkg,
    version: string,
    extra: Record<string, unknown> = {},
  ) {
    mkdirSync(join(dir, pkg.dir), { recursive: true });
    writeFileSync(
      join(dir, pkg.dir, 'package.json'),
      `${JSON.stringify({ name: pkg.name, version, ...extra }, null, 2)}\n`,
    );
  }

  /** Commit the three manifests at 1.0.0 and tag them, as a released baseline. */
  function released(dir: string, git: (...args: string[]) => string): void {
    for (const pkg of PACKAGES) writeVersion(dir, pkg, '1.0.0');
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');
    for (const pkg of PACKAGES) git('tag', `${pkg.tagPrefix}1.0.0`);
  }

  const dryRun = (dir: string, ...args: string[]) =>
    execFileSync('node', [RUNNER, '--dry-run', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
    });

  const planned = (out: string) =>
    out
      .split('\n')
      .filter((l) => l.startsWith('--dry-run: would push '))
      .map((l) => l.replace('--dry-run: would push ', ''));

  it('plans a moved version’s tag on the commit that moved it, not on a later HEAD', () => {
    const { dir, git } = repo();
    released(dir, git);

    // The Version Packages merge: brand moves to 1.1.0.
    const brand = PACKAGES.find((p) => p.name === '@motir/brand')!;
    writeVersion(dir, brand, '1.1.0');
    git('add', '-A');
    git('commit', '-q', '-m', 'Version Packages');
    const versionCommit = git('rev-parse', 'HEAD');

    // A later, unrelated change whose changeset is still pending — the source a
    // tag on HEAD would publish under 1.1.0.
    mkdirSync(join(dir, brand.dir, 'src'), { recursive: true });
    writeFileSync(join(dir, brand.dir, 'src/index.js'), 'export const later = true;\n');
    writeFileSync(join(dir, 'pending.md'), '---\n"@motir/brand": patch\n---\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'an unrelated change');
    const head = git('rev-parse', 'HEAD');
    expect(head).not.toBe(versionCommit);

    const out = dryRun(dir);
    expect(planned(out)).toEqual([`brand-v1.1.0 at ${versionCommit}`]);
    expect(planned(out).join('\n')).not.toContain(head);
  });

  it('skips a commit that touched the manifest without moving the version', () => {
    const { dir, git } = repo();
    released(dir, git);
    const ds = PACKAGES.find((p) => p.name === '@motir/design-system')!;

    writeVersion(dir, ds, '1.2.0');
    git('add', '-A');
    git('commit', '-q', '-m', 'Version Packages');
    const versionCommit = git('rev-parse', 'HEAD');

    // Same version, manifest edited again (a dependency bump).
    writeVersion(dir, ds, '1.2.0', { dependencies: { leftpad: '1.0.0' } });
    git('add', '-A');
    git('commit', '-q', '-m', 'bump a dependency');

    expect(planned(dryRun(dir))).toEqual([`design-system-v1.2.0 at ${versionCommit}`]);
  });

  it('reads the versions at --ref, not from a working tree that has moved on', () => {
    // In the lane, `changesets/action` leaves the checkout on
    // `changeset-release/main` with the NEXT versions written in. Those have not
    // merged and must not be tagged.
    const { dir, git } = repo();
    released(dir, git);
    const mainSha = git('rev-parse', 'HEAD');
    const cli = PACKAGES.find((p) => p.name === '@motir/cli')!;
    git('checkout', '-q', '-b', 'changeset-release/main');
    writeVersion(dir, cli, '2.0.0');
    git('add', '-A');
    git('commit', '-q', '-m', 'Version Packages (unmerged)');

    expect(planned(dryRun(dir, '--ref', mainSha))).toEqual([]);
  });

  it('plans the tag on the merge commit when the version arrived through a merge', () => {
    const { dir, git } = repo();
    released(dir, git);
    const cli = PACKAGES.find((p) => p.name === '@motir/cli')!;
    git('checkout', '-q', '-b', 'changeset-release/main');
    writeVersion(dir, cli, '1.0.1');
    git('add', '-A');
    git('commit', '-q', '-m', 'Version Packages');
    git('checkout', '-q', 'main');
    writeFileSync(join(dir, 'other.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'meanwhile on main');
    git('merge', '-q', '--no-ff', '-m', 'Merge Version Packages', 'changeset-release/main');
    const merge = git('rev-parse', 'HEAD');

    expect(planned(dryRun(dir, '--ref', 'main'))).toEqual([`cli-v1.0.1 at ${merge}`]);
  });

  it('plans NOTHING when no version moved — re-running the step is a no-op', () => {
    const { dir, git } = repo();
    released(dir, git);
    writeFileSync(join(dir, 'README.md'), 'unrelated\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'an unrelated change');

    const out = dryRun(dir);
    expect(planned(out)).toEqual([]);
    expect(out.match(/^skip /gm)).toHaveLength(3);
  });

  it('refuses a --ref that names no commit', () => {
    const { dir, git } = repo();
    released(dir, git);
    let status = 0;
    try {
      dryRun(dir, '--ref', 'no-such-ref');
    } catch (err) {
      status = (err as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});
