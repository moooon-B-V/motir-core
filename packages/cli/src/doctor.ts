import { CliError } from './errors.js';
import { findAgentProfile, parseAgentCommand, type AgentProfile } from './agentProfiles.js';
import type { FoundLink, ResolvedRepo } from './config/linkConfig.js';

// The BYOK preflight engine — `motir doctor`'s checks, verdict, and report,
// with every side effect behind the {@link DoctorProbe} seam. Motir is BYOK
// (your agent, your key), so "is my setup correct?" must be answerable BEFORE a
// dispatch rather than discovered halfway through one.
//
// Two properties are STRUCTURAL here, not merely tested:
//
//   1. **No secret is ever read.** The probe exposes `hasEnv(name): boolean`
//      and `pathExists(path): boolean` — presence predicates. There is no way
//      for this module to obtain an env VALUE or a file's CONTENTS, so a
//      credential cannot be read, logged, or printed even by accident. (The one
//      env value the engine can reach is the agent-command override, which is a
//      command line, not a credential.)
//   2. **Nothing is dispatched or mutated.** The probe's only server call is
//      `probeServer`, whose implementation (commands/doctor.ts) is typed
//      against a read-only client surface — connect / list tools / whoami /
//      search. `doctor` is a read of the world, never a write to it.

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  /** Stable machine id (`auth`, `link`, `project`, `repos`, `agent`, `credential`). */
  id: string;
  /** Human column label. */
  label: string;
  status: CheckStatus;
  /** One-line result detail. */
  detail: string;
  /** What to do about it — present on every WARN/FAIL. */
  remediation?: string;
}

export interface DoctorReport {
  /** False when ANY check failed — the non-zero exit condition. */
  ok: boolean;
  checks: DoctorCheck[];
}

/** What `probeServer` reports back: one connect, several rows. */
export interface ServerProbe {
  ok: boolean;
  /** Set when the connect / handshake failed (auth, network, unreachable). */
  error?: { message: string; hint?: string };
  toolCount?: number;
  user?: { name: string; email: string };
  workspace?: { name: string; slug: string } | null;
  /** Present only when a project key was supplied. */
  project?: { key: string; reachable: boolean; total?: number; error?: string };
}

export interface AgentProbe {
  onPath: boolean;
  /** Absolute path the binary resolved to (when found). */
  resolvedPath?: string;
  /** First line of `<binary> --version` output (when it answered). */
  version?: string;
  /** Why `--version` did not answer (non-zero exit, timeout, …). */
  versionError?: string;
}

/**
 * Every side effect `doctor` needs, as one injectable seam. Each real
 * implementation is a couple of lines (commands/doctor.ts); the fake ones make
 * the whole matrix — including the failure rows — unit-testable with no
 * network, no agent binary, and no real home directory.
 */
export interface DoctorProbe {
  /** The `.motir.json` binding walked up from cwd, or null. */
  findLink(): FoundLink | null;
  /** The server this run targets. Throws {@link CliError} when ambiguous. */
  resolveServerUrl(): string;
  /** The stored PAT for a server, if any. */
  hasCredential(serverUrl: string): boolean;
  /** One read-only server round-trip: handshake + whoami + project reachability. */
  probeServer(input: { serverUrl: string; projectKey?: string }): Promise<ServerProbe>;
  /** Where each repo named by the link resolves (override or convention). */
  resolveRepos(link: FoundLink): ResolvedRepo[];
  /** Is the binary on PATH, and does it answer `--version`? */
  probeAgent(binary: string): Promise<AgentProbe>;
  /** The `agentCommand` recorded in the user config, if any. */
  configuredAgentCommand(): string | undefined;
  /** `MOTIR_AGENT` — an agent COMMAND LINE, never a credential. */
  agentEnvOverride(): string | undefined;
  /** PRESENCE of a path. Never reads it. */
  pathExists(path: string): boolean;
  /** PRESENCE of an env var. Never yields its value. */
  hasEnv(name: string): boolean;
  home(): string;
  xdgConfigHome(): string;
}

export interface DoctorOptions {
  /** `--agent <cmd>` — check THIS agent instead of the configured one. */
  agent?: string;
}

/** Where the agent command came from, so the report can say so. */
type AgentSource = 'flag' | 'env' | 'config';

const AGENT_SOURCE_LABEL: Record<AgentSource, string> = {
  flag: '--agent',
  env: 'MOTIR_AGENT',
  config: 'config agentCommand',
};

/**
 * Resolve WHICH agent command to check, in priority order: the `--agent` flag,
 * then `MOTIR_AGENT`, then the user config's `agentCommand`. Returns null when
 * no agent is configured at all — which is a WARN, not a failure: `motir next
 * --print` hands the prompt to an agent Motir never launches.
 */
export function resolveAgentCommand(
  opts: DoctorOptions,
  probe: DoctorProbe,
): { command: string; source: AgentSource } | null {
  const flag = opts.agent?.trim();
  if (flag) return { command: flag, source: 'flag' };
  const env = probe.agentEnvOverride()?.trim();
  if (env) return { command: env, source: 'env' };
  const configured = probe.configuredAgentCommand()?.trim();
  if (configured) return { command: configured, source: 'config' };
  return null;
}

/** Every credential location a profile pins: its dirs plus its env vars. */
function credentialLocations(profile: AgentProfile, probe: DoctorProbe): string[] {
  const paths = profile.credentialPaths(probe.home(), probe.xdgConfigHome());
  return [...paths, ...profile.credentialEnv.map((name) => `the ${name} env var`)];
}

/** Run the whole checklist. Pure orchestration over {@link DoctorProbe}. */
export async function runDoctor(opts: DoctorOptions, probe: DoctorProbe): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // ── link (local) ─────────────────────────────────────────────────────────
  const link = probe.findLink();
  checks.push(
    link
      ? {
          id: 'link',
          label: 'Project link',
          status: 'pass',
          detail: `${link.config.project} in ${link.config.workspace} · ${link.path}`,
        }
      : {
          id: 'link',
          label: 'Project link',
          status: 'fail',
          detail: 'No .motir.json found in this directory or any parent.',
          remediation: 'Run `motir link` at your workspace root to bind a project.',
        },
  );

  // ── auth + project (one server round-trip) ───────────────────────────────
  let serverUrl: string | null = null;
  let serverError: { message: string; hint?: string } | null = null;
  try {
    serverUrl = probe.resolveServerUrl();
  } catch (err) {
    serverError =
      err instanceof CliError
        ? { message: err.message, ...(err.hint ? { hint: err.hint } : {}) }
        : { message: err instanceof Error ? err.message : String(err) };
  }

  let server: ServerProbe | null = null;
  if (serverUrl && probe.hasCredential(serverUrl)) {
    const projectKey = link?.config.project;
    server = await probe.probeServer({
      serverUrl,
      ...(projectKey ? { projectKey } : {}),
    });
  }

  checks.push(authCheck({ serverUrl, serverError, server }));
  checks.push(projectCheck({ link, server }));

  // ── repo checkouts (local) ───────────────────────────────────────────────
  checks.push(reposCheck(link, probe));

  // ── agent + credential ───────────────────────────────────────────────────
  const agent = resolveAgentCommand(opts, probe);
  const parsed = agent ? parseAgentCommand(agent.command) : null;
  const profile = parsed ? findAgentProfile(parsed.binary) : null;

  if (!agent || !parsed) {
    checks.push({
      id: 'agent',
      label: 'Coding agent',
      status: 'warn',
      detail: 'No coding agent configured.',
      remediation:
        'Pass --agent <cmd>, set MOTIR_AGENT, or add "agentCommand" to the user config. ' +
        '(`motir next --print` needs no agent — it hands you the prompt.)',
    });
    checks.push({
      id: 'credential',
      label: 'Agent credential',
      status: 'warn',
      detail: 'Skipped — no coding agent configured.',
      remediation: 'Configure an agent first, then re-run `motir doctor`.',
    });
    return summarize(checks);
  }

  const probed = await probe.probeAgent(parsed.binary);
  checks.push(agentCheck({ parsed, source: agent.source, profile, probed }));
  checks.push(credentialCheck({ binary: parsed.binary, profile, probe }));

  return summarize(checks);
}

function authCheck(input: {
  serverUrl: string | null;
  serverError: { message: string; hint?: string } | null;
  server: ServerProbe | null;
}): DoctorCheck {
  const { serverUrl, serverError, server } = input;
  const base = { id: 'auth', label: 'Auth' } as const;
  if (!serverUrl) {
    return {
      ...base,
      status: 'fail',
      detail: serverError?.message ?? 'No Motir server configured.',
      remediation: serverError?.hint ?? 'Run `motir auth login` first.',
    };
  }
  if (!server) {
    return {
      ...base,
      status: 'fail',
      detail: `Not logged in to ${serverUrl}.`,
      remediation: 'Run `motir auth login` to store a personal access token.',
    };
  }
  if (!server.ok) {
    return {
      ...base,
      status: 'fail',
      detail: `${serverUrl}: ${server.error?.message ?? 'the server could not be reached.'}`,
      remediation: server.error?.hint ?? 'Run `motir auth login` to re-authenticate.',
    };
  }
  const who = server.user ? `${server.user.email}` : 'unknown user';
  const ws = server.workspace ? ` · workspace ${server.workspace.slug}` : '';
  const tools = server.toolCount === undefined ? '' : ` · ${server.toolCount} tools`;
  return { ...base, status: 'pass', detail: `${who} on ${serverUrl}${ws}${tools}` };
}

function projectCheck(input: { link: FoundLink | null; server: ServerProbe | null }): DoctorCheck {
  const { link, server } = input;
  const base = { id: 'project', label: 'Workspace + project' } as const;
  if (!link) {
    return {
      ...base,
      status: 'warn',
      detail: 'Skipped — no project link to resolve.',
      remediation: 'Run `motir link` first.',
    };
  }
  if (!server?.ok || !server.project) {
    return {
      ...base,
      status: 'warn',
      detail: 'Skipped — the server could not be reached.',
      remediation: 'Fix the auth check above, then re-run `motir doctor`.',
    };
  }
  const { project } = server;
  if (!project.reachable) {
    return {
      ...base,
      status: 'fail',
      detail: `Project ${project.key} is not reachable: ${project.error ?? 'unknown error'}`,
      remediation: `Check the project key in .motir.json, and that your token's user is a member of ${link.config.workspace}.`,
    };
  }
  // The token's active workspace differing from the linked one is legal (a PAT
  // can reach several), but it is worth surfacing — it is the usual cause of a
  // "why is this project empty?" confusion.
  const linked = link.config.workspace;
  const active = server.workspace?.slug;
  const count = project.total === undefined ? '' : ` · ${project.total} work items`;
  if (active && active !== linked) {
    return {
      ...base,
      status: 'warn',
      detail: `${project.key} reachable${count}, but the token's active workspace is ${active}, not ${linked}.`,
      remediation: `Confirm ${linked} is the workspace you meant to link.`,
    };
  }
  return { ...base, status: 'pass', detail: `${project.key} in ${linked} reachable${count}` };
}

function reposCheck(link: FoundLink | null, probe: DoctorProbe): DoctorCheck {
  const base = { id: 'repos', label: 'Repo checkouts' } as const;
  if (!link) {
    return {
      ...base,
      status: 'warn',
      detail: 'Skipped — no project link to resolve.',
      remediation: 'Run `motir link` first.',
    };
  }
  const repos = probe.resolveRepos(link);
  if (repos.length === 0) {
    return {
      ...base,
      status: 'pass',
      detail: `No overrides — checkouts resolve by convention under ${link.dir}`,
    };
  }
  // A checkout that does not exist YET is first-class (an empty root is a valid
  // link — the scaffold subtasks create the checkouts), so a missing convention
  // path is not a problem. A missing OVERRIDE is: the user named that path.
  const missingOverrides = repos.filter((r) => r.source === 'override' && !r.exists);
  const summary = repos.map((r) => `${r.repoName} → ${r.path}${r.exists ? '' : ' (not yet)'}`);
  if (missingOverrides.length > 0) {
    return {
      ...base,
      status: 'warn',
      detail: `${missingOverrides.length} override path(s) do not exist: ${summary.join(', ')}`,
      remediation: 'Fix with `motir link add <repo> <path>`, or clone the checkout there.',
    };
  }
  return { ...base, status: 'pass', detail: summary.join(', ') };
}

function agentCheck(input: {
  parsed: { command: string; binary: string };
  source: AgentSource;
  profile: AgentProfile | null;
  probed: AgentProbe;
}): DoctorCheck {
  const { parsed, source, profile, probed } = input;
  const base = { id: 'agent', label: 'Coding agent' } as const;
  const via = `via ${AGENT_SOURCE_LABEL[source]}`;
  if (!probed.onPath) {
    return {
      ...base,
      status: 'fail',
      detail: `\`${parsed.binary}\` (${via}) is not on PATH.`,
      remediation: profile
        ? `Install ${profile.label}: ${profile.installSource}`
        : `Install \`${parsed.binary}\` and make sure it is on PATH (Motir runs your agent, it never bundles one).`,
    };
  }
  const where = probed.resolvedPath ? ` → ${probed.resolvedPath}` : '';
  if (!probed.version) {
    return {
      ...base,
      status: 'warn',
      detail: `\`${parsed.binary}\`${where} is on PATH but did not answer --version${
        probed.versionError ? ` (${probed.versionError})` : ''
      }.`,
      remediation: 'Run the agent once by hand to confirm it starts before `motir auto`.',
    };
  }
  const label = profile ? `${profile.label} ` : '';
  return {
    ...base,
    status: 'pass',
    detail: `${label}\`${parsed.command}\` (${via})${where} · ${probed.version}`,
  };
}

function credentialCheck(input: {
  binary: string;
  profile: AgentProfile | null;
  probe: DoctorProbe;
}): DoctorCheck {
  const { binary, profile, probe } = input;
  const base = { id: 'credential', label: 'Agent credential' } as const;
  if (!profile) {
    return {
      ...base,
      status: 'warn',
      detail: `No credential profile for \`${binary}\` — Motir knows the sandbox-matrix agents only.`,
      remediation: `Check \`${binary}\`'s own docs for where it stores its credential, and confirm it is signed in.`,
    };
  }
  if (!profile.credentialKnown) {
    return {
      ...base,
      status: 'warn',
      detail: `${profile.label}'s credential location is not pinned by the profile matrix.`,
      remediation: profile.credentialHint,
    };
  }
  const paths = profile.credentialPaths(probe.home(), probe.xdgConfigHome());
  const foundPath = paths.find((p) => probe.pathExists(p));
  if (foundPath) {
    return {
      ...base,
      status: 'pass',
      detail: `${profile.label} credential present at ${foundPath} (presence only — never read).`,
    };
  }
  const foundEnv = profile.credentialEnv.find((name) => probe.hasEnv(name));
  if (foundEnv) {
    return {
      ...base,
      status: 'pass',
      detail: `${profile.label} credential present via ${foundEnv} (set — value never read).`,
    };
  }
  return {
    ...base,
    status: 'fail',
    detail: `No ${profile.label} credential found.`,
    remediation: `${profile.credentialHint} Expected ${credentialLocations(profile, probe).join(' or ')}.`,
  };
}

/** Wrap the rows in a report, deriving `ok` from the presence of any failure. */
export function summarize(checks: DoctorCheck[]): DoctorReport {
  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

/** Non-zero exactly when a hard check failed (a WARN never fails the run). */
export function doctorExitCode(report: DoctorReport): number {
  return report.ok ? 0 : 1;
}

const STATUS_ORDER: CheckStatus[] = ['fail', 'warn', 'pass'];

/** Count each status, for the closing summary line. */
export function countByStatus(checks: DoctorCheck[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The human report: one row per check, remediation indented under it. */
export function renderDoctorReport(report: DoctorReport): string {
  const labelWidth = Math.max(...report.checks.map((c) => c.label.length), 0);
  const lines: string[] = ['motir doctor — BYOK preflight', ''];
  for (const check of report.checks) {
    lines.push(
      `${check.status.toUpperCase().padEnd(4)}  ${check.label.padEnd(labelWidth)}  ${check.detail}`,
    );
    if (check.remediation) lines.push(`${' '.repeat(6 + labelWidth + 2)}↳ ${check.remediation}`);
  }
  const counts = countByStatus(report.checks);
  const parts = STATUS_ORDER.filter((s) => counts[s] > 0).map((s) =>
    s === 'fail'
      ? plural(counts.fail, 'failed', 'failed')
      : s === 'warn'
        ? plural(counts.warn, 'warning', 'warnings')
        : plural(counts.pass, 'passed', 'passed'),
  );
  lines.push(
    '',
    report.ok ? `All hard checks passed — ${parts.join(', ')}.` : `${parts.join(', ')}.`,
  );
  return lines.join('\n');
}
