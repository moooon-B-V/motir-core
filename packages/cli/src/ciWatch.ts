import { runAgent as defaultRunAgent, type AgentRunResult } from './agentRun.js';
import type { ParsedAgentCommand } from './agentProfiles.js';
import type { MotirClient, WorkItemDelivery } from './client.js';

// WATCH CI, AND FIX RED (Story MOTIR-3655 · MOTIR-3685) — the phase every lane
// runs after its pull requests are open.
//
// ── The shape, in one table ────────────────────────────────────────────────
//
//   green   (every delivery `passing`)   → done
//   pending (any `running` / unrecorded) → keep waiting; DOES NOT COUNT
//   red     (any `failing`)              → count it, dispatch a fixing iteration
//
// A red check does NOT change a card's status. `implemented` is exactly right
// for code that is committed and whose build has not spoken; moving it back
// would say the work was not done, which is false.
//
// ── The verdict is the SERVER'S, not the CLI's ────────────────────────────
// Every state read here comes from `deliveries[].ci`, which is
// `derivePrCiState` at the latest recorded sha (MOTIR-3697 published it for
// exactly this consumer). Shelling to `gh pr checks` would be a SECOND verdict —
// different inputs, different rules — and it would drift from the pill a person
// reads on the same card. There is no `gh` in this file and there must not be.
//
// ── Why pending never counts ──────────────────────────────────────────────
// The budget is for FIXES, and a fix is a response to a verdict. While CI is
// running the loop has received no verdict; spending an attempt on it would let
// a slow build exhaust the budget without a single failure ever being seen.

/**
 * THE CAP — five fixing attempts. The sixth red gives up.
 *
 * ⚠️ It is hardcoded here and it is NOT buried: it becomes a per-project SETTING
 * under the hosted-agent epic (MOTIR-673), and it will live beside the other
 * dispatch settings on the project's own settings surface — the same place
 * `findingsPolicy` and the repository set are configured — because it is a
 * property of how a PROJECT wants its agents to behave, not of one run.
 *
 * Five is also the whole flake policy. Every fixing iteration pushes and
 * re-triggers CI, so a genuine flake gets five fresh rolls; red six times
 * running is not a flake. No separate flake handling is built, and building one
 * would be a second mechanism guessing at the same question.
 */
export const CI_FIX_ATTEMPTS = 5;

/**
 * `1 attempt` / `2 attempts`, in the one place both report lines read it from.
 *
 * Exported so it can be asserted directly: the SINGULAR arm is unreachable while
 * {@link CI_FIX_ATTEMPTS} is 5 and becomes reachable the moment it is a setting
 * (MOTIR-673) somebody sets to 1 — a branch that is dead today and alive after a
 * config change is exactly the kind a test has to pin now rather than later.
 */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export type CiVerdict =
  /** Every delivery `passing`. */
  | 'green'
  /** At least one `failing`. Any red makes the SET red. */
  | 'red'
  /** No failure, and at least one delivery without a terminal verdict. */
  | 'pending'
  /**
   * There is nothing to watch — no deliveries recorded, or a server too old to
   * publish them at all.
   *
   * ⚠️ NOT `green`. A card whose pull requests are unknown to this build has not
   * been shown to pass; calling it green would announce a result nobody
   * measured. The lanes treat it as "skip the watch", which is what they did
   * before this phase existed.
   */
  | 'nothing';

/**
 * The verdict over a whole delivery set.
 *
 * ⚠️ RED WINS OVER PENDING. One green and one running is *running*; one green
 * and one failing is *failing*. A set with both a failure and a pending member
 * is RED, because the failure is a verdict that has already arrived and waiting
 * for the other one changes nothing about it.
 */
export function ciVerdict(deliveries: readonly WorkItemDelivery[] | undefined): CiVerdict {
  if (deliveries === undefined || deliveries.length === 0) return 'nothing';
  if (deliveries.some((d) => d.ci === 'failing')) return 'red';
  if (deliveries.every((d) => d.ci === 'passing')) return 'green';
  return 'pending';
}

/** The deliveries a red verdict is about — what the fixing iteration is pointed
 *  at and what a give-up names. */
export function failingDeliveries(
  deliveries: readonly WorkItemDelivery[] | undefined,
): WorkItemDelivery[] {
  return (deliveries ?? []).filter((d) => d.ci === 'failing');
}

export type CiWatchOutcome =
  /** Every delivery went green — with or without fixes along the way. */
  | { kind: 'green'; attempts: number }
  /** Nothing to watch. The lane continues exactly as it did before this phase. */
  | { kind: 'nothing' }
  /**
   * The SIXTH red. The cards stay at `implemented`, the lane reports, and the
   * command exits non-zero — it must be obvious it gave up rather than
   * succeeded.
   */
  | { kind: 'gave_up'; attempts: number; failing: WorkItemDelivery[] }
  /** A fixing agent itself failed to run. Distinct from a give-up: the build was
   *  never re-tested, so reporting "five fixes did not work" would be false. */
  | { kind: 'fix_failed'; attempts: number; detail: string };

export interface CiWatchInput {
  client: Pick<MotirClient, 'getWorkItem'>;
  /** The card whose delivery set is watched. For `motir auto`, the run watches
   *  each card it carried in turn — the set is a property of the CARD. */
  key: string;
  /**
   * Run one fixing iteration against the failing deliveries. Returns whether the
   * agent ran successfully; the loop re-reads the verdict either way.
   *
   * Supplied by the LANE, because what a fixing iteration is differs by lane —
   * `run` and `batch` dispatch into the card's own checkout, `auto` into the
   * session's — and because a lane that cannot fix (a `--print` run) passes none.
   */
  fix: (failing: WorkItemDelivery[], attempt: number) => Promise<{ ok: boolean; detail?: string }>;
  /** Wait between polls while CI is still running. Injected so a test does not
   *  spend real seconds proving that pending does not consume the budget. */
  wait: () => Promise<void>;
  /** Progress, one line at a time. */
  report: (line: string) => void;
  /**
   * A bound on POLLS, not on fixes — the loop must not spin for ever against a
   * build that never reports. Distinct from {@link CI_FIX_ATTEMPTS} on purpose:
   * exhausting it is a give-up with ZERO fixes attempted, which is a different
   * thing to say than "five fixes did not work".
   */
  maxPolls?: number;
}

/** The default poll bound — generous, because a slow build is not a failure. */
const DEFAULT_MAX_POLLS = 240;

/**
 * WATCH the card's deliveries, FIXING each red verdict, until green or the cap.
 *
 * The counter increments on a RED verdict only, and it is per RUN — for `batch`,
 * per CARD, since each iteration is its own run. **Five reds across three
 * repositories exhausts it exactly as five in one repository does**; the
 * alternative reading would triple the budget on a multi-repository card, and
 * saying so is cheaper than discovering it.
 */
export async function watchAndFixCi(input: CiWatchInput): Promise<CiWatchOutcome> {
  const maxPolls = input.maxPolls ?? DEFAULT_MAX_POLLS;
  let reds = 0;
  let polls = 0;
  let lastReadError: string | null = null;

  for (;;) {
    if (polls >= maxPolls) {
      const detail =
        lastReadError === null
          ? `CI never reported after ${polls} checks`
          : `could not read the card after ${polls} attempts — ${lastReadError}`;
      input.report(`${input.key}: ${detail}.`);
      return { kind: 'fix_failed', attempts: reds, detail };
    }
    polls += 1;

    // ⚠️ A READ FAILURE IS RETRIED, NEVER THROWN. By the time this runs the work
    // is committed, pushed and reviewable; a network blip must not turn a
    // successful run into a crash. It counts against `maxPolls` like any other
    // poll, so a server that stays unreachable ends the watch rather than
    // spinning — and ends it as `fix_failed`, which exits non-zero, because "I
    // could not check the build" is a different claim from "the build is fine"
    // and the operator has to be able to tell them apart.
    let deliveries;
    try {
      deliveries = (await input.client.getWorkItem(input.key)).deliveries;
    } catch (err) {
      lastReadError = err instanceof Error ? err.message : String(err);
      await input.wait();
      continue;
    }
    const verdict = ciVerdict(deliveries);

    if (verdict === 'nothing') return { kind: 'nothing' };
    if (verdict === 'green') {
      input.report(
        reds === 0
          ? `${input.key}: CI is green.`
          : `${input.key}: CI is green after ${pluralize(reds, 'fix', 'fixes')}.`,
      );
      return { kind: 'green', attempts: reds };
    }
    if (verdict === 'pending') {
      await input.wait();
      continue;
    }

    // RED.
    const failing = failingDeliveries(deliveries);
    if (reds >= CI_FIX_ATTEMPTS) {
      // THE SIXTH RED. The budget was spent on the five before it.
      input.report(
        `${input.key}: giving up after ${pluralize(reds, 'fixing attempt')} — ` +
          `still failing: ${failing.map((d) => `${d.repo}#${d.number}`).join(', ')}.`,
      );
      return { kind: 'gave_up', attempts: reds, failing };
    }

    reds += 1;
    input.report(
      `${input.key}: CI is red in ${failing.map((d) => `${d.repo}#${d.number}`).join(', ')} — ` +
        `fixing attempt ${reds} of ${CI_FIX_ATTEMPTS}.`,
    );
    const result = await input.fix(failing, reds);
    if (!result.ok) {
      // The fixing AGENT failed, which is not the same as the build failing five
      // times: the build was never re-tested, so reporting a give-up would be a
      // false statement about CI.
      input.report(`${input.key}: the fixing agent failed — ${result.detail ?? 'no detail'}.`);
      return { kind: 'fix_failed', attempts: reds, detail: result.detail ?? 'the agent failed' };
    }
    // The fix pushed, so CI restarts. Wait before re-reading, or the next poll
    // reads the verdict the fix was answering and burns an attempt on it.
    await input.wait();
  }
}

/**
 * The FIXING ITERATION's prompt.
 *
 * ⚠️ WHAT IT IS TOLD MATTERS AS MUCH AS WHAT IT IS GIVEN. This repository's
 * standing rule is *a failed test is DEBUGGED before it is re-run*, and an agent
 * handed a red check will confidently invent a fix for an environmental failure —
 * a connection reset, a webServer death, a cold-compile timeout. So the prompt
 * asks for the actual failure FIRST and explicitly permits changing nothing.
 *
 * ⚠️ An iteration that correctly changes NOTHING still counts toward the five,
 * and does not end the loop early. That is deliberate and it is what makes the
 * cap do the flake work: a genuine flake gets five fresh CI rolls, and an agent
 * that correctly declines to patch around one has still used a roll. Ending the
 * loop on a no-op would turn the single most common right answer into a give-up.
 *
 * ⚠️ AND IT SAYS WHAT NOT TO RUN, because the pull toward re-running is
 * strongest exactly here and it does not feel like waste — it feels like
 * checking your work. An agent handed a red suite naturally reaches for that
 * suite to confirm the fix, and in THIS loop that reach is not merely redundant
 * but structurally so: every fixing iteration pushes, every push re-triggers
 * CI, so the loop's next poll is already guaranteed to produce the verdict the
 * local run is trying to anticipate. The cost is paid three times over — an
 * attempt out of five is blocked while it runs, the machine is shared so a wide
 * run manufactures failures belonging to other sessions, and the copy it
 * produces is not merged with the default branch, so it is the weaker evidence.
 * Observed: a run whose CI named ONE file fixed that file, then ran 294 files to
 * check the blast radius, harvested five unrelated database-contention failures,
 * and began triaging them.
 *
 * The first-pass rule lives in `promptTemplate.ts` (`WHAT_TO_DO.code` step 4)
 * and is unchanged; this is the SECOND pass, which nothing covered.
 *
 * It is repair work on pull requests that already exist — NOT a new card. It
 * links nothing, claims nothing, and transitions nothing.
 */
export function renderFixPrompt(input: {
  key: string;
  title: string | null;
  failing: readonly WorkItemDelivery[];
  attempt: number;
}): string {
  const lines: string[] = [];
  lines.push(`# Make the build pass — ${input.key}${input.title ? ` (${input.title})` : ''}`);
  lines.push('');
  lines.push(
    `CI is RED on work that is already committed and pushed. This is attempt ${input.attempt} of ${CI_FIX_ATTEMPTS}.`,
  );
  lines.push('');
  lines.push('## The failing pull requests');
  lines.push('');
  for (const d of input.failing) {
    lines.push(`- **${d.repo}#${d.number}** — ${d.url}`);
  }
  lines.push('');
  lines.push('## What to do');
  lines.push('');
  lines.push('1. **Read the ACTUAL failure first** — the assertion, the locator, the');
  lines.push('   stack, the job log. Not the summary line, and not a guess from the');
  lines.push('   test name.');
  lines.push('2. **Decide what kind of failure it is.**');
  lines.push('   - **Caused by this branch** → fix it. Commit to the SAME branch and');
  lines.push('     push; the existing pull request picks it up. Open no new pull');
  lines.push('     request and link nothing — this is repair work on a pull request');
  lines.push('     that already exists.');
  lines.push('     **THE PUSH IS THE VERIFICATION.** This loop re-triggers CI on');
  lines.push('     every push, so the next verdict IS your confirmation — you do');
  lines.push('     not have to produce one. You may run AT MOST the single file');
  lines.push('     the log named, and only because it is seconds. NEVER the suite,');
  lines.push('     never a coverage run, and never a wider sweep to check that');
  lines.push('     nothing else broke: that is the same measurement taken twice,');
  lines.push('     the second time slower, on a shared machine, and NOT merged');
  lines.push('     with the default branch — so it is the less trustworthy copy.');
  lines.push('   - **ENVIRONMENTAL** — a connection reset, a runner or webServer death,');
  lines.push('     a first-hit cold-compile timeout, a different test failing each run —');
  lines.push('     then **say so and change NOTHING**. Pushing a speculative patch to');
  lines.push('     chase a flake makes the diff worse and hides the real signal.');
  lines.push('3. Do not touch the work item: leave its status, and record no');
  lines.push('   transition. The build decides when it moves.');
  lines.push('');
  lines.push('Changing nothing is a legitimate outcome and is sometimes the right one.');
  return lines.join('\n');
}

/**
 * THE LANE-FACING PHASE — watch, and dispatch a fixing agent on each red.
 *
 * One function for all three lanes, because the loop is the same everywhere and
 * only WHERE the fixing agent stands differs: `run` and `batch` put it in the
 * card's own checkout, `auto` in the session's. That is a `cwd`, not a lane.
 */
export interface CiWatchPhaseInput {
  client: Pick<MotirClient, 'getWorkItem'>;
  key: string;
  title: string | null;
  agent: ParsedAgentCommand;
  /** Where the fixing agent runs — the checkout holding the branch CI is red on. */
  cwd: string;
  report: (line: string) => void;
  runAgentFn?: (input: {
    command: ParsedAgentCommand;
    prompt: string;
    cwd: string;
  }) => Promise<AgentRunResult>;
  wait?: () => Promise<void>;
  maxPolls?: number;
}

/** How long to wait between polls. A build takes minutes; polling faster only
 *  spends API calls to learn the same thing. */
const POLL_INTERVAL_MS = 20_000;

const realWait = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, POLL_INTERVAL_MS);
  });

export async function runCiWatchPhase(input: CiWatchPhaseInput): Promise<CiWatchOutcome> {
  const runAgentFn = input.runAgentFn ?? defaultRunAgent;
  return watchAndFixCi({
    client: input.client,
    key: input.key,
    report: input.report,
    wait: input.wait ?? realWait,
    ...(input.maxPolls === undefined ? {} : { maxPolls: input.maxPolls }),
    fix: async (failing, attempt) => {
      const result = await runAgentFn({
        command: input.agent,
        prompt: renderFixPrompt({ key: input.key, title: input.title, failing, attempt }),
        cwd: input.cwd,
      });
      return result.exitCode === 0
        ? { ok: true }
        : {
            ok: false,
            detail: result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`,
          };
    },
  });
}
