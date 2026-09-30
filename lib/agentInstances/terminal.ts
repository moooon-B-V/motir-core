import type { PersistentTerminalConfig } from '@motir/orchestrator';
import { AgentInstancesUnavailableError } from '@/lib/agentInstances/errors';
import { deriveTerminalKey, terminalKeyId } from '@/lib/agentInstances/terminalKey';

// THE AGENT TERMINAL'S MACHINE CONFIG (Story MOTIR-6861 · MOTIR-6939) — the
// numbers and the command `docs/decisions/agent-terminal.md` fixes, named once.
// The orchestrator port carries them; only the Fly adapter knows how they are
// spelled in a Fly machine config.

/** Q2 / Q4: the terminal server listens here inside the machine. */
export const AGENT_TERMINAL_PORT = 7681;

/**
 * Q8: the machine config's version, stamped in the machine's metadata. BUMP IT
 * whenever {@link agentTerminalMachineConfig}'s output changes shape, so the next
 * wake of every older agent rewrites its config before starting it.
 *   1 — MOTIR-6939: the terminal server as the main process, the public
 *       service on 7681 → 443, `MOTIR_TERMINAL_KEY`.
 */
export const AGENT_MACHINE_CONFIG_VERSION = 1;

/**
 * Q4: the main process, under the image's UNCHANGED `ENTRYPOINT` (which seeds the
 * home and sources the agent's config env first). A current image runs the
 * server; an image whose `motir` has no such command idles instead of
 * crash-looping, so a new config on an old image boots and stays up (Q8).
 */
export const AGENT_TERMINAL_COMMAND: readonly string[] = [
  'sh',
  '-c',
  'motir agent-terminal --help >/dev/null 2>&1 && exec motir agent-terminal serve; exec sleep infinity',
];

/** Q8: the probe run once per image digest on a booted machine — exit 0 means the server is there. */
export const AGENT_TERMINAL_PROBE_COMMAND: readonly string[] = [
  'motir',
  'agent-terminal',
  '--help',
];

/** The master key must carry at least this many characters (≈ 256 bits of base64). */
export const TERMINAL_MASTER_KEY_MIN_LENGTH = 32;

/**
 * `MOTIR_TERMINAL_MASTER_KEY`, read at CALL time (the instance lane's rule), or
 * null when the deployment has not set it — the terminal is then OFF: machines
 * boot as before the terminal and nothing is probed. A key that is set but too
 * short is a misconfiguration and FAILS LOUDLY rather than deriving weak keys.
 */
export function terminalMasterKey(): string | null {
  const raw = process.env['MOTIR_TERMINAL_MASTER_KEY']?.trim();
  if (!raw) return null;
  if (raw.length < TERMINAL_MASTER_KEY_MIN_LENGTH) {
    throw new AgentInstancesUnavailableError(
      `MOTIR_TERMINAL_MASTER_KEY must be at least ${TERMINAL_MASTER_KEY_MIN_LENGTH} characters`,
    );
  }
  return raw;
}

/** Is the agent terminal switched on for this deployment? */
export function isAgentTerminalConfigured(): boolean {
  return terminalMasterKey() !== null;
}

/**
 * The machine config one instance's machine runs its terminal with (Q2, Q3, Q4),
 * or null when the terminal is off. The same value on create and on a wake's
 * config update, so the two can never disagree.
 */
export function agentTerminalMachineConfig(instanceId: string): PersistentTerminalConfig | null {
  const masterKey = terminalMasterKey();
  if (!masterKey) return null;
  const key = deriveTerminalKey(masterKey, instanceId);
  return {
    version: AGENT_MACHINE_CONFIG_VERSION,
    keyId: terminalKeyId(key),
    command: AGENT_TERMINAL_COMMAND,
    env: { MOTIR_TERMINAL_KEY: key },
    service: {
      internalPort: AGENT_TERMINAL_PORT,
      ports: [{ port: 443, handlers: ['tls', 'http'] }],
      autostart: false,
      autostop: 'off',
    },
  };
}
