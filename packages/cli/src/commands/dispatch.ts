import { CliError } from '../errors.js';
import { errVerbatim, info, outVerbatim } from '../output.js';
import { parseKinds } from './read.js';
import { withProjectSession, type ProjectSession } from '../session.js';
import { getAgentCommand } from '../config/userConfig.js';
import {
  deriveAgentHarness,
  parseAgentCommand,
  type ParsedAgentCommand,
} from '../agentProfiles.js';
import { runAgent } from '../agentRun.js';
import { runDispatchLeg } from '../dispatchLeg.js';
import { addExclude, clearExcludes, readExcludes, removeExclude } from '../sessionExcludes.js';
import { execCommand, runIdFromDate, sessionBranchName, type CommandRunner } from '../git.js';
import {
  claimScopeForRun,
  readOpenChildren,
  refuseLeafOnlyFlag,
  resolveScopeTarget,
  type ScopeRunOptions,
} from './scope.js';
import { openChildrenHoldReason, renderOpenChildrenHold } from '../scopedRun.js';
import { drainScope } from './scopeDrain.js';
import { autoExitCode, renderAutoSummary } from '../autoLoop.js';
import { closeOutRepos, parseMax, requireAgent } from './auto.js';
import {
  autoOnlyFlagError,
  findingsPolicyOf,
  renderAgentFailure,
  renderAgentSuccess,
  renderClaimRefusal,
  renderNothingPushed,
  renderFindingsPolicy,
  renderReplanSubmitted,
  renderDispatchAdvisories,
  renderDispatchSummary,
  renderPromptEchoHeader,
  renderResumeNotice,
  renderSessionOutcomes,
  resolveDispatchTarget,
  resolveDispatchTargets,
  type AgentSource,
  type FindingsPolicyOptions,
  type PromptEchoOptions,
} from '../dispatch.js';
import type { DispatchItem, DispatchPrompt, MotirClient, WorkItemClaim } from '../client.js';

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

/** The workflow status keys the CLI still names. All three are the default
 *  workflow's (lib/workflows/defaultWorkflow.ts); a project on a custom workflow
 *  surfaces the server's own allowed-targets error, which is the honest failure.
 *
 *  ⚠️ `in_progress` is NOT among them any more (MOTIR-3048): the dispatch flip
 *  happens inside the server's claim, so no path here writes that status and a
 *  constant for it would be a name with no caller. `planning` has gone the same
 *  way — the claim refuses it, so nothing here needs to recognise it. */
/** Where a FINISHED run leaves the card (MOTIR-3003 / MOTIR-3004): built, pushed,
 *  pull request open, CI not yet green. In Review is written by CI, never here. */
const IMPLEMENTED = 'implemented';
const IN_REVIEW = 'in_review';
const DONE = 'done';

/**
 * What `motir done --session` reports about how the work was implemented: the
 * SOURCE, and nothing else (MOTIR-2447).
 *
 * The bulk close-out runs after a human merged the pull request — minutes or
 * days after the agents that did the work exited. It knows the work was BYOK
 * (that is what this CLI is), and it knows nothing whatsoever about which agent
 * ran or on which model. It used to send `motir-cli/<version>` as the harness,
 * which overwrote the agent name and model `mark_integrated` had recorded during
 * the run — the fix in MOTIR-2419 undone by the very next step of the lifecycle.
 *
 * Reporting only this leaves those fields alone (the service treats an omitted
 * field as "I do not know", not "there is none") while still stamping the source
 * for the `--print` lane, whose items never reach `mark_integrated` and would
 * otherwise carry no implementation provenance at all.
 */
const CLOSE_OUT_SOURCE = 'byok' as const;

// ── agent resolution ────────────────────────────────────────────────────────

export interface DeliveryOptions extends FindingsPolicyOptions, PromptEchoOptions {
  /** `--agent <cmd>` — launch THIS agent on the prompt. */
  agent?: string;
  /** `--print` — print the prompt and stop (the default when no agent). */
  print?: boolean;
  /**
   * `--auto-approve-replan` — REGISTERED here in order to be REFUSED
   * (MOTIR-3022). `run` and `next` dispatch one item and exit, so there is no
   * continuation for an approval to feed; the flag belongs to `motir auto`.
   * Declaring it is what lets the guard's message reach the user instead of
   * commander's `unknown option` (MOTIR-1828 / MOTIR-1830).
   */
  autoApproveReplan?: boolean;
}

/**
 * Injectable seams; never overridden in production — and deliberately NOT on
 * `DeliveryOptions`, which is the FLAG surface (`optionRegistrationAudit` holds
 * every field there to a registered option). `motir auto` and `motir batch` take
 * their seams the same way.
 */
export interface DeliveryDeps {
  /** The git runner the push check (MOTIR-3004) asks, so a test can script "the
   *  agent pushed" / "the agent pushed nothing" without a real remote. */
  run?: CommandRunner;
  /** The agent spawner, injected by the SCOPED drain's tests (MOTIR-3199) —
   *  the same seam `motir auto`'s `AutoDeps` carries, for the same reason. */
  runAgentFn?: typeof runAgent;
  /** The run clock, so a driven drain reports deterministic durations. */
  clock?: () => number;
  /** The run id, so a driven drain gets a deterministic session branch. */
  now?: () => Date;
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
 * TAKE the card — one locked call, and it can say no (MOTIR-3048).
 *
 * This is the single funnel every dispatch path in the CLI goes through, which
 * is why the claim lives here rather than being repeated in four commands that
 * could drift. It used to make TWO unlocked writes — a `PATCH { assigneeId }`
 * followed by a `transition_status` — with a read-to-write gap between them
 * that two runs starting together fell straight into. Both are now ONE
 * `POST /work-items/{key}/claim` (MOTIR-2961), which locks the row, re-asserts
 * the TO-DO category, assigns and transitions inside one transaction. **There
 * is nothing to transition afterwards: the claim IS the status flip.**
 *
 * ⚠️ IT RETURNS THE OUTCOME, AND CALLERS MUST BRANCH ON IT. Not because a
 * refusal throws — it does not, it is a 200 — but because the four answers call
 * for four different next moves, and the value of the whole change is in
 * keeping them apart rather than collapsing them back into "did it throw". This
 * function handles the one that is pure output (`mine` prints the line the
 * documented recovery has always printed) and hands the rest to the caller,
 * whose vocabulary for a refusal differs: `run` / `next` end the command,
 * `batch` / `auto` record a SKIP and keep going.
 */
export async function ensureInProgress(client: MotirClient, key: string): Promise<WorkItemClaim> {
  const claim = await client.claimWorkItem({ key });
  if (claim.outcome === 'mine') {
    info(`${key}: already In Progress — leaving the status as it is.`);
  }
  return claim;
}

/**
 * May this run dispatch, given what the claim resolved to?
 *
 * `claimed` and `mine` are both a yes — the second is the interrupted run this
 * session is resuming, which is the recovery `motir run <key>` exists to serve.
 * Exported so the four entry points ask the SAME question rather than each
 * writing its own list of outcome strings.
 */
export function claimAllowsDispatch(claim: WorkItemClaim): boolean {
  return claim.outcome === 'claimed' || claim.outcome === 'mine';
}

/**
 * Echo the prompt this dispatch is about to send, if the run asked for it
 * (`--print-prompt`, MOTIR-3052).
 *
 * ⚠️ ONE implementation for every dispatch site, and it lives HERE rather than
 * beside its renderer in `../dispatch.js` because that module is the PURE half
 * and writes to no stream. `motir auto` and `motir batch` already import this
 * module for `ensureInProgress` / `claimAllowsDispatch`, so the four commands
 * share one writer instead of four `process.stderr.write` calls that could
 * drift on the byte that matters.
 *
 * ⚠️ IT ECHOES `dispatch.prompt` AND NEVER RE-ASSEMBLES. The prompt is already
 * in memory at every call site — the CLI has never assembled prompt text and
 * must not start here — because a transcript regenerated for display is one that
 * can disagree with the run it claims to describe, which is worse than none.
 *
 * ⚠️ AND EVERY CALLER INVOKES IT BEFORE THE AGENT STARTS. The run you most want
 * a transcript for is the one that went wrong, so the prompt must already be on
 * the stream when the agent then fails, times out, or is killed.
 *
 * The header goes through `info` (narration); the prompt through `errVerbatim`,
 * which terminates it with exactly one newline and changes nothing else — so a
 * reader slicing the header off a captured stderr holds the string the agent
 * received, byte for byte.
 */
export function echoPromptIfAsked(
  opts: PromptEchoOptions,
  key: string,
  dispatch: DispatchPrompt,
): void {
  if (!opts.printPrompt) return;
  info(renderPromptEchoHeader(key, dispatch));
  errVerbatim(dispatch.prompt);
}

interface DeliverInput {
  session: ProjectSession;
  key: string;
  title: string | null;
  dispatch: DispatchPrompt;
  opts: DeliveryOptions;
  deps: DeliveryDeps;
}

/**
 * Deliver the prompt: print it, or run the agent on it and record the outcome.
 * This is the ONE place both `next` and `run` converge, so their behaviour can
 * never drift.
 */
async function deliver(input: DeliverInput): Promise<void> {
  const { session, key, title, dispatch, opts, deps } = input;
  const { client, link, serverUrl, projectKey } = session;

  const agent = resolveAgent(opts);
  // MOTIR-3133 — one target per repository the card ships in, resolved by the
  // SAME rule, in the payload's order. The agent's cwd is element 0's — one
  // dispatch, one agent process, standing in the primary's checkout exactly as
  // it does today. An older server sends no `targetRepos`, and the empty set
  // falls straight back to the single-repository resolve.
  const targets = resolveDispatchTargets(
    link.dir,
    link.config,
    // The clone URL travels WITH the name (MOTIR-3588): a checkout that is
    // missing but materializable resolves to `clonable_checkout` rather than to
    // the workspace root.
    (dispatch.targetRepos ?? []).map((repo) => ({ name: repo.name, cloneUrl: repo.cloneUrl })),
  );
  const target =
    targets[0] ??
    resolveDispatchTarget(link.dir, link.config, dispatch.targetRepo, {
      cloneUrl: dispatch.targetRepoCloneUrl ?? null,
    });
  const summary = renderDispatchSummary({
    key,
    title,
    dispatch,
    target,
    targets,
    agent: agent ? { command: agent.parsed.command, source: agent.source } : null,
  });

  // The PROSE-vs-GRAPH warning (MOTIR-2079). It is emitted HERE, in the shared
  // `deliver`, precisely because `next` and `run` converge here — one site, and
  // the two commands can never drift on whether the human is told. It is a
  // WARNING: nothing below branches on it, no exit code changes, and no `--force`
  // is involved (see `renderDispatchAdvisories` for why a refusal would be wrong).
  const advisory = renderDispatchAdvisories(dispatch);
  // MOTIR-3136 — a partially delivered card is a legitimate resting state, and
  // a resumed run that reads like a fresh one is how an agent re-opens a pull
  // request in a repository that has already merged.
  const resume = renderResumeNotice(dispatch);

  // The policy this run used, said out loud (MOTIR-3022). Without it a run whose
  // agent FILED nothing is indistinguishable from one that was not allowed to,
  // and `--print` would show a prompt whose missing branch had no explanation.
  const policyLine = renderFindingsPolicy(opts);

  if (!agent) {
    // PRINT mode: the prompt is the PAYLOAD (stdout, byte-identical), the
    // summary is DIAGNOSTICS (stderr). That split is what lets
    // `motir next --print | pbcopy` copy the prompt and nothing else, while the
    // user still sees the repo + resolved path on screen.
    //
    // ⚠️ The policy line is DIAGNOSTICS too — it goes to stderr with the rest,
    // never into the payload, and the prompt above it is the one the agent
    // would actually receive. There is no preview-only assembly.
    info(summary);
    if (resume) info(resume);
    if (advisory) info(advisory);
    info(policyLine);
    info('');
    // ⚠️ BOTH STREAMS, and exactly once each. `--print` and `--print-prompt`
    // COMPOSE (MOTIR-3052): the payload copy goes to stdout because that is what
    // `--print` is for, and the transcript copy to stderr because that is where
    // this flag always puts it. Emitting the stderr copy first keeps the echo in
    // the same position relative to the summary as it holds on the agent path
    // below, so `2> prompts.log` reads the same either way.
    echoPromptIfAsked(opts, key, dispatch);
    outVerbatim(dispatch.prompt);
    return;
  }

  info(summary);
  if (resume) info(resume);
  if (advisory) info(advisory);
  info(policyLine);

  // ⚠️ THE SHARED LEG (MOTIR-3695) — materialize-before-spawn (MOTIR-3588),
  // echo-before-spawn (MOTIR-3052), exit-0-is-not-an-outcome (MOTIR-3018) and
  // exit-0-is-not-a-push (MOTIR-3004), in that order, from the one place that
  // implements them. `motir batch` runs the same function; what each command
  // does with the VERDICT is where they legitimately differ, and that stays
  // here.
  const verdict = await runDispatchLeg({
    client,
    rootDir: link.dir,
    key,
    dispatch,
    agent: agent.parsed,
    targets,
    primary: target,
    sessionBranch: dispatch.sessionBranch,
    onMaterialization: (lines: string[]) => {
      for (const line of lines) info(line);
    },
    beforeSpawn: () => {
      info('');
      echoPromptIfAsked(opts, key, dispatch);
    },
    ...(deps.run ? { run: deps.run } : {}),
  });

  if (verdict.kind === 'checkout_unavailable') {
    process.exitCode = 1;
    return;
  }

  if (verdict.kind === 'agent_failed') {
    // The item stays In Progress on purpose — work was started. Record it so
    // the next `motir next` moves past it instead of re-picking the failure.
    addExclude(serverUrl, projectKey, { key });
    info('');
    info(renderAgentFailure(key, verdict.exitCode, dispatch));
    // Surface the agent's own exit code as ours: a script wrapping `motir next`
    // must be able to tell a failed run from a successful one.
    process.exitCode = verdict.exitCode;
    return;
  }

  // ⚠️ EXIT 0 IS NOT AN OUTCOME (MOTIR-3018). A finished card and a REFUSED one
  // both exit 0, so the run asks the card which it was before deciding anything
  // else. This read comes FIRST — before the push check — because a refusing
  // agent reverts its worktree and pushes nothing by design, so the push check
  // would otherwise report a correctly-refused card as work that went missing.
  if (verdict.kind === 'replan_submitted') {
    // Nothing to exclude: `planning` is in the in-progress CATEGORY, so the card
    // is already out of the pickable set — which is the entire reason that
    // status exists (MOTIR-2425). Adding it to the session exclude list would
    // record a local opinion about a card the server already holds back.
    info('');
    info(renderReplanSubmitted(key));
    return;
  }

  // ⚠️ EXIT 0 IS NOT A PUSH (MOTIR-3004). `implemented` says the code is on the
  // remote and the pull request is open — a claim this run can only make by
  // checking. An agent that exits 0 having pushed nothing leaves a card asserting
  // built work that exists only in a worktree the run is about to delete, so the
  // recording is refused and the card stays In Progress, which is what an
  // interrupted run actually looks like.
  if (verdict.kind === 'nothing_pushed') {
    addExclude(serverUrl, projectKey, { key });
    info('');
    info(renderNothingPushed(key, dispatch));
    return;
  }

  // Exit 0 AND the work is on the remote: the agent completed the prompt's GIT
  // WORKFLOW section, whose last step is opening the PR / integrating the
  // branch. Both modes therefore land the item at IMPLEMENTED — built, pushed,
  // and waiting on CI, which is the step of the lifecycle this run can vouch for.
  if (dispatch.workflowMode === 'session_lineage' && dispatch.sessionBranch) {
    await client.markIntegrated({
      key,
      sessionBranch: dispatch.sessionBranch,
      // Same split as the loop's (MOTIR-2419): the harness names the agent this
      // command launched — not the CLI that launched it — and the model is the
      // agent's own report, or null.
      implementationHarness: deriveAgentHarness(agent.parsed.binary),
      implementationModel: verdict.model,
    });
  } else {
    await client.transitionStatus({ key, status: IMPLEMENTED });
  }
  removeExclude(serverUrl, projectKey, key);

  // EVERY repository of the set, not only the primary (MOTIR-3133): a card whose
  // second half had no checkout to happen in is exactly the run that otherwise
  // exits 0 with half the work missing.
  //
  // ⚠️ A WARNING here, and a FAILURE in `motir batch` — the leg reports the
  // suspects and lets each command decide, because the two genuinely disagree
  // and a refactor is not the place to settle it.
  const suspects = verdict.suspects;
  info('');
  info(renderAgentSuccess(key, dispatch));
  for (const suspect of suspects) {
    info('');
    info(suspect.message);
    info(`Hint: ${suspect.hint}`);
  }
}

/**
 * Refuse `--auto-approve-replan` on a command with no loop to continue into —
 * BEFORE anything else, so nothing is claimed for a run that cannot proceed.
 *
 * The flag is registered on these commands precisely so this message is
 * reachable; without the registration commander answers `unknown option` and
 * this function is dead code from the command line (MOTIR-1828 / MOTIR-1830).
 */
function refuseAutoOnlyFlag(opts: DeliveryOptions, command: 'run' | 'next'): void {
  if (!opts.autoApproveReplan) return;
  const { message, hint } = autoOnlyFlagError(command);
  throw new CliError(message, { hint });
}

// ── motir next ──────────────────────────────────────────────────────────────

export interface NextOptions extends DeliveryOptions {
  kinds?: string;
  /** `--reset` — clear this project's session exclude list first. */
  reset?: boolean;
}

export async function nextCommand(opts: NextOptions, deps: DeliveryDeps = {}): Promise<void> {
  refuseAutoOnlyFlag(opts, 'next');
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

    const ownerId = await resolveOwnerId(client);
    const item = await claimNextNotExcluded(client, projectKey, kinds, excluded, ownerId);
    if (!item) {
      info(
        excluded.length > 0
          ? 'No ready work items (excluding the skipped ones — `motir next --reset` to retry them).'
          : 'No ready work items.',
      );
      return;
    }

    const claim = await ensureInProgress(client, item.key);
    if (!claimAllowsDispatch(claim)) {
      // The server refused between the pick and the claim — a sibling took it,
      // or it left the to-do category. `next` has nothing else in hand, so it
      // reports and ends: re-running picks whatever is next.
      info(renderClaimRefusal(claim));
      return;
    }
    const dispatch = await client.dispatchPrompt(item.key, {
      findingsPolicy: findingsPolicyOf(opts),
    });
    await deliver({
      session,
      key: item.key,
      title: item.title,
      dispatch,
      opts,
      deps,
    });
  });
}

/**
 * The token owner's user id — who a claim assigns to (MOTIR-2427).
 *
 * One `whoami` per command invocation, not per item: the answer cannot change
 * inside a run, and an unattended loop that asked per dispatch would spend a
 * request on a constant.
 */
export async function resolveOwnerId(client: MotirClient): Promise<string> {
  return (await client.whoami()).user.id;
}

/**
 * Why a NAMED card would not have been picked — or null when it would have been.
 *
 * ONE axis now: WHOSE it is (MOTIR-3048). It used to warn about WHERE it is too
 * — `in_review`, `planning` — and then dispatch anyway, on the reasoning that a
 * person who names a key has a reason. That is a good argument about ownership
 * and a bad one about state, and the server settles the state half now: the
 * claim refuses anything outside the TO-DO category, so those two warnings
 * would describe outcomes that can no longer happen. A warning for something
 * that cannot occur is noise, and eventually a lie.
 *
 * The assignee axis stays here because it is the one the server deliberately
 * does NOT refuse: a to-do card assigned to a teammate is still claimable, and
 * taking a card off somebody is a thing a person is allowed to decide. They
 * just have to be told they are doing it.
 */
export function pickWarning(
  item: { status: string; assigneeId: string | null },
  ownerId: string,
): string | null {
  if (item.assigneeId !== null && item.assigneeId !== ownerId) {
    return 'assigned to someone else — dispatching it anyway will put two agents on one card.';
  }
  return null;
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
  ownerId: string,
): Promise<DispatchItem | null> {
  // ONE call. The hold-out is applied inside the client's page walk (MOTIR-2398),
  // so the ask-learn-the-id-ask-again loop this used to need is gone: the
  // exclusion list is keyed by KEY and so is the ready row.
  const { item } = await client.nextReady({
    projectKey,
    ownerId,
    ...(kinds ? { kinds } : {}),
    ...(excluded.length > 0 ? { excludeKeys: excluded.map((e) => e.key) } : {}),
  });
  return item;
}

function keyList(entries: { key: string }[]): string {
  return entries.map((e) => e.key).join(', ');
}

// ── motir run <key> ─────────────────────────────────────────────────────────

export interface RunOptions extends DeliveryOptions, ScopeRunOptions {
  /** `--force` — dispatch even though the item is not ready. */
  force?: boolean;
  /** `--max <n>` — stop after n cards of a SCOPE. Leaf runs ignore it. */
  max?: string;
  /** `--keep-going` — continue a SCOPE past a failed agent. */
  keepGoing?: boolean;
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

export async function runCommand(
  key: string,
  opts: RunOptions,
  deps: DeliveryDeps = {},
): Promise<void> {
  refuseAutoOnlyFlag(opts, 'run');
  const trimmed = key.trim();
  if (!trimmed) throw new CliError('A work item key is required, e.g. `motir run ACME-7`.');
  await withProjectSession(async (session) => {
    const { client } = session;

    // ── SCOPE or CARD? The SHAPE decides (MOTIR-3195 / MOTIR-3198) ──────────
    //
    // `motir run` takes a SCOPE now: a work-item key, or the reserved word
    // `sprint`. Which run it performs is decided by what the target turns out to
    // be — a leaf falls through to everything below, unchanged, byte for byte;
    // a container with children runs its leaves; an epic and a childless
    // container are refused, by `resolveScopeTarget`, with the copy the ADR
    // spells out.
    //
    // ⚠️ THIS BRANCH COSTS NOTHING, AND THAT IS LOAD-BEARING.
    // `resolveScopeTarget` makes the SAME `getWorkItem` read this function
    // already made as its first act — one line earlier — and HANDS IT BACK on
    // the leaf arm. Re-reading it here instead would put a second round-trip on
    // the path every dispatched card takes, to save threading one value.
    const decision = await resolveScopeTarget(client, trimmed, opts, session.serverUrl);
    if (decision.action === 'stop') return;
    if (decision.action === 'scope') {
      refuseLeafOnlyFlag(opts);
      // An agent is REQUIRED here, unlike on the leaf path where `--print` is the
      // default: a set has no single prompt to paste, so there is nothing for a
      // print-mode scoped run to do. The message is `motir auto`'s, verbatim,
      // because it is the same requirement for the same reason.
      const agent = requireAgent({ ...opts, print: false }, 'motir run <scope>');
      const ownerId = await resolveOwnerId(client);
      const claimed = await claimScopeForRun(session, decision.target, opts, ownerId);
      if (!claimed) return;

      const runId = runIdFromDate((deps.now ?? (() => new Date()))());
      const branch = sessionBranchName(runId);
      const run = deps.run ?? execCommand;
      const summary = await drainScope({
        session,
        opts,
        members: claimed.ready,
        edges: claimed.edges,
        max: parseMax(opts.max),
        agent,
        runId,
        branch,
        run,
        clock: deps.clock ?? Date.now,
        runAgentFn: deps.runAgentFn ?? runAgent,
      });
      // ⚠️ THE CLOSE-OUT RE-READS THE CONTAINER'S CHILDREN FIRST (Bug
      // MOTIR-3268). The claim was taken at t=0; a bug filed mid-drain
      // (MOTIR-3017) parents itself under this very container, so the set this
      // run holds is a statement about the past by the time it is finished. A
      // pull request opened over it would claim the story is built while a child
      // of its own is not — which MOTIR-3229 made REFUSABLE at the transition,
      // but only after the pull request already exists. One `get_work_item`,
      // here, is what keeps it from existing.
      const open = await readOpenChildren(client, decision.target);
      const hold =
        open && open.openChildren.length > 0
          ? openChildrenHoldReason(open.containerKey, open.openChildren)
          : null;
      if (open && hold) {
        info('');
        info(renderOpenChildrenHold(open.containerKey, open.openChildren));
      }
      // ONE pull request per TOUCHED repo, through the shipped close-out. On a
      // multi-repo scope that is one PER REPO, and the summary names each — "one
      // pull request, one CI run" is exactly true for a single-repo scope only.
      // Under a hold it still PUSHES every branch and opens none.
      closeOutRepos(summary, run, hold);
      info('');
      info(renderAutoSummary(summary));
      info(renderFindingsPolicy(opts));
      process.exitCode = autoExitCode(summary);
      return;
    }

    const detail = decision.detail;
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

    // `run` is GIVEN a card by a person; `next` / `auto` / `batch` PICK one. So
    // the ASSIGNEE axis warns here instead of refusing (MOTIR-2427): a human who
    // names a key has a reason to take a card off a teammate, and refusing
    // outright would break the documented recovery for a card an agent left in
    // progress. The warning still has to be said — dispatching onto a
    // teammate's live card is the failure this whole card exists to make
    // visible, and silence is what made it invisible.
    //
    // The STATUS axis is no longer warned about (MOTIR-3048). The claim below
    // refuses anything outside the to-do category, so `in_review`, `planning`
    // and `done` are answered by the server, in the one place they can actually
    // be enforced.
    const ownerId = await resolveOwnerId(client);
    const warning = pickWarning(item, ownerId);
    if (warning) info(`${item.identifier}: ${warning}`);

    const claim = await ensureInProgress(client, item.identifier);
    if (!claimAllowsDispatch(claim)) {
      // ⚠️ A REFUSAL ENDS THE COMMAND — cleanly, not as an error. `run` was
      // given ONE card and cannot substitute another, and the four outcomes are
      // ordinary states rather than failures, so there is nothing to throw:
      // the refusal names who holds it, or where it is, and exits 0.
      info(renderClaimRefusal(claim));
      return;
    }
    const dispatch = await client.dispatchPrompt(item.identifier, {
      findingsPolicy: findingsPolicyOf(opts),
    });
    await deliver({
      session,
      key: item.identifier,
      title: item.title,
      dispatch,
      opts,
      deps,
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
        implementationSource: CLOSE_OUT_SOURCE,
      });
      info(renderSessionOutcomes(result.sessionBranch, result.results));
    });
    return;
  }

  const trimmed = (key ?? '').trim();
  if (!trimmed) {
    throw new CliError('A work item key is required, e.g. `motir done ACME-7`.', {
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
