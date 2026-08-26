import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { materializeCheckouts, type RepoSetClient } from '../src/commands/link.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { ProjectRepository } from '../src/client.js';
import type { LinkConfig } from '../src/config/linkConfig.js';

// `motir link`'s MATERIALIZE step (Story MOTIR-3584 · Subtask MOTIR-3587) — the
// I/O half, driven with a stub client and a recording `CommandRunner` so no
// server and no git process are involved.
//
// `repoClone.test.ts` owns the DECISION matrix. What this file owns is the
// contract of the step around it: one reported line per repository of the set,
// the exit-code signal, and the invariant that an existing checkout is reached
// by no git command even through this path.

const LINK: LinkConfig = {
  serverUrl: 'https://app.motir.co',
  workspace: 'moooon',
  project: 'PROD',
};

let root: string;
let chunks: string[];

// The package writes to the STREAMS, never `console.*` — the stdout/stderr split
// is load-bearing for piping (`src/output.ts`), so a `console` spy would capture
// nothing. Both streams are collected here because the report spans them: the
// per-repository lines are payload, the "Cloning N…" narration is diagnostics.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'motir-link-'));
  chunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function output(): string {
  return chunks.join('');
}

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

/** A client that answers with a fixed set and nothing else. */
function clientWith(repositories: ProjectRepository[]): RepoSetClient {
  return { listRepositories: async () => ({ repositories }) } as RepoSetClient;
}

function recorder(result: () => CommandResult = () => ({ exitCode: 0, stdout: '', stderr: '' })): {
  run: CommandRunner;
  calls: { bin: string; args: string[] }[];
} {
  const calls: { bin: string; args: string[] }[] = [];
  const run: CommandRunner = (bin, args) => {
    calls.push({ bin, args });
    return result();
  };
  return { run, calls };
}

describe('materializeCheckouts', () => {
  it('clones what is missing and reports one line per repository', async () => {
    const { run, calls } = recorder();
    const client = clientWith([
      repo(),
      repo({
        id: 'b',
        role: 'api',
        name: null,
        repoRef: null,
        cloneUrl: null,
        defaultBranch: null,
        state: 'proposed',
        established: false,
      }),
    ]);

    const failed = await materializeCheckouts(client, root, LINK, 'PROD', { run });

    expect(failed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(output()).toContain('motir-core: cloned →');
    // The unestablished row is REPORTED, not dropped — "not created yet" rather
    // than an absence the reader has to notice.
    expect(output()).toContain('api: skipped (proposed)');
  });

  it('⚠️ issues NO git command for a checkout that already exists', async () => {
    mkdirSync(join(root, 'motir-core', '.git'), { recursive: true });
    const { run, calls } = recorder();

    const failed = await materializeCheckouts(clientWith([repo()]), root, LINK, 'PROD', { run });

    expect(failed).toBe(false);
    expect(calls).toEqual([]);
    expect(output()).toContain('motir-core: already present');
  });

  it('reports an existing NON-repository path without touching it', async () => {
    mkdirSync(join(root, 'motir-core'), { recursive: true });
    writeFileSync(join(root, 'motir-core', 'notes.txt'), 'mine');
    const { run, calls } = recorder();

    await materializeCheckouts(clientWith([repo()]), root, LINK, 'PROD', { run });

    expect(calls).toEqual([]);
    expect(output()).toContain('not a git repository');
  });

  it('reports a failure per repository and answers TRUE, without aborting', async () => {
    const { run, calls } = recorder(() => ({
      exitCode: 128,
      stdout: '',
      stderr: 'remote: Repository not found.',
    }));
    const client = clientWith([
      repo(),
      repo({ id: 'b', name: 'motir-ai', cloneUrl: 'https://github.com/moooon/motir-ai.git' }),
    ]);

    const failed = await materializeCheckouts(client, root, LINK, 'PROD', { run });

    expect(failed).toBe(true);
    // BOTH attempted — one failure is not an abort.
    expect(calls).toHaveLength(2);
    expect(output()).toContain('collaborator invitation');
    // git's own sentence survives beside ours.
    expect(output()).toContain('git said: remote: Repository not found.');
  });

  it('says so, and touches nothing, for a project with no set', async () => {
    const { run, calls } = recorder();

    const failed = await materializeCheckouts(clientWith([]), root, LINK, 'PROD', { run });

    expect(failed).toBe(false);
    expect(calls).toEqual([]);
    // An honest empty answer — every project predating the repository-set table
    // is in this state, and it is not a missing resource.
    expect(output()).toContain('none established');
  });

  it('clones to the OVERRIDE path when `.motir.json` names one', async () => {
    const { run, calls } = recorder();
    const config: LinkConfig = { ...LINK, repos: { 'motir-core': 'checkouts/core' } };

    await materializeCheckouts(clientWith([repo()]), root, config, 'PROD', { run });

    expect(calls[0]?.args).toEqual([
      'clone',
      'https://github.com/moooon/motir-core.git',
      join(root, 'checkouts', 'core'),
    ]);
  });
});
