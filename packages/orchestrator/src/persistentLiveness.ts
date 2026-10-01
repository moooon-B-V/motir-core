import { OrchestratorApiError } from './errors';
import type {
  PersistentContainerHandle,
  PersistentExecResult,
  PersistentLivenessResult,
} from './types';

// THE LIVENESS ANSWER (`docs/decisions/agent-image-update.md` Q3, MOTIR-6950) —
// one implementation for every adapter, built on the port's own `exec`. An image
// update asks it of the NEW image once the machine reports started; a failing
// answer is what rolls the agent back, so it must be an ANSWER and never a throw.

/** Q3's bound on the liveness command. */
export const DEFAULT_LIVENESS_TIMEOUT_SECONDS = 60;

type Exec = (
  handle: PersistentContainerHandle,
  command: readonly string[],
  options: { timeoutSeconds?: number },
) => Promise<PersistentExecResult>;

/** Trim a command's output to what a failure reason can carry in words. */
function brief(text: string): string {
  const line = text.trim().split('\n').filter(Boolean).pop() ?? '';
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

/**
 * Run `command` through `exec` and answer whether it proved the agent alive:
 * exit 0 within `timeoutSeconds`. A non-zero exit is `exit` (with its code and
 * the last line it printed); the provider's timeout (HTTP 408), or no answer
 * within the bound, is `timeout`; any other refusal is `unreachable`.
 */
export async function livenessViaExec(
  exec: Exec,
  handle: PersistentContainerHandle,
  command: readonly string[],
  timeoutSeconds: number = DEFAULT_LIVENESS_TIMEOUT_SECONDS,
): Promise<PersistentLivenessResult> {
  const label = command.join(' ');
  const started = Date.now();
  let result: PersistentExecResult;
  try {
    result = await exec(handle, command, { timeoutSeconds });
  } catch (err) {
    const elapsed = (Date.now() - started) / 1000;
    if ((err instanceof OrchestratorApiError && err.status === 408) || elapsed >= timeoutSeconds) {
      return {
        alive: false,
        reason: 'timeout',
        detail: `${label} did not answer within ${timeoutSeconds}s`,
      };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return { alive: false, reason: 'unreachable', detail: `${label} could not be run: ${detail}` };
  }
  if (result.exitCode === 0) return { alive: true };
  const said = brief(result.stderr) || brief(result.stdout);
  return {
    alive: false,
    reason: 'exit',
    exitCode: result.exitCode,
    detail: `${label} exited ${result.exitCode}${said ? ` (${said})` : ''}`,
  };
}
