import { CliError } from '../errors.js';
import { info, outVerbatim } from '../output.js';
import { parseKinds } from './read.js';
import { withProjectSession, type ProjectSession } from '../session.js';
import { getAgentCommand } from '../config/userConfig.js';
import { parseAgentCommand, type ParsedAgentCommand } from '../agentProfiles.js';
import { runAgent } from '../agentRun.js';
import {
  addExclude,
  clearExcludes,
  readExcludes,
  removeExclude,
  removeExcludeByKey,
} from '../sessionExcludes.js';
import {
  checkBootstrapCheckout,
  renderAgentFailure,
  renderAgentSuccess,
  renderDispatchSummary,
  renderSessionOutcomes,
  resolveDispatchTarget,
  type AgentSource,
} from '../dispatch.js';
import { CLI_VERSION } from '../version.js';
import type { DispatchPrompt, MotirClient } from '../mcpClient.js';

// `motir next` / `motir run <key>` / `motir done <key>` — SINGLE DISPATCH
// (Story 7.9 · Subtask 7.9.3 · MOTIR-881). The heart of the CLI: take one work
// item from "ready" to "an agent is working on it", and close it out after the
// human merges.
//
// The pipeline is the same for `next` and `run`; only the SELECTION differs
// (`next_ready` picks, `run` is told which):
//
//   select → flip to in_progress → dispatch_prompt → deliver
//
// `deliver` is either `--print` (the prompt to stdout, for any agent, the BYOK
// default) or `--agent` (launch the user's agent on it and report the outcome).
//
// The CLI NEVER assembles prompt text. Every word the agent sees comes from the
// server's `dispatch_prompt` (MOTIR-1802), which is why every harness — Claude
// Code, Codex, opencode, a human reading it — gets the identical instruction
// and the grammar versions with the product.

/** The workflow status keys the CLI names. Both are the default workflow's
 *  (lib/workflows/defaultWorkflow.ts); a project on a custom workflow surfaces
 *  the server's own allowed-targets error, which is the honest failure. */
const IN_PROGRESS = 'in_progress';
const IN_REVIEW = 'in_review';
const DONE = 'done';

/** The harness string the CLI self-reports on the write tools (MOTIR-1685). */
const HARNESS = `motir-cli/${CLI_VERSION}`;

// ── agent resolution ────────────────────────────────────────────────────────

export interface DeliveryOptions {
  /** `--agent <cmd>` — launch THIS agent on the prompt. */
  agent?: string;
  /** `--print` — print the prompt and stop (the default when no agent). */
  print?: boolean;
}

/**
 * Resolve WHICH agent to launch, in the same priority order `motir doctor`
 * reports: `--agent`, then `MOTIR_AGENT`, then the user config's
 * `agentCommand`. Returns null when the user asked for `--print`, or when no
 * agent is configured anywhere — in which case printing IS the right behaviour
 * (BYOK's default is "hand me the prompt", not "fail").
 */
export function resolveAgent(
  opts: DeliveryOptions,
  env: NodeJS.ProcessEnv = process.env,
  configured: () => string | undefined = getAgentCommand,
): { parsed: ParsedAgentCommand; source: AgentSource } | null {
  if (opts.print) return null;
  const candidates: [string | undefined, AgentSource][] = [
    [opts.agent, 'flag'],
    [env['MOTIR_AGENT'], 'env'],
    [configured(), 'config'],
  ];
  for (const [raw, source] of candidates) {
    const parsed = parseAgentCommand(raw);
    if (parsed) return { parsed, source };
  }
  return null;
}

// ── the shared pipeline ─────────────────────────────────────────────────────

/**
 * Flip an item to In Progress, unless it is already there.
 *
 * The skip is not an optimisation: the default workflow has no `in_progress →
 * in_progress` self-edge, so re-dispatching an item already in progress (a
 * `motir run` after a failed agent — the documented recovery) would otherwise
 * die on an illegal-transition error before it ever printed a prompt.
 */
async function ensureInProgress(
  client: MotirClient,
  key: string,
  currentStatus: string | undefined,
): Promise<void> {
  if (currentStatus === IN_PROGRESS) {
    info(`${key}: already In Progress — leaving the status as it is.`);
    return;
  }
  await client.transitionStatus({ key, status: IN_PROGRESS });
}

interface DeliverInput {
  session: ProjectSession;
  key: string;
  title: string | null;
  /** The row id, for the exclude list. Absent on a `motir run <key>` whose
   *  `get_work_item` read supplies it separately. */
  id: string | null;
  dispatch: DispatchPrompt;
  opts: DeliveryOptions;
}

/**
 * Deliver the prompt: print it, or run the agent on it and record the outcome.
 * This is the ONE place both `next` and `run` converge, so their behaviour can
 * never drift.
 */
async function deliver(input: DeliverInput): Promise<void> {
  const { session, key, title, id, dispatch, opts } = input;
  const { client, link, serverUrl, projectKey } = session;

  const agent = resolveAgent(opts);
  const target = resolveDispatchTarget(link.dir, link.config, dispatch.targetRepo);
  const summary = renderDispatchSummary({
    key,
    title,
    dispatch,
    target,
    agent: agent ? { command: agent.parsed.command, source: agent.source } : null,
  });

  if (!agent) {
    // PRINT mode: the prompt is the PAYLOAD (stdout, byte-identical), the
    // summary is DIAGNOSTICS (stderr). That split is what lets
    // `motir next --print | pbcopy` copy the prompt and nothing else, while the
    // user still sees the repo + resolved path on screen.
    info(summary);
    info('');
    outVerbatim(dispatch.prompt);
    return;
  }

  info(summary);
  info('');
  const result = await runAgent({
    command: agent.parsed,
    prompt: dispatch.prompt,
    cwd: target.cwd,
  });

  if (result.exitCode !== 0) {
    // The item stays In Progress on purpose — work was started. Record it so
    // the next `motir next` moves past it instead of re-picking the failure.
    if (id) addExclude(serverUrl, projectKey, { id, key });
    info('');
    info(renderAgentFailure(key, result.exitCode));
    // Surface the agent's own exit code as ours: a script wrapping `motir next`
    // must be able to tell a failed run from a successful one.
    process.exitCode = result.exitCode;
    return;
  }

  // Exit 0 means the agent completed the prompt's GIT WORKFLOW section, whose
  // last step is opening the PR / integrating the branch. Both modes therefore
  // land the item at In Review — the "PR created" step of the documented status
  // lifecycle — which is also what makes the subsequent `motir done` a legal
  // single hop (there is no direct in_progress → done edge).
  if (dispatch.workflowMode === 'session_lineage' && dispatch.sessionBranch) {
    await client.markIntegrated({
      key,
      sessionBranch: dispatch.sessionBranch,
      implementationHarness: HARNESS,
    });
  } else {
    await client.transitionStatus({ key, status: IN_REVIEW });
  }
  if (id) removeExclude(serverUrl, projectKey, id);

  const suspect = checkBootstrapCheckout(target);
  info('');
  info(renderAgentSuccess(key, dispatch));
  if (suspect) {
    info('');
    info(suspect.message);
    info(`Hint: ${suspect.hint}`);
  }
}

// ── motir next ──────────────────────────────────────────────────────────────

export interface NextOptions extends DeliveryOptions {
  kinds?: string;
  /** `--reset` — clear this project's session exclude list first. */
  reset?: boolean;
}

export async function nextCommand(opts: NextOptions): Promise<void> {
  const kinds = parseKinds(opts.kinds);
  await withProjectSession(async (session) => {
    const { client, serverUrl, projectKey } = session;
    if (opts.reset) {
      const cleared = clearExcludes(serverUrl, projectKey);
      info(`Cleared ${cleared} excluded item${cleared === 1 ? '' : 's'}.`);
    }
    const excluded = readExcludes(serverUrl, projectKey);
    if (excluded.length > 0) {
      info(`Skipping ${excluded.length} previously-failed item(s): ${keyList(excluded)}.`);
    }

    const { item } = await client.nextReady({
      projectKey,
      ...(kinds ? { kinds } : {}),
      ...(excluded.length > 0 ? { excludeIds: excluded.map((e) => e.id) } : {}),
    });
    if (!item) {
      info(
        excluded.length > 0
          ? 'No ready work items (excluding the skipped ones — `motir next --reset` to retry them).'
          : 'No ready work items.',
      );
      return;
    }

    await ensureInProgress(client, item.key, item.status?.key);
    const dispatch = await client.dispatchPrompt(item.key);
    await deliver({
      session,
      key: item.key,
      title: item.title,
      id: item.id,
      dispatch,
      opts,
    });
  });
}

function keyList(entries: { key: string }[]): string {
  return entries.map((e) => e.key).join(', ');
}

// ── motir run <key> ─────────────────────────────────────────────────────────

export interface RunOptions extends DeliveryOptions {
  /** `--force` — dispatch even though the item is not ready. */
  force?: boolean;
}

/**
 * Build the refusal for a not-ready item. Readiness is DEPENDENCY-ONLY, so the
 * message names the open blockers: the human then decides whether the override
 * is correct (they may know the blocker is about to merge). That is why
 * `--force` exists at all rather than the CLI silently deciding.
 */
export function notReadyError(detail: {
  identifier: string;
  openBlockers: { identifier: string; title: string }[];
  blockedByAncestor: { identifier: string } | null;
}): CliError {
  const reasons: string[] = detail.openBlockers.map((b) => `${b.identifier} (${b.title})`);
  if (detail.blockedByAncestor) {
    reasons.push(`its ancestor ${detail.blockedByAncestor.identifier} is blocked`);
  }
  const because = reasons.length > 0 ? ` Waiting on: ${reasons.join(', ')}.` : '';
  return new CliError(`${detail.identifier} is not ready.${because}`, {
    hint: `Pass --force to dispatch it anyway.`,
  });
}

export async function runCommand(key: string, opts: RunOptions): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new CliError('A work item key is required, e.g. `motir run PROD-7`.');
  await withProjectSession(async (session) => {
    const { client } = session;
    const detail = await client.getWorkItem(trimmed);
    const { item, readiness } = detail;

    if (!readiness.ready && !opts.force) {
      throw notReadyError({
        identifier: item.identifier,
        openBlockers: readiness.openBlockers,
        blockedByAncestor: readiness.blockedByAncestor,
      });
    }
    if (!readiness.ready) {
      info(`${item.identifier} is not ready — dispatching anyway (--force).`);
    }

    await ensureInProgress(client, item.identifier, item.status);
    const dispatch = await client.dispatchPrompt(item.identifier);
    await deliver({
      session,
      key: item.identifier,
      title: item.title,
      id: item.id,
      dispatch,
      opts,
    });
  });
}

// ── motir done <key> | --session <branch> ───────────────────────────────────

export interface DoneOptions {
  /** `--session <branch>` — bulk close-out for a merged session PR. */
  session?: string;
  /**
   * `--via <status>` — walk to done through this status first. The default
   * workflow has no direct `in_progress → done` edge, so an item whose PR was
   * merged without the CLI ever seeing the agent finish (the `--print` /
   * copy-paste path) needs the In Review hop. Opt-in, never inferred: the CLI
   * does not silently move an item through a status the user did not name.
   */
  via?: string;
}

export async function doneCommand(key: string | undefined, opts: DoneOptions): Promise<void> {
  if (opts.session) {
    if (key) {
      throw new CliError('Pass either a work item key or --session <branch>, not both.');
    }
    await withProjectSession(async ({ client }) => {
      const result = await client.completeSession({
        sessionBranch: opts.session as string,
        implementationHarness: HARNESS,
      });
      info(renderSessionOutcomes(result.sessionBranch, result.results));
    });
    return;
  }

  const trimmed = (key ?? '').trim();
  if (!trimmed) {
    throw new CliError('A work item key is required, e.g. `motir done PROD-7`.', {
      hint: 'Or close out a merged session PR with `motir done --session <branch>`.',
    });
  }

  await withProjectSession(async ({ client, serverUrl, projectKey }) => {
    if (opts.via) {
      await client.transitionStatus({ key: trimmed, status: opts.via });
      info(`${trimmed}: → ${opts.via}`);
    }
    try {
      await client.transitionStatus({ key: trimmed, status: DONE });
    } catch (err) {
      // The tool's own error text NAMES the allowed targets — surface it
      // verbatim rather than paraphrasing, and add the one-hop hint only when
      // the user has not already asked for a hop.
      if (err instanceof CliError && !opts.via) {
        throw new CliError(err.message, {
          hint: `If the PR is merged but the item never reached In Review, try \`motir done --via ${IN_REVIEW} ${trimmed}\`.`,
        });
      }
      throw err;
    }
    removeExcludeByKey(serverUrl, projectKey, trimmed);
    info(`${trimmed}: done.`);
  });
}
