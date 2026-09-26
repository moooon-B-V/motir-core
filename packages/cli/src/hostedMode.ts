import { join } from 'node:path';
import type { DispatchItem, DispatchRunView, MotirClient } from './client.js';
import { findLink, LINK_FILENAME, type FoundLink } from './config/linkConfig.js';
import { CliError } from './errors.js';

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
