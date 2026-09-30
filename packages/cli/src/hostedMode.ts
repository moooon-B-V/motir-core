import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DispatchItem, DispatchRunView, MotirClient } from './client.js';
import { findLink, LINK_FILENAME, type FoundLink } from './config/linkConfig.js';
import { CliError } from './errors.js';
import { HOSTED_STATE_ENV, readRunAccess, type HostedRunAccess } from './hostedGit.js';

// THE HOSTED MODE (Story MOTIR-683 · MOTIR-6558) — `motir run` / `motir continue`
// on a run the SERVER opened, inside a hosted container, with nobody watching.
//
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §1–§3: a hosted run is
// the CLI's own run, executed in a container. The server opens the run with its
// legs — the leaf, or every member of a parent's scope, in claim order — and the
// CLI ADOPTS it instead of opening its own, so `DispatchRun.id` stays the one id
// the start path, the fleet, the gateway and motir-ai already name.
//
// ── What this module decides, and what it deliberately does not ──────────────
// It answers four questions and nothing else: IS this a hosted run (the run id),
// WHERE are its checkouts (the workspace), WHICH project (from the run's own
// cards), and WHAT does it own (the run's legs, read back). Everything a run
// DOES — claim each leg, fetch its prompt, spawn the agent, push, open and link
// the pull requests, move the cards, close the run — stays in the one pipeline
// local runs use. A hosted run that took a different path through the CLI would
// be a second runner, which is exactly what the decision retires.
//
// ⚠️ GENERIC OVER THE COMMAND. `motir run` is the first caller; `motir continue`
// (the run-dies story) enters the same way, so nothing here names `run`.

/** The env var that puts a command in hosted mode: the run the server opened. */
export const RUN_ID_ENV_VAR = 'MOTIR_DISPATCH_RUN_ID';

/** Where a hosted container's checkouts live — every repository as `<root>/<name>`. */
export const WORKSPACE_ENV_VAR = 'MOTIR_WORKSPACE';

/** The hosted image's workspace when `MOTIR_WORKSPACE` says nothing. */
export const DEFAULT_HOSTED_WORKSPACE = '/workspace';

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

/**
 * The run this command adopts, or null for an ordinary local run.
 *
 * `--run-id` outranks the env var, as every flag outranks its env twin in this
 * CLI. An EMPTY value is absent, not a run id: `MOTIR_DISPATCH_RUN_ID=` in a
 * compose file must not turn a local run into one that adopts nothing.
 */
export function hostedRunId(
  opts: { runId?: string },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const flag = opts.runId?.trim();
  if (flag) return flag;
  return envValue(env, RUN_ID_ENV_VAR) ?? null;
}

/** The hosted workspace root: `MOTIR_WORKSPACE`, else `/workspace`. */
export function hostedWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  return envValue(env, WORKSPACE_ENV_VAR) ?? DEFAULT_HOSTED_WORKSPACE;
}

/**
 * The PROJECT key a work-item key belongs to — everything before its last `-`.
 *
 * A key is `<PROJECT>-<n>` by construction; the number never contains a dash,
 * so the LAST one is the separator even for a project key that has its own.
 */
export function projectKeyOf(workItemKey: string): string {
  const cut = workItemKey.lastIndexOf('-');
  if (cut <= 0) {
    throw new CliError(`"${workItemKey}" is not a work item key.`, {
      hint: 'A hosted run is adopted from its cards, and every card key is PROJECT-n.',
    });
  }
  return workItemKey.slice(0, cut);
}

/** The run a hosted command adopted, as the rest of the pipeline needs it. */
export interface AdoptedRun {
  runId: string;
  projectKey: string;
  /** The run's DISPATCHABLE legs, in the run's own order — never re-derived. */
  legs: string[];
}

/** The leg dispositions a run can still dispatch. */
const DISPATCHABLE = new Set(['queued', 'running']);

/**
 * READ the run the server opened and check it can be adopted at all.
 *
 * ⚠️ REFUSED, not guessed, on two shapes: a run that has already ended (a
 * container booted twice must not re-run finished work) and a run with no legs
 * left to dispatch. Whether the command's own card belongs to it is
 * {@link assertAdoptsLeaf}'s question, asked once the target's shape is known.
 */
export async function readAdoptedRun(
  client: Pick<MotirClient, 'getDispatchRun'>,
  runId: string,
): Promise<AdoptedRun> {
  const run: DispatchRunView = await client.getDispatchRun(runId);
  if (run.endedAt !== null || run.status !== 'running') {
    throw new CliError(`Run ${runId} has already ended (${run.status}); nothing to adopt.`, {
      hint: 'A hosted run is adopted once, by the container the server booted for it.',
    });
  }
  const legs = run.cards
    .filter((card) => card.key !== null && DISPATCHABLE.has(card.disposition))
    .map((card) => card.key as string);
  if (legs.length === 0) {
    throw new CliError(`Run ${runId} has no card left to dispatch.`);
  }
  return { runId, projectKey: projectKeyOf(legs[0] as string), legs };
}

/**
 * A LEAF command adopts only a run its card is a leg of.
 *
 * A run adopted under the wrong key would report one card's work into another's
 * run. A SCOPE command is not asked this: it names the container, which is never
 * a leg — its legs are the members the server claimed.
 */
export function assertAdoptsLeaf(run: AdoptedRun, key: string): void {
  if (run.legs.includes(key)) return;
  throw new CliError(`${key} is not a card of run ${run.runId}.`, {
    hint: `Its cards are: ${run.legs.join(', ')}.`,
  });
}

/**
 * The link a hosted run stands on.
 *
 * A container has no `.motir.json` to walk up to — env vars are its whole
 * configuration — so the link is SYNTHESISED at the workspace root with no
 * repository overrides: every checkout resolves by the ordinary convention,
 * `<root>/<repoName>`, and the existing materialize paths clone what is missing.
 * A `.motir.json` that IS present (a hosted run on a prepared workspace) wins,
 * exactly as it would locally.
 */
export function hostedLink(
  rootDir: string,
  serverUrl: string,
  projectKey: string,
  find: (start: string) => FoundLink | null = findLink,
): FoundLink {
  const found = find(rootDir);
  if (found) return found;
  return {
    dir: rootDir,
    path: join(rootDir, LINK_FILENAME),
    config: { serverUrl, workspace: '', project: projectKey },
  };
}

/**
 * A scope member built from its own card, for a leg the server already claimed.
 *
 * The local drain takes its members from the READY set; a hosted run cannot,
 * because the server's claim has already moved every leg out of it. The drain
 * reads a member's key, title, type and executor — all on the card — and the
 * status is the claim's, which is what `in_progress` records.
 */
export function legAsDispatchItem(detail: {
  item: {
    identifier: string;
    kind: string;
    title: string;
    status: string;
    priority: string;
    assigneeId: string | null;
    type: string | null;
    executor: string | null;
  };
}): DispatchItem {
  const { item } = detail;
  return {
    key: item.identifier,
    kind: item.kind,
    title: item.title,
    priority: item.priority,
    status: { key: item.status, category: 'in_progress' },
    type: item.type,
    executor: item.executor,
    assigneeId: item.assigneeId,
    inheritedSessionBranch: null,
  };
}

// ── AGENT MODE (Story MOTIR-6864 · MOTIR-7024) ─────────────────────────────
//
// `docs/decisions/agent-instance-run.md` §1–§3: a card run INSIDE one of the
// developer's own agents. The terminal server's launcher (MOTIR-7025) opens a
// run session running `motir run <KEY> --run-id <id>` with `MOTIR_AGENT_RUN=1`
// and `MOTIR_HOSTED_STATE=/tmp/motir-run-<id>`, having written the run's token
// to that directory's `run.json` from the exec's stdin. Everything after the
// adopt is the hosted path above, unchanged; what differs is WHICH agent runs
// (the image's own, on the developer's sign-in — `resolveAgent`) and WHERE the
// run's secrets and checkouts sit (never the developer's home, for longer than
// the run).

/** The env var that puts an adopted run in agent mode — `1` and nothing else. */
export const AGENT_RUN_ENV_VAR = 'MOTIR_AGENT_RUN';

/** The profile the agent's image was built for (`sandbox/Dockerfile`). */
export const SANDBOX_AGENT_ENV_VAR = 'MOTIR_SANDBOX_AGENT';

/** Is this process an agent-mode run? Only an exact `1` says so. */
export function isAgentRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_RUN_ENV_VAR]?.trim() === '1';
}

/** The run's state directory, which the launcher created — refused when absent. */
export function agentRunStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = envValue(env, HOSTED_STATE_ENV);
  if (dir) return dir;
  throw new CliError(`An agent-mode run needs ${HOSTED_STATE_ENV}.`, {
    hint: 'A run in an agent is started from the card in Motir, which hands it its state directory.',
  });
}

/**
 * The run's checkouts: `MOTIR_WORKSPACE` when the launcher set it, else
 * `$HOME/.motir/runs/<runId>` — never the developer's own `$HOME/workspace`
 * checkouts, whose uncommitted work a run must not touch (§2).
 */
export function agentRunWorkspace(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return envValue(env, WORKSPACE_ENV_VAR) ?? join(home, '.motir', 'runs', runId);
}

/**
 * The run's own address and token, read from the state directory's `run.json`
 * — NEVER from `MOTIR_TOKEN` / `MOTIR_RUN_TOKEN`, which in a developer's agent
 * would be the developer's own credential, not the run's (§2: no token in any
 * environment variable). A `run.json` written for another run is refused.
 */
export function readAgentRunAccess(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): HostedRunAccess & { stateDir: string } {
  const stateDir = agentRunStateDir(env);
  const access = readRunAccess(stateDir);
  if (access.runId !== runId) {
    throw new CliError(`The run state in ${stateDir} is for run ${access.runId}, not ${runId}.`, {
      hint: 'Start the run again from the card in Motir.',
    });
  }
  return { ...access, stateDir };
}

/**
 * Point the CLI's own state (the version check, the exclude list) into the
 * run's state directory, so an agent-mode run writes nothing under the
 * developer's `~/.local/state`. Called at startup, before anything reads it.
 */
export function pinAgentRunStateHome(env: NodeJS.ProcessEnv = process.env): void {
  if (!isAgentRun(env)) return;
  const dir = envValue(env, HOSTED_STATE_ENV);
  if (dir) env['MOTIR_STATE_HOME'] = join(dir, 'cli-state');
}
