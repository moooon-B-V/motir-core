import { describe, expect, it } from 'vitest';
import {
  anyCloneFailed,
  cloneRefusalDetail,
  planDetail,
  planRepoClones,
  runRepoClones,
  type RepoClonePlanEntry,
} from '../src/repoClone.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { LinkConfig } from '../src/config/linkConfig.js';
import type { ProjectRepository } from '../src/client.js';

// MATERIALIZING the repository set (Story MOTIR-3584 · Subtask MOTIR-3587) —
// the whole matrix, with NO git process, NO network and NO filesystem:
// `exists` is injected into the planner and a recording `CommandRunner` into the
// runner, exactly as `dispatch.test.ts` drives the routing matrix.
//
// The guard this file exists for, and the one that must keep holding for every
// future branch of the planner: **for a repository whose resolved path already
// exists, NO git command is issued at all** — asserted over the runner's
// recorded invocations rather than over a list of commands somebody judged safe
// (ADR `link-materializes-the-checkouts.md` §5).

const ROOT = '/home/yue/work';
const LINK: LinkConfig = {
  serverUrl: 'https://app.motir.co',
  workspace: 'moooon',
  project: 'PROD',
};

/** An `exists` predicate over an explicit allow-list of paths. */
const only =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

const none = () => false;

function repo(over: Partial<ProjectRepository> = {}): ProjectRepository {
  return {
    id: 'row_web',
    role: 'web',
    label: null,
    name: 'motir-core',
    repoRef: 'moooon/motir-core',
    cloneUrl: 'https://github.com/moooon/motir-core.git',
    defaultBranch: 'main',
    archived: false,
    state: 'connected',
    established: true,
    ...over,
  };
}

/** A row the server published but that names no repository yet. */
function proposed(over: Partial<ProjectRepository> = {}): ProjectRepository {
  return repo({
    id: 'row_api',
    role: 'api',
    name: null,
    repoRef: null,
    cloneUrl: null,
    defaultBranch: null,
    state: 'proposed',
    established: false,
    ...over,
  });
}

/** A runner that records every invocation and answers with a fixed result. */
function recorder(
  result: (bin: string, args: string[]) => CommandResult = () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  }),
): { run: CommandRunner; calls: { bin: string; args: string[]; cwd: string }[] } {
  const calls: { bin: string; args: string[]; cwd: string }[] = [];
  const run: CommandRunner = (bin, args, cwd) => {
    calls.push({ bin, args, cwd });
    return result(bin, args);
  };
  return { run, calls };
}

describe('planRepoClones — which rows are materialized', () => {
  it('plans a clone for an established row whose checkout is missing', () => {
    const [entry] = planRepoClones(ROOT, LINK, [repo()], { exists: none });

    expect(entry).toMatchObject({
      label: 'motir-core',
      kind: 'clone',
      path: '/home/yue/work/motir-core',
      source: 'convention',
      cloneUrl: 'https://github.com/moooon/motir-core.git',
    });
  });

  it('branches on `established`, not on a non-null cloneUrl', () => {
    // A row the server calls unestablished is skipped even if it somehow still
    // carries coordinates — the discriminator is the one dispatch resolves a
    // checkout with, and a client that re-derived it would drift from it.
    const [entry] = planRepoClones(ROOT, LINK, [repo({ established: false, state: 'failed' })], {
      exists: none,
    });

    expect(entry).toMatchObject({ kind: 'skip', skipReason: 'not_established' });
  });

  it('keeps an unestablished row IN the plan, named by its role and state', () => {
    const [entry] = planRepoClones(ROOT, LINK, [proposed()], { exists: none });

    // Never dropped: a four-row set that reports three lines is a set the reader
    // cannot reason about.
    expect(entry).toMatchObject({ label: 'api', kind: 'skip', state: 'proposed' });
    expect(planDetail(entry as RepoClonePlanEntry)).toContain('skipped (proposed)');
  });

  it('names a repeated role by its label, so two rows are tellable apart', () => {
    const plan = planRepoClones(
      ROOT,
      LINK,
      [proposed({ id: 'a', label: 'billing' }), proposed({ id: 'b', label: 'search' })],
      { exists: none },
    );

    expect(plan.map((e) => e.label)).toEqual(['api (billing)', 'api (search)']);
  });

  it('skips an established row whose provider yields no clone URL', () => {
    const [entry] = planRepoClones(ROOT, LINK, [repo({ cloneUrl: null })], { exists: none });

    // ESTABLISHED and yet un-materializable — a different skip from the one
    // above, and the report says which.
    expect(entry).toMatchObject({ kind: 'skip', skipReason: 'no_clone_url' });
    expect(planDetail(entry as RepoClonePlanEntry)).toContain('cannot derive a clone URL');
  });

  it('plans a clone for an ARCHIVED repository — readable is not writable', () => {
    const [entry] = planRepoClones(ROOT, LINK, [repo({ archived: true })], { exists: none });

    expect(entry).toMatchObject({ kind: 'clone', archived: true });
  });

  it('is TOTAL over the set — every row published gets exactly one entry', () => {
    const plan = planRepoClones(
      ROOT,
      LINK,
      [repo(), proposed(), repo({ id: 'c', name: 'motir-ai', cloneUrl: null })],
      { exists: none },
    );

    expect(plan).toHaveLength(3);
    expect(plan.map((e) => e.kind)).toEqual(['clone', 'skip', 'skip']);
  });
});

describe('planRepoClones — a path that already exists', () => {
  it('reports an existing git checkout as present, untouched', () => {
    const [entry] = planRepoClones(ROOT, LINK, [repo()], {
      exists: only('/home/yue/work/motir-core', '/home/yue/work/motir-core/.git'),
    });

    expect(entry).toMatchObject({ kind: 'present', presentIsRepository: true });
    expect(planDetail(entry as RepoClonePlanEntry)).toBe(
      'already present — /home/yue/work/motir-core',
    );
  });

  it('reports an existing NON-repository path as present, and says so', () => {
    const [entry] = planRepoClones(ROOT, LINK, [repo()], {
      exists: only('/home/yue/work/motir-core'),
    });

    // Answered from the filesystem alone (`<path>/.git`), never by running git.
    expect(entry).toMatchObject({ kind: 'present', presentIsRepository: false });
    expect(planDetail(entry as RepoClonePlanEntry)).toContain('not a git repository');
  });
});

describe('planRepoClones — the override map', () => {
  it('clones to the OVERRIDE path, not the convention path', () => {
    const config: LinkConfig = { ...LINK, repos: { 'motir-core': '../elsewhere/core' } };

    const [entry] = planRepoClones(ROOT, config, [repo()], { exists: none });

    expect(entry).toMatchObject({
      kind: 'clone',
      path: '/home/yue/elsewhere/core',
      source: 'override',
    });
  });

  it('honours an ABSOLUTE override', () => {
    const config: LinkConfig = { ...LINK, repos: { 'motir-core': '/srv/checkouts/core' } };

    const [entry] = planRepoClones(ROOT, config, [repo()], { exists: none });

    expect(entry).toMatchObject({ path: '/srv/checkouts/core', source: 'override' });
  });

  it('never clones over the link root itself when `--repo .` marked it', () => {
    const config: LinkConfig = { ...LINK, repos: { 'motir-core': '.' } };

    const [entry] = planRepoClones(ROOT, config, [repo()], { exists: only(ROOT, `${ROOT}/.git`) });

    expect(entry).toMatchObject({ kind: 'present', path: ROOT });
  });
});

describe('runRepoClones', () => {
  it('issues a FULL clone — no depth, no filter, no single-branch', () => {
    const { run, calls } = recorder();
    const plan = planRepoClones(ROOT, LINK, [repo()], { exists: none });

    runRepoClones(ROOT, plan, { run });

    expect(calls).toEqual([
      {
        bin: 'git',
        args: ['clone', 'https://github.com/moooon/motir-core.git', '/home/yue/work/motir-core'],
        cwd: ROOT,
      },
    ]);
  });

  it('⚠️ issues NO git command AT ALL for a repository whose path exists', () => {
    const { run, calls } = recorder();
    const plan = planRepoClones(ROOT, LINK, [repo()], {
      exists: only('/home/yue/work/motir-core', '/home/yue/work/motir-core/.git'),
    });

    const outcomes = runRepoClones(ROOT, plan, { run });

    // The never-touch invariant, as a property of the code rather than a
    // judgement about which commands are safe. A `remote get-url` added here
    // later — a pure read — fails this, deliberately.
    expect(calls).toEqual([]);
    expect(outcomes[0]).toMatchObject({ status: 'present' });
  });

  it('issues NO git command for a skipped row either', () => {
    const { run, calls } = recorder();
    const plan = planRepoClones(ROOT, LINK, [proposed()], { exists: none });

    const outcomes = runRepoClones(ROOT, plan, { run });

    expect(calls).toEqual([]);
    expect(outcomes[0]).toMatchObject({ status: 'skipped' });
  });

  it('does NOT abort on a failure — every remaining repository is still attempted', () => {
    const { run, calls } = recorder((_bin, args) =>
      args.includes('https://github.com/moooon/motir-ai.git')
        ? { exitCode: 128, stdout: '', stderr: 'fatal: could not read Username' }
        : { exitCode: 0, stdout: '', stderr: '' },
    );
    const plan = planRepoClones(
      ROOT,
      LINK,
      [
        repo({ id: 'a', name: 'motir-ai', cloneUrl: 'https://github.com/moooon/motir-ai.git' }),
        repo({ id: 'b', name: 'motir-core' }),
        repo({ id: 'c', name: 'motir-gateway', cloneUrl: 'https://github.com/m/g.git' }),
      ],
      { exists: none },
    );

    const outcomes = runRepoClones(ROOT, plan, { run });

    expect(calls).toHaveLength(3);
    expect(outcomes.map((o) => o.status)).toEqual(['failed', 'cloned', 'cloned']);
    expect(anyCloneFailed(outcomes)).toBe(true);
  });

  it('keeps git’s OWN message on a failure, never replacing it', () => {
    const { run } = recorder(() => ({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: repository not found',
    }));
    const plan = planRepoClones(ROOT, LINK, [repo()], { exists: none });

    const [outcome] = runRepoClones(ROOT, plan, { run });

    // A rewrite that drops the underlying error leaves no way back to it —
    // `motir link` proved what that costs once already (MOTIR-2492).
    expect(outcome?.gitMessage).toBe('fatal: repository not found');
  });

  it('names the PENDING-INVITATION case on an authentication refusal', () => {
    const { run } = recorder(() => ({
      exitCode: 128,
      stdout: '',
      stderr: 'remote: Repository not found.',
    }));
    const plan = planRepoClones(ROOT, LINK, [repo()], { exists: none });

    const [outcome] = runRepoClones(ROOT, plan, { run });

    // GitHub answers `Repository not found` for a private repository the caller
    // cannot see, which reads as *it does not exist* when the truth is *your
    // account has not accepted its invitation yet*. The message has to say so.
    expect(outcome?.detail).toContain('collaborator invitation');
    expect(outcome?.detail).toContain('https://github.com/moooon/motir-core.git');
    expect(outcome?.detail).not.toMatch(/^exit \d+$/);
  });

  it('reports a NON-auth failure without the invitation sentence', () => {
    const { run } = recorder(() => ({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: unable to access: Could not resolve host: github.com',
    }));
    const plan = planRepoClones(ROOT, LINK, [repo()], { exists: none });

    const [outcome] = runRepoClones(ROOT, plan, { run });

    // Guessing "your invitation is pending" at a DNS failure would send the
    // reader to a settings page that has nothing wrong with it.
    expect(outcome?.detail).not.toContain('collaborator invitation');
    expect(outcome?.gitMessage).toContain('Could not resolve host');
  });

  it('says an archived repository was cloned AND that it is archived', () => {
    const { run } = recorder();
    const plan = planRepoClones(ROOT, LINK, [repo({ archived: true })], { exists: none });

    const [outcome] = runRepoClones(ROOT, plan, { run });

    expect(outcome?.detail).toContain('archived on the host');
  });

  it('anyCloneFailed is false when nothing was attempted', () => {
    const { run } = recorder();
    const plan = planRepoClones(ROOT, LINK, [proposed()], { exists: none });

    // An existing path and a skipped row are the invariant working, not
    // failures — the exit code must not report them as such.
    expect(anyCloneFailed(runRepoClones(ROOT, plan, { run }))).toBe(false);
  });
});

describe('cloneRefusalDetail', () => {
  it('names the repository URL, the invitation and the credential check', () => {
    const detail = cloneRefusalDetail('https://github.com/moooon/private-thing.git');

    expect(detail).toContain('https://github.com/moooon/private-thing.git');
    expect(detail).toContain('collaborator invitation');
    expect(detail).toContain('gh auth status');
  });
});
