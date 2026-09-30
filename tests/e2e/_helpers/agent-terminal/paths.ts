/**
 * Where the fake fleet's agents keep their state on this machine — shared by the
 * lane's terminal host (`host.ts`), which OWNS these directories, and the specs
 * that reach into them the way a person's own actions on the agent would (Story
 * MOTIR-6864 · MOTIR-7031). TEST-ONLY.
 *
 * Relative imports only: `host.ts` runs under plain `tsx`, with no path aliases.
 */
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Each instance's home volume lives in `<AGENT_HOMES>/<instanceId>` and outlives its machine runs. */
export const AGENT_HOMES =
  process.env['MOTIR_E2E_AGENT_HOMES'] ?? path.join(tmpdir(), 'motir-e2e-agent-homes');

/** One control socket per machine RUN (`<machineId>-<starts>-<boot>.sock`), as each run's server opens one. */
export const CONTROL_SOCKETS = path.join(tmpdir(), 'motir-e2e-agent-control');

export function agentHome(instanceId: string): string {
  return path.join(AGENT_HOMES, instanceId);
}

/** `CLAUDE_CONFIG_DIR` inside an agent's home — where the image's entrypoint points Claude Code. */
export function claudeConfigDir(home: string): string {
  return path.join(home, '.motir-sandbox', 'agent-config', '.claude');
}

/** The file the sign-in check stats for the Claude Code profile (agent-terminal.md Q7). */
export function claudeCredentialFile(instanceId: string): string {
  return path.join(claudeConfigDir(agentHome(instanceId)), '.credentials.json');
}

/**
 * The file the fake coding agent (`bin/claude -p`) waits on before it finishes
 * its work — so a run stays live for exactly as long as the spec needs it to, and
 * then ends on its own. Its content is the pull request number the fake GitHub
 * opened for the run's branch (`motir-run.py` links it).
 */
export function runReleaseFile(instanceId: string, runId: string): string {
  return path.join(agentHome(instanceId), '.motir-e2e', `release-${runId}`);
}

/**
 * The repository the stub run (`motir-run.py`) reports as checked out. The lane
 * cannot mint a real GitHub installation token, so the stub never asks the run's
 * git-credential route (it clones nothing); the seed names the project's one
 * repository here instead, beside the agent's home.
 */
export function runRepositoryFile(instanceId: string): string {
  return path.join(agentHome(instanceId), '.motir-e2e', 'repository');
}
