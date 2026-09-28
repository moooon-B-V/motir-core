import type { SpawnSyncReturns } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareHostedCheckouts, resetHostedCodegraph } from '../src/hostedCodegraph.js';

// A HOSTED RUN'S CODE GRAPH, per checkout (MOTIR-6560) — moved from the hosted
// image's old entrypoint into the CLI, because the CLI now clones the checkouts.

const tmp: string[] = [];
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'motir-hosted-cg-'));
  tmp.push(dir);
  spawnSync('git', ['init', '-q', dir]);
  return dir;
}

type Call = { command: string; args: string[] };

/** A scripted `codegraph`: `init` makes the index directory, unless told to fail. */
function fakeSpawn(opts: { failInit?: boolean; failInstall?: boolean } = {}) {
  const calls: Call[] = [];
  const spawn = (command: string, args: string[]): SpawnSyncReturns<string> => {
    calls.push({ command, args });
    const fail =
      (args[0] === 'init' && opts.failInit) || (args[0] === 'install' && opts.failInstall);
    if (args[0] === 'init' && !fail) mkdirSync(join(args[1]!, '.codegraph'), { recursive: true });
    return {
      pid: 1,
      output: [],
      stdout: '',
      stderr: fail ? 'codegraph: boom' : '',
      status: fail ? 1 : 0,
      signal: null,
    };
  };
  return { spawn, calls };
}

beforeEach(() => resetHostedCodegraph());
afterEach(() => {
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('prepareHostedCheckouts', () => {
  it('indexes each checkout, installs its sync hooks, and excludes the index from commits', () => {
    const [a, b] = [checkout(), checkout()];
    const { spawn, calls } = fakeSpawn();
    const notes: string[] = [];
    prepareHostedCheckouts([a, b], (line) => notes.push(line), { spawn });
    for (const dir of [a, b]) {
      expect(existsSync(join(dir, '.codegraph'))).toBe(true);
      expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toMatch(
        /^\.codegraph\/$/m,
      );
      for (const hook of ['post-merge', 'post-checkout']) {
        expect(readFileSync(join(dir, '.git', 'hooks', hook), 'utf8')).toContain('codegraph sync');
      }
    }
    // The OpenCode MCP registration is global — made once, not per checkout.
    expect(calls.filter((c) => c.args[0] === 'install')).toHaveLength(1);
    expect(calls.filter((c) => c.args[0] === 'init').map((c) => c.args[1])).toEqual([a, b]);
    expect(notes).toEqual([]);
  });

  it('prepares a checkout once per process — a parent’s legs share their checkouts', () => {
    const dir = checkout();
    const { spawn, calls } = fakeSpawn();
    prepareHostedCheckouts([dir], () => {}, { spawn });
    prepareHostedCheckouts([dir], () => {}, { spawn });
    expect(calls.filter((c) => c.args[0] === 'init')).toHaveLength(1);
    expect(
      readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').match(/\.codegraph\//g),
    ).toHaveLength(1);
  });

  it('never replaces a hook it did not write, and does not re-index an existing index', () => {
    const dir = checkout();
    mkdirSync(join(dir, '.codegraph'));
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.git', 'hooks', 'post-merge'), '#!/bin/sh\necho mine\n');
    const { spawn, calls } = fakeSpawn();
    prepareHostedCheckouts([dir], () => {}, { spawn });
    expect(calls.filter((c) => c.args[0] === 'init')).toEqual([]);
    expect(readFileSync(join(dir, '.git', 'hooks', 'post-merge'), 'utf8')).toBe(
      '#!/bin/sh\necho mine\n',
    );
    expect(readFileSync(join(dir, '.git', 'hooks', 'post-checkout'), 'utf8')).toContain(
      'codegraph',
    );
  });

  it('is best-effort: a failed init or registration is a note, and the run carries on', () => {
    const [a, b] = [checkout(), checkout()];
    const notes: string[] = [];
    prepareHostedCheckouts([a], (line) => notes.push(line), {
      spawn: fakeSpawn({ failInit: true }).spawn,
    });
    expect(notes[0]).toMatch(
      /codegraph init failed on .* — the agent works there without a code graph \(codegraph: boom\)/,
    );
    // The index is still excluded, so a later index can never reach a commit.
    expect(readFileSync(join(a, '.git', 'info', 'exclude'), 'utf8')).toContain('.codegraph/');
    const failing = fakeSpawn({ failInstall: true });
    prepareHostedCheckouts([b], (line) => notes.push(line), { spawn: failing.spawn });
    expect(notes[1]).toMatch(/could not register the codegraph MCP server with OpenCode/);
  });

  it('skips a directory that is not a checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'motir-hosted-cg-bare-'));
    tmp.push(dir);
    const { spawn, calls } = fakeSpawn();
    prepareHostedCheckouts([dir], () => {}, { spawn });
    expect(calls).toEqual([]);
  });

  it('reports a missing codegraph binary as a note, not a failure', () => {
    const dir = checkout();
    const notes: string[] = [];
    prepareHostedCheckouts([dir], (line) => notes.push(line), {
      env: { PATH: '/nonexistent' },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/codegraph init failed/);
  });
});
