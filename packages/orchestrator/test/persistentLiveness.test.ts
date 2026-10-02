import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVENESS_TIMEOUT_SECONDS,
  livenessViaExec,
  OrchestratorApiError,
  type PersistentContainerHandle,
  type PersistentExecResult,
} from '../src/index';

// THE LIVENESS ANSWER (`docs/decisions/agent-image-update.md` Q3 · MOTIR-6950),
// pinned on its own rather than only through the two adapters that call it. Every
// path must come back as an ANSWER — alive, `exit`, `timeout` or `unreachable` —
// because a throw here would leave an image update with nothing to roll back on.
// The adapters' suites cover the happy path and one refusal; the reason wording
// below is what reaches a person reading why an update was rolled back.

const HANDLE: PersistentContainerHandle = {
  provider: 'fake',
  app: 'motir-org-test',
  machineId: 'm-1',
  volumeId: 'v-1',
  region: 'ams',
  createdAt: new Date('2026-10-01T00:00:00Z'),
};
const COMMAND = ['motir-agent', 'health'] as const;

function answering(result: PersistentExecResult) {
  return async () => result;
}

function throwing(err: unknown) {
  return async (): Promise<PersistentExecResult> => {
    throw err;
  };
}

describe('livenessViaExec', () => {
  it('is alive on exit 0, and passes the default bound to exec', async () => {
    const seen: number[] = [];
    const result = await livenessViaExec(
      async (_handle, _command, options) => {
        seen.push(options.timeoutSeconds ?? -1);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      HANDLE,
      COMMAND,
    );
    expect(result).toEqual({ alive: true });
    expect(seen).toEqual([DEFAULT_LIVENESS_TIMEOUT_SECONDS]);
  });

  it('names the last line of stderr on a non-zero exit', async () => {
    const result = await livenessViaExec(
      answering({ exitCode: 3, stdout: 'ignored', stderr: 'starting\nport 7681 refused\n\n' }),
      HANDLE,
      COMMAND,
    );
    expect(result).toEqual({
      alive: false,
      reason: 'exit',
      exitCode: 3,
      detail: 'motir-agent health exited 3 (port 7681 refused)',
    });
  });

  it('falls back to stdout when stderr is empty', async () => {
    const result = await livenessViaExec(
      answering({ exitCode: 1, stdout: 'not ready\n', stderr: '  \n' }),
      HANDLE,
      COMMAND,
    );
    expect(result).toMatchObject({
      reason: 'exit',
      detail: 'motir-agent health exited 1 (not ready)',
    });
  });

  it('says only the exit code when the command printed nothing', async () => {
    const result = await livenessViaExec(
      answering({ exitCode: 137, stdout: '', stderr: '' }),
      HANDLE,
      COMMAND,
    );
    expect(result).toMatchObject({ reason: 'exit', detail: 'motir-agent health exited 137' });
  });

  it('trims a long output line to 200 characters', async () => {
    const result = await livenessViaExec(
      answering({ exitCode: 2, stdout: '', stderr: 'x'.repeat(500) }),
      HANDLE,
      COMMAND,
    );
    expect(result).toMatchObject({
      reason: 'exit',
      detail: `motir-agent health exited 2 (${'x'.repeat(197)}…)`,
    });
  });

  it("reads the provider's HTTP 408 as a timeout", async () => {
    const result = await livenessViaExec(
      throwing(new OrchestratorApiError('fake', 408, 'exec timed out')),
      HANDLE,
      COMMAND,
      30,
    );
    expect(result).toEqual({
      alive: false,
      reason: 'timeout',
      detail: 'motir-agent health did not answer within 30s',
    });
  });

  it('reads any refusal that outlived the bound as a timeout', async () => {
    const result = await livenessViaExec(throwing(new Error('socket hang up')), HANDLE, COMMAND, 0);
    expect(result).toMatchObject({ alive: false, reason: 'timeout' });
  });

  it('reads any other refusal as unreachable, naming it', async () => {
    const result = await livenessViaExec(
      throwing(new OrchestratorApiError('fake', 502, 'bad gateway')),
      HANDLE,
      COMMAND,
    );
    expect(result).toEqual({
      alive: false,
      reason: 'unreachable',
      detail:
        'motir-agent health could not be run: The fake orchestrator refused a call (HTTP 502: bad gateway).',
    });
  });

  it('answers unreachable even when the thrown value is not an Error', async () => {
    const result = await livenessViaExec(throwing('machine gone'), HANDLE, COMMAND);
    expect(result).toEqual({
      alive: false,
      reason: 'unreachable',
      detail: 'motir-agent health could not be run: machine gone',
    });
  });
});
