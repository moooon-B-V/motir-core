import { homedir } from 'node:os';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { MotirClient, type WhoamiResult } from '../mcpClient.js';
import { CliError } from '../errors.js';
import { json, out } from '../output.js';
import { resolveServerUrl } from '../serverResolve.js';
import {
  findLink,
  overrideRepoNames,
  resolveRepo,
  type FoundLink,
  type ResolvedRepo,
} from '../config/linkConfig.js';
import { getAgentCommand, normalizeServerUrl, resolveCredential } from '../config/userConfig.js';
import {
  doctorExitCode,
  renderDoctorReport,
  runDoctor,
  type AgentProbe,
  type DoctorOptions,
  type DoctorProbe,
  type ServerProbe,
} from '../doctor.js';

// `motir doctor` — the BYOK preflight. One read-only command that answers "is
// my setup correct?" BEFORE `motir next` / `motir auto`, rather than letting a
// missing agent or an unsigned-in key surface halfway through a dispatch.
//
// This module is the I/O half: it wires the real filesystem / PATH / MCP
// probes into the {@link DoctorProbe} seam, and the engine (doctor.ts) decides
// the verdicts. The split is what keeps the whole check matrix unit-testable
// without a network, an agent binary, or a real home directory.

/** How long `<agent> --version` gets before we call it unresponsive. */
export const AGENT_VERSION_TIMEOUT_MS = 5_000;

/**
 * The read-only slice of {@link MotirClient} the server probe is allowed to
 * use. Typing the probe against THIS — rather than the full client — is what
 * makes "doctor never dispatches and never mutates" structural: no transition,
 * create, or update method is even in scope.
 */
export interface ReadOnlyServerClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  listToolNames(): Promise<string[]>;
  whoami(): Promise<WhoamiResult>;
  countWorkItems(args: { projectKey: string }): Promise<number>;
}

/**
 * One server round-trip: handshake → tool list → whoami → (optionally) a
 * work-item COUNT that proves the linked project is reachable for this token. Every failure is captured into the result rather than thrown, so
 * `doctor` reports a red row instead of aborting the whole checklist.
 */
export async function probeServerWith(
  client: ReadOnlyServerClient,
  projectKey?: string,
): Promise<ServerProbe> {
  try {
    await client.connect();
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
  try {
    const toolCount = (await client.listToolNames()).length;
    const who = await client.whoami();
    const result: ServerProbe = {
      ok: true,
      toolCount,
      user: { name: who.user.name, email: who.user.email },
      workspace: who.workspace ? { name: who.workspace.name, slug: who.workspace.slug } : null,
    };
    if (projectKey) {
      try {
        const total = await client.countWorkItems({ projectKey });
        result.project = { key: projectKey, reachable: true, total };
      } catch (err) {
        result.project = { key: projectKey, reachable: false, error: describeError(err).message };
      }
    }
    return result;
  } catch (err) {
    return { ok: false, error: describeError(err) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function describeError(err: unknown): { message: string; hint?: string } {
  if (err instanceof CliError) {
    return { message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

/** Is this path an executable file? (The PATH scan's per-candidate test.) */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a binary against PATH without shelling out (no `which`/`where`
 * dependency, and nothing the user controls is ever passed to a shell). A name
 * containing a separator is treated as a path and checked directly. On Windows
 * each PATHEXT suffix is tried too — `platform` is a parameter so that branch
 * is exercisable from a POSIX test run.
 */
export function resolveOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const withExtensions = (base: string): string[] => {
    if (platform !== 'win32') return [base];
    const exts = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    return [base, ...exts.map((ext) => base + ext)];
  };
  if (binary.includes('/') || binary.includes('\\')) {
    const direct = isAbsolute(binary) ? binary : resolve(binary);
    return withExtensions(direct).find(isExecutableFile) ?? null;
  }
  for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    const hit = withExtensions(join(dir, binary)).find(isExecutableFile);
    if (hit) return hit;
  }
  return null;
}

/** The first line of a multi-line message — agents are chatty, reports are not. */
export function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return (newline === -1 ? text : text.slice(0, newline)).trim();
}

/** Run `<binary> --version` (no shell, hard timeout) and take its first line. */
export function probeAgentVersion(path: string): Promise<{ version?: string; error?: string }> {
  return new Promise((done) => {
    execFile(
      path,
      ['--version'],
      { timeout: AGENT_VERSION_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          done({ error: firstLine(err.message) });
          return;
        }
        const text = firstLine(`${stdout}${stderr}`.trim());
        done(text ? { version: text } : { error: 'no output' });
      },
    );
  });
}

/** The real probe: filesystem, PATH, user config, and one read-only MCP call. */
export function defaultDoctorProbe(): DoctorProbe {
  return {
    findLink: () => findLink(),
    resolveServerUrl: () => resolveServerUrl(),
    credentialOrigin: (serverUrl) => resolveCredential(serverUrl)?.origin ?? null,
    probeServer: async ({ serverUrl, projectKey }) => {
      const url = normalizeServerUrl(serverUrl);
      const cred = resolveCredential(url);
      if (!cred) return { ok: false, error: { message: `Not logged in to ${url}.` } };
      const client = new MotirClient({ serverUrl: url, token: cred.token });
      return probeServerWith(client, projectKey);
    },
    resolveRepos: (link: FoundLink): ResolvedRepo[] =>
      overrideRepoNames(link.config).map((name) => resolveRepo(link.dir, link.config, name)),
    probeAgent: async (binary): Promise<AgentProbe> => {
      const resolved = resolveOnPath(binary);
      if (!resolved) return { onPath: false };
      const { version, error } = await probeAgentVersion(resolved);
      return {
        onPath: true,
        resolvedPath: resolved,
        ...(version ? { version } : {}),
        ...(error ? { versionError: error } : {}),
      };
    },
    configuredAgentCommand: () => getAgentCommand(),
    agentEnvOverride: () => process.env['MOTIR_AGENT'],
    // PRESENCE predicates only — the credential itself is never opened, and an
    // env var's VALUE is never returned. See doctor.ts's structural note.
    pathExists: (path) => existsSync(path),
    hasEnv: (name) => {
      const value = process.env[name];
      return typeof value === 'string' && value.length > 0;
    },
    home: () => homedir(),
    xdgConfigHome: () => process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'),
    xdgDataHome: () => process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'),
  };
}

export interface DoctorCommandOptions extends DoctorOptions {
  json?: boolean;
}

/**
 * Run the checklist and print it. Sets a non-zero exit code when a hard check
 * fails (so `motir doctor && motir auto` is a usable gate) without throwing —
 * a failed CHECK is a reported result, not a crash.
 */
export async function doctorCommand(
  opts: DoctorCommandOptions,
  probe: DoctorProbe = defaultDoctorProbe(),
): Promise<void> {
  const report = await runDoctor(opts, probe);
  if (opts.json) json(report);
  else out(renderDoctorReport(report));
  process.exitCode = doctorExitCode(report);
}
