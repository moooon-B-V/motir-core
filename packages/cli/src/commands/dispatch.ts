import { CliError } from '../errors.js';
import { info, outVerbatim } from '../output.js';
import { parseKinds } from './read.js';
import { withProjectSession, type ProjectSession } from '../session.js';
import { getAgentCommand } from '../config/userConfig.js';
import {
  deriveAgentHarness,
  parseAgentCommand,
  type ParsedAgentCommand,
} from '../agentProfiles.js';
import { runAgent } from '../agentRun.js';
import { addExclude, clearExcludes, readExcludes, removeExclude } from '../sessionExcludes.js';
import {
  checkBootstrapCheckout,
  renderAgentFailure,
  renderAgentSuccess,
  renderDispatchAdvisories,
  renderDispatchSummary,
  renderSessionOutcomes,
  resolveDispatchTarget,
  type AgentSource,
} from '../dispatch.js';
import { CLI_VERSION } from '../version.js';
import type { DispatchItem, DispatchPrompt, MotirClient } from '../client.js';

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

/**
 * The harness `motir done --session` self-reports at the bulk close-out.
 *
 * This is the ONE seam where the CLI is the honest answer: nothing was launched
 * here. `done --session` runs after a human merged the pull request, minutes or
 * days after the agents that did the work exited, and the only actor present is
 * this process.
 *
 * Every seam where an agent DID run derives its harness from that agent's
 * command instead (see {@link deriveAgentHarness} · MOTIR-2419) — a CLI version
 * string there is the same on every row and therefore says nothing.
 */
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
export async function ensureInProgress(
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
  dispatch: DispatchPrompt;
  opts: DeliveryOptions;
}

/**
 * Deliver the prompt: print it, or run the agent on it and record the outcome.
 * This is the ONE place both `next` and `run` converge, so their behaviour can
 * never drift.
 */
async function deliver(input: DeliverInput): Promise<void> {
  const { session, key, title, dispatch, opts } = input;
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

  // The PROSE-vs-GRAPH warning (MOTIR-2079). It is emitted HERE, in the shared
  // `deliver`, precisely because `next` and `run` converge here — one site, and
  // the two commands can never drift on whether the human is told. It is a
  // WARNING: nothing below branches on it, no exit code changes, and no `--force`
  // is involved (see `renderDispatchAdvisories` for why a refusal would be wrong).
  const advisory = renderDispatchAdvisories(dispatch);

  if (!agent) {
    // PRINT mode: the prompt is the PAYLOAD (stdout, byte-identical), the
    // summary is DIAGNOSTICS (stderr). That split is what lets
    // `motir next --print | pbcopy` copy the prompt and nothing else, while the
    // user still sees the repo + resolved path on screen.
    info(summary);
    if (advisory) info(advisory);
    info('');
    outVerbatim(dispatch.prompt);
    return;
  }

  info(summary);
  if (advisory) info(advisory);
  info('');
  const result = await runAgent({
    command: agent.parsed,
    prompt: dispatch.prompt,
    cwd: target.cwd,
  });

  if (result.exitCode !== 0) {
    // The item stays In Progress on purpose — work was started. Record it so
    // the next `motir next` moves past it instead of re-picking the failure.
    addExclude(serverUrl, projectKey, { key });
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
  // lifecycle.
  if (dispatch.workflowMode === 'session_lineage' && dispatch.sessionBranch) {
    await client.markIntegrated({
      key,
      sessionBranch: dispatch.sessionBranch,
      // Same split as the loop's (MOTIR-2419): the harness names the agent this
      // command launched — not the CLI that launched it — and the model is the
      // agent's own report, or null.
      implementationHarness: deriveAgentHarness(agent.parsed.binary),
      implementationModel: result.model,
    });
  } else {
    await client.transitionStatus({ key, status: IN_REVIEW });
  }
  removeExclude(serverUrl, projectKey, key);

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

    const item = await claimNextNotExcluded(client, projectKey, kinds, excluded);
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
      dispatch,
      opts,
    });
  });
}

/**
 * The next ready item that is not on the persisted exclude list.
 *
 * The persisted list is keyed by KEY (MOTIR-2338) and so is the ready row, so
 * there is nothing to translate: the keys go straight to the client, which
 * skips them as it walks the ranked page (MOTIR-2398). One call, no round trip
 * per excluded item, and no row id anywhere.
 *
 * The SERVER still chooses. The client skips what this run has already tried
 * and takes the next row in the order it was given — a client that re-ranked
 * would be re-deriving the dispatch order the ready endpoint exists to own.
 */
async function claimNextNotExcluded(
  client: MotirClient,
  projectKey: string,
  kinds: string[] | undefined,
  excluded: readonly { key: string }[],
): Promise<DispatchItem | null> {
  // ONE call. The hold-out is applied inside the client's page walk (MOTIR-2398),
  // so the ask-learn-the-id-ask-again loop this used to need is gone: the
  // exclusion list is keyed by KEY and so is the ready row.
  const { item } = await client.nextReady({
    projectKey,
    ...(kinds ? { kinds } : {}),
    ...(excluded.length > 0 ? { excludeKeys: excluded.map((e) => e.key) } : {}),
  });
  return item;
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
   * workflow gained a direct `in_progress → done` edge in MOTIR-1625, so this is
   * no longer needed to close out an item dispatched with `--print`; it remains
   * for a CUSTOM workflow with no direct edge, and for a team that wants the
   * In Review hop on the record. Opt-in, never inferred: the CLI does not
   * silently move an item through a status the user did not name.
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
    removeExclude(serverUrl, projectKey, trimmed);
    info(`${trimmed}: done.`);
  });
}
