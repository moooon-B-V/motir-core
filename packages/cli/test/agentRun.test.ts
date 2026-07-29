import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agentRun.js';
import { parseAgentCommand } from '../src/agentProfiles.js';
import { CliError } from '../src/errors.js';

// The agent seam, exercised against a REAL child process (node itself plays the
// coding agent). Mocking `spawn` would assert our own stub; spawning verifies
// the contract that actually matters — that a real agent finds the prompt on
// BOTH stdin and $MOTIR_PROMPT_FILE, and that its exit code reaches us.

const PROMPT = 'CONTEXT\nWHAT TO DO\nACCEPTANCE CRITERIA\n';

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'motir-agent-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A fake agent: a `node -e` script, parsed exactly as a user's agent command
 *  would be. `script` runs with the child's cwd/env/stdin. */
function fakeAgent(script: string) {
  const parsed = parseAgentCommand(process.execPath);
  if (!parsed) throw new Error('unreachable: execPath is non-empty');
  return { ...parsed, args: ['-e', script] };
}

describe('runAgent', () => {
  it('delivers the prompt on STDIN', async () => {
    const out = join(work, 'stdin.txt');
    const result = await runAgent({
      command: fakeAgent(
        `let b='';process.stdin.on('data',d=>b+=d);` +
          `process.stdin.on('end',()=>require('fs').writeFileSync(${JSON.stringify(out)},b));`,
      ),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(PROMPT);
  });

  it('delivers the prompt at $MOTIR_PROMPT_FILE too (for agents that take a path)', async () => {
    const out = join(work, 'file.txt');
    const result = await runAgent({
      command: fakeAgent(
        `const fs=require('fs');` +
          `fs.writeFileSync(${JSON.stringify(out)}, fs.readFileSync(process.env.MOTIR_PROMPT_FILE,'utf8'));`,
      ),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(PROMPT);
  });

  it('runs the agent in the RESOLVED cwd', async () => {
    const out = join(work, 'cwd.txt');
    const repo = mkdtempSync(join(work, 'repo-'));
    await runAgent({
      command: fakeAgent(`require('fs').writeFileSync(${JSON.stringify(out)}, process.cwd());`),
      prompt: PROMPT,
      cwd: repo,
    });
    // realpath, because macOS temp dirs are symlinked (/var → /private/var).
    expect(readFileSync(out, 'utf8')).toContain('repo-');
  });

  it('surfaces a NON-ZERO exit code instead of throwing', async () => {
    const result = await runAgent({
      command: fakeAgent('process.exit(3)'),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.exitCode).toBe(3);
    expect(result.signal).toBeNull();
  });

  it('survives an agent that never reads stdin (EPIPE is not a failure)', async () => {
    const result = await runAgent({
      command: fakeAgent('process.stdin.destroy();process.exit(0)'),
      prompt: 'x'.repeat(200_000),
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
  });

  it('removes the prompt temp file afterwards', async () => {
    const out = join(work, 'path.txt');
    await runAgent({
      command: fakeAgent(
        `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.MOTIR_PROMPT_FILE);`,
      ),
      prompt: PROMPT,
      cwd: work,
    });
    expect(existsSync(readFileSync(out, 'utf8'))).toBe(false);
  });

  it('throws a guiding CliError when the agent binary does not exist', async () => {
    const parsed = parseAgentCommand('motir-no-such-agent-binary');
    if (!parsed) throw new Error('unreachable');
    await expect(runAgent({ command: parsed, prompt: PROMPT, cwd: work })).rejects.toThrow(
      CliError,
    );
    await expect(runAgent({ command: parsed, prompt: PROMPT, cwd: work })).rejects.toThrow(
      /not found/,
    );
  });
});
