/**
 * THE FAKE FLEET'S TERMINAL SERVERS — the acceptance lane's stand-in for "the
 * agent's machine runs `motir agent-terminal serve`" (Story MOTIR-6861 ·
 * MOTIR-6943). TEST-ONLY; started by `playwright.acceptance.config.ts` as a
 * webServer, beside the relay.
 *
 * In production every agent is its own Fly Machine running the terminal server
 * on 7681, and the relay dials `wss://<org app>.fly.dev/v1/terminal` with
 * `fly-force-instance-id` (agent-terminal.md Q2). The lane's fleet is the
 * PERSISTENT FAKE (`MOTIR_FLEET_ORCHESTRATOR=fake`), whose `terminalEndpoint`
 * answers ONE local address for every agent (`MOTIR_FAKE_TERMINAL_URL`) plus an
 * `x-motir-machine-id` header. This process is what answers there: one
 * `createTerminalServer` — the REAL server from `packages/cli`, with its real
 * relay-token check, sessions, replay ring and sign-in check — per fake machine,
 * picked by that header.
 *
 * What it simulates, and how:
 *   - THE MACHINE'S ENV comes from the fake machine's own spec in the shared
 *     state file (`MOTIR_FAKE_PERSISTENT_STATE_PATH`): `MOTIR_INSTANCE_ID` and the
 *     per-instance `MOTIR_TERMINAL_KEY` the lifecycle wrote (MOTIR-6939). Nothing
 *     here knows the master key, exactly like a machine.
 *   - A MACHINE RUN is the machine's `starts` count: a wake is a fresh boot, so a
 *     new count gets a new server and the old one's shells are killed — the
 *     "hibernation ends every process" rule (agent-instances.md §2). A machine
 *     that is not `running` does not answer (the relay's 4502).
 *   - THE HOME VOLUME is a directory per instance that outlives every run, so a
 *     credential written in one run is still there after a wake.
 *   - THE PTY is node-pty when `MOTIR_TERMINAL_MODULE_DIR` holds a build (the
 *     image's own), else `pty-bridge.py` — a real pseudo-terminal via Python's
 *     `pty`, so CI needs no native build.
 *   - THE VENDOR CLI is the stub in `./bin` (`claude`), first on the shell's PATH.
 *   - THE PROFILE is Claude Code (`MOTIR_SANDBOX_AGENT=claude`): the lane's fake
 *     spec does not carry the image's profile, and every agent the spec opens is
 *     a Claude Code one.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { constants as osConstants, tmpdir } from 'node:os';
import path from 'node:path';
import type { Duplex, Writable } from 'node:stream';
import {
  DEFAULT_TERMINAL_MODULE_DIR,
  TERMINAL_MODULE_DIR_ENV,
  loadNodePty,
  type SpawnPty,
} from '../../../../packages/cli/src/agentTerminal/pty';
import {
  TERMINAL_KEY_ENV,
  createTerminalServer,
  type TerminalServer,
} from '../../../../packages/cli/src/agentTerminal/server';

const HERE = __dirname;
const STUB_BIN = path.join(HERE, 'bin');
const BRIDGE = path.join(HERE, 'pty-bridge.py');
const PORT = Number(process.env['MOTIR_E2E_TERMINAL_HOST_PORT'] ?? 3292);
const HOMES = process.env['MOTIR_E2E_AGENT_HOMES'] ?? path.join(tmpdir(), 'motir-e2e-agent-homes');

const statePath = process.env['MOTIR_FAKE_PERSISTENT_STATE_PATH'];
if (!statePath) {
  console.error('[terminal-host] MOTIR_FAKE_PERSISTENT_STATE_PATH is not set');
  process.exit(1);
}

/** The slice of the fake store's machine this host reads. */
interface FakeMachine {
  handle: { machineId: string };
  spec: {
    instanceId: string;
    env?: Record<string, string>;
    terminal?: { env?: Record<string, string> } | null;
  };
  state: string;
  starts: number;
}

function readMachine(machineId: string): FakeMachine | null {
  if (!existsSync(statePath!)) return null;
  try {
    const store = JSON.parse(readFileSync(statePath!, 'utf8')) as {
      machines?: Record<string, FakeMachine>;
    };
    return store.machines?.[machineId] ?? null;
  } catch {
    return null; // a torn read of a file another process is writing
  }
}

/** A real PTY without a native build: `pty-bridge.py`. */
const pythonPty: SpawnPty = (options) => {
  const child = spawn(
    'python3',
    [BRIDGE, String(options.cols), String(options.rows), options.file, ...options.args],
    {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
    },
  );
  const control = child.stdio[3] as Writable;
  child.stdin!.on('error', () => {});
  control.on('error', () => {});
  return {
    pid: child.pid ?? -1,
    onData: (listener) => child.stdout!.on('data', (data: Buffer) => listener(data)),
    onExit: (listener) =>
      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) =>
        listener({ exitCode: code, signal: signal ? osConstants.signals[signal] : null }),
      ),
    write: (data) => void child.stdin!.write(data),
    resize: (cols, rows) => void control.write(`${cols} ${rows}\n`),
    kill: () => void child.kill('SIGTERM'),
  };
};

const moduleDir = process.env[TERMINAL_MODULE_DIR_ENV]?.trim() || DEFAULT_TERMINAL_MODULE_DIR;
const nodePty = loadNodePty(moduleDir);
const spawnPty: SpawnPty = nodePty ?? pythonPty;

/** The instance's home volume: created once, kept across every run of its machine. */
function homeFor(instanceId: string): string {
  const home = path.join(HOMES, instanceId);
  if (existsSync(home)) return home;
  mkdirSync(path.join(home, 'workspace'), { recursive: true });
  // The image's one-time agent-config setup has "already run" for this home.
  mkdirSync(path.join(home, '.motir-sandbox', 'agent-config', '.claude'), { recursive: true });
  writeFileSync(path.join(home, '.motir-sandbox', 'agent-config', '.setup-done'), '');
  // A login shell's profile: the stub CLI first on PATH (a distribution's
  // /etc/profile may reset PATH), and a prompt that names the directory.
  writeFileSync(
    path.join(home, '.bash_profile'),
    [`export PATH="${STUB_BIN}:$PATH"`, "PS1='\\w\\$ '", 'unset PROMPT_COMMAND', ''].join('\n'),
  );
  return home;
}

interface Booted {
  starts: number;
  terminal: TerminalServer;
}
const booted = new Map<string, Booted>();

function boot(machine: FakeMachine): TerminalServer | null {
  const machineEnv = { ...(machine.spec.env ?? {}), ...(machine.spec.terminal?.env ?? {}) };
  const key = machineEnv[TERMINAL_KEY_ENV];
  if (!key) return null; // a machine booted without the terminal config serves nothing
  const instanceId = machine.spec.instanceId;
  const home = homeFor(instanceId);
  const env = {
    PATH: `${STUB_BIN}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
    HOME: home,
    USER: process.env['USER'] ?? 'node',
    LANG: 'C.UTF-8',
    SHELL: '/bin/bash',
    MOTIR_SANDBOX_AGENT: 'claude',
    CLAUDE_CONFIG_DIR: path.join(home, '.motir-sandbox', 'agent-config', '.claude'),
    ...machineEnv,
    MOTIR_INSTANCE_ID: instanceId,
    FLY_MACHINE_ID: machine.handle.machineId,
  } as unknown as NodeJS.ProcessEnv;
  const tag = `[terminal-host ${machine.handle.machineId}#${machine.starts}]`;
  return createTerminalServer({
    instanceKey: key,
    instanceId,
    machineId: machine.handle.machineId,
    spawnPty,
    env,
    log: (line) => console.warn(`${tag} ${line}`),
  });
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  socket.on('error', () => socket.destroy());
  const header = req.headers['x-motir-machine-id'];
  const machineId = typeof header === 'string' ? header : null;
  const machine = machineId ? readMachine(machineId) : null;
  if (!machineId || !machine || machine.state !== 'running') {
    refuse(socket, 502, 'Bad Gateway');
    return;
  }
  let current = booted.get(machineId);
  if (!current || current.starts !== machine.starts) {
    // A new run of the machine: the previous run's shells end with it.
    if (current) void current.terminal.close();
    const terminal = boot(machine);
    if (!terminal) {
      refuse(socket, 502, 'Bad Gateway');
      return;
    }
    current = { starts: machine.starts, terminal };
    booted.set(machineId, current);
  }
  // The real server's own upgrade handler: it verifies the relay token first.
  current.terminal.server.emit('upgrade', req, socket, head);
}

rmSync(HOMES, { recursive: true, force: true });
mkdirSync(HOMES, { recursive: true });

const server = createServer((_req, res) => {
  res.statusCode = 426;
  res.end();
});
server.on('upgrade', onUpgrade);
server.listen(PORT, '127.0.0.1', () => {
  console.warn(
    `[terminal-host] listening on 127.0.0.1:${PORT} (pty: ${nodePty ? 'node-pty' : 'pty-bridge.py'})`,
  );
});

function shutdown(): void {
  void Promise.all([...booted.values()].map((b) => b.terminal.close())).finally(() =>
    process.exit(0),
  );
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
