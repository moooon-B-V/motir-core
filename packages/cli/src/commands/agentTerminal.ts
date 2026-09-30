import { CliError } from '../errors.js';
import {
  DEFAULT_TERMINAL_MODULE_DIR,
  NOT_AN_AGENT_IMAGE,
  TERMINAL_MODULE_DIR_ENV,
  loadNodePty,
  type SpawnPty,
} from '../agentTerminal/pty.js';
import {
  TERMINAL_KEY_ENV,
  createTerminalServer,
  type TerminalServer,
} from '../agentTerminal/server.js';

// `motir agent-terminal serve` — the in-agent terminal server
// (MOTIR-6938 · `docs/decisions/agent-terminal.md` Q4).
//
// It runs as the main process of a user's agent machine (MOTIR-6939 wires
// `init.cmd`), listens on 0.0.0.0:7681, and hands a login shell to Motir's
// relay — and to nothing that cannot present a relay token signed with this
// machine's key. Outside an agent image it refuses in words, because the PTY
// it needs is compiled into the image and is not a dependency of this package.

export const DEFAULT_TERMINAL_PORT = 7681;

/** The machine env the server cannot start without. Named, never echoed. */
const REQUIRED_ENV = [TERMINAL_KEY_ENV, 'MOTIR_INSTANCE_ID', 'FLY_MACHINE_ID'] as const;

export interface AgentTerminalServeOptions {
  port?: string;
}

export interface AgentTerminalServeDeps {
  env?: NodeJS.ProcessEnv;
  loadPty?: (dir: string) => SpawnPty | null;
  log?: (line: string) => void;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TERMINAL_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new CliError(`--port must be a TCP port between 1 and 65535, got "${raw}".`);
  }
  return port;
}

export async function agentTerminalServeCommand(
  opts: AgentTerminalServeOptions,
  deps: AgentTerminalServeDeps = {},
): Promise<TerminalServer> {
  const env = deps.env ?? process.env;
  const port = parsePort(opts.port);
  const dir = env[TERMINAL_MODULE_DIR_ENV]?.trim() || DEFAULT_TERMINAL_MODULE_DIR;
  const spawnPty = (deps.loadPty ?? loadNodePty)(dir);
  if (!spawnPty) {
    throw new CliError(NOT_AN_AGENT_IMAGE, {
      hint: 'It is started by the agent machine Motir runs for you; there is nothing to serve here.',
    });
  }
  for (const name of REQUIRED_ENV) {
    if (!env[name]?.trim()) {
      throw new CliError(`The terminal server needs ${name}, which the agent's machine sets.`);
    }
  }
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const terminal = createTerminalServer({
    instanceKey: env[TERMINAL_KEY_ENV] as string,
    instanceId: env['MOTIR_INSTANCE_ID'] as string,
    machineId: env['FLY_MACHINE_ID'] as string,
    spawnPty,
    env,
    log,
  });
  await terminal.listen(port);
  return terminal;
}
