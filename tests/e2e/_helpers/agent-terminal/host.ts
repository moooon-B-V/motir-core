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
 *
 * And, for a card's run in the agent (Story MOTIR-6864 · MOTIR-7031):
 *   - THE EXEC DOOR. Motir reaches a machine's local commands only through the
 *     orchestrator's `exec` (agent-instance-run.md §1). The fake persistent
 *     orchestrator POSTs every exec nothing scripted to `POST /exec` here
 *     (`MOTIR_FAKE_EXEC_URL`), and this host runs it against that machine's run:
 *     `motir agent-terminal signin | run | stop | status` are `packages/cli`'s REAL
 *     commands, with the machine's environment, speaking to the machine's REAL
 *     server over its control socket; the two capability probes (`--help`,
 *     `run --help`) answer 0 because the commands are here; anything else (the
 *     boot's clone) answers exit 0 with nothing, as the fake always has.
 *   - THE RUN SESSION'S `motir run` is `motir-run.py`, which the server spawns on
 *     a real PTY exactly where the image's CLI would run. It speaks the run's own
 *     `/api/v1` ingest with the token the launcher wrote, and runs the stub
 *     `claude -p` as its coding agent (see its header for why it is a stub).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { constants as osConstants } from 'node:os';
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
import { CONTROL_SOCKET_ENV } from '../../../../packages/cli/src/agentTerminal/control';
import {
  agentTerminalRunCommand,
  agentTerminalSignInCommand,
  agentTerminalStatusCommand,
  agentTerminalStopCommand,
} from '../../../../packages/cli/src/commands/agentTerminal';
import { AGENT_HOMES, CONTROL_SOCKETS, claudeConfigDir } from './paths';

const HERE = __dirname;
const STUB_BIN = path.join(HERE, 'bin');
const BRIDGE = path.join(HERE, 'pty-bridge.py');
/** What the run session runs in place of the image's `motir` (see the header). */
const RUN_STUB = path.join(HERE, 'motir-run.py');
const PORT = Number(process.env['MOTIR_E2E_TERMINAL_HOST_PORT'] ?? 3292);
const HOMES = AGENT_HOMES;

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
  mkdirSync(claudeConfigDir(home), { recursive: true });
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
  /** The instance this machine run serves — the fleet's machine ids restart with each test's fleet state. */
  instanceId: string;
  terminal: TerminalServer;
  /** The machine's process environment — what an `exec`'d command runs with. */
  env: NodeJS.ProcessEnv;
  /** Resolves once the run's control socket is listening. */
  ready: Promise<void>;
}
const booted = new Map<string, Booted>();
/** Makes each boot's control socket path unique, whatever a machine id or count repeats. */
let bootSeq = 0;

function boot(machine: FakeMachine): { terminal: TerminalServer; env: NodeJS.ProcessEnv } | null {
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
    CLAUDE_CONFIG_DIR: claudeConfigDir(home),
    ...machineEnv,
    MOTIR_INSTANCE_ID: instanceId,
    FLY_MACHINE_ID: machine.handle.machineId,
    // This run's control socket: the server listens on it, and the commands an
    // exec runs find it here — the image's fixed path, one per machine run.
    [CONTROL_SOCKET_ENV]: path.join(
      CONTROL_SOCKETS,
      `${machine.handle.machineId}-${machine.starts}-${++bootSeq}.sock`,
    ),
  } as unknown as NodeJS.ProcessEnv;
  const tag = `[terminal-host ${machine.handle.machineId}#${machine.starts}]`;
  const terminal = createTerminalServer({
    instanceKey: key,
    instanceId,
    machineId: machine.handle.machineId,
    spawnPty,
    env,
    cli: ['python3', RUN_STUB],
    log: (line) => console.warn(`${tag} ${line}`),
  });
  return { terminal, env };
}

/**
 * The machine's current run, booted on first use — by a terminal connection or by
 * an exec, whichever reaches it first, exactly as a real machine's server is up
 * before either. Null for a machine that is not running or serves no terminal.
 */
async function ensureBooted(machineId: string): Promise<Booted | null> {
  const machine = readMachine(machineId);
  if (!machine || machine.state !== 'running') return null;
  let current = booted.get(machineId);
  if (
    !current ||
    current.starts !== machine.starts ||
    current.instanceId !== machine.spec.instanceId
  ) {
    // A new run of the machine: the previous run's shells (and its run) end with it.
    // (A machine id reused by the next test's fleet is a new machine, too.)
    if (current) void current.terminal.close();
    const started = boot(machine);
    if (!started) return null;
    const ready = started.terminal.listenControl(started.env[CONTROL_SOCKET_ENV] as string);
    current = { starts: machine.starts, instanceId: machine.spec.instanceId, ...started, ready };
    booted.set(machineId, current);
  }
  await current.ready;
  return current;
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  socket.on('error', () => socket.destroy());
  const header = req.headers['x-motir-machine-id'];
  const machineId = typeof header === 'string' ? header : null;
  if (!machineId) {
    refuse(socket, 502, 'Bad Gateway');
    return;
  }
  void ensureBooted(machineId).then(
    (current) => {
      if (!current) {
        refuse(socket, 502, 'Bad Gateway');
        return;
      }
      // The real server's own upgrade handler: it verifies the relay token first.
      current.terminal.server.emit('upgrade', req, socket, head);
    },
    () => refuse(socket, 502, 'Bad Gateway'),
  );
}

// ── The exec door (MOTIR-7031) ────────────────────────────────────────────────

interface ExecRequest {
  machineId: string;
  command: string[];
  stdin?: string;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `--run-id <id>`'s value, if the argv carries one. */
function runIdOf(args: readonly string[]): string | undefined {
  const at = args.indexOf('--run-id');
  return at >= 0 ? args[at + 1] : undefined;
}

/**
 * Run one exec on a machine. The launcher's `runuser -u node -- env HOME=… motir …`
 * prefix is the image's way of becoming the agent's user; here every command
 * already runs as the agent, with its home, so what matters is what follows
 * `motir agent-terminal`.
 */
async function runExec(request: ExecRequest): Promise<ExecResult | null> {
  const current = await ensureBooted(request.machineId);
  if (!current) return null;
  const at = request.command.findIndex(
    (part, i) => part === 'motir' && request.command[i + 1] === 'agent-terminal',
  );
  if (at < 0) return { exitCode: 0, stdout: '', stderr: '' };
  const [sub, ...args] = request.command.slice(at + 2);
  if (sub === undefined || sub === '--help' || args.includes('--help')) {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  let stdout = '';
  const out = (text: string) => void (stdout += text);
  const env = current.env;
  try {
    switch (sub) {
      case 'signin':
        await agentTerminalSignInCommand({ env, stdout: out });
        break;
      case 'run':
        await agentTerminalRunCommand(
          args[0] ?? '',
          { runId: runIdOf(args) },
          { env, stdout: out, readStdin: async () => request.stdin ?? '' },
        );
        break;
      case 'stop':
        await agentTerminalStopCommand({ runId: runIdOf(args) }, { env, stdout: out });
        break;
      case 'status':
        await agentTerminalStatusCommand({ runId: runIdOf(args) }, { env, stdout: out });
        break;
      default:
        return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    // The CLI exits 1 with its words on stderr, having printed its JSON answer.
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout, stderr: `${message}\n` };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

rmSync(HOMES, { recursive: true, force: true });
mkdirSync(HOMES, { recursive: true });
rmSync(CONTROL_SOCKETS, { recursive: true, force: true });

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/exec') {
    res.statusCode = 426;
    res.end();
    return;
  }
  void readBody(req)
    .then(async (raw) => {
      const request = JSON.parse(raw) as ExecRequest;
      const result = await runExec(request);
      if (!result) {
        res.statusCode = 412;
        res.end(JSON.stringify({ error: `machine ${request.machineId} is not running` }));
        return;
      }
      console.warn(
        `[terminal-host ${request.machineId}] exec ${request.command.slice(-4).join(' ')} → ${result.exitCode}`,
      );
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result));
    })
    .catch((err: unknown) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
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
