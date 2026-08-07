import { CliError } from '../errors.js';
import { info, out } from '../output.js';
import { isInteractive, promptLineOrNull } from '../prompts.js';
import { withProjectSession, type ProjectSession } from '../session.js';
import { planReviewUrl } from '../autoLoop.js';
import {
  classifyInput,
  loopCommands,
  nextStepHint,
  onboardingUrl,
  parsePlanArgs,
  renderPlan,
  renderThread,
  scopeLabel,
  watchVerdict,
  PROPOSALS_NOT_WORK_ITEMS,
  WATCH_POLL_MS,
  WATCH_TIMEOUT_MS,
} from '../plan.js';
import type { MotirClient, PlanSession, PlanSubmitResult } from '../client.js';

// `motir plan` — TERMINAL PLANNING AS A CONVERSATION (Story 7.9 · Subtask 7.9.9
// · MOTIR-887). The CLI form of the planning front door, on the SAME server-side
// substrate the web planning workspace uses.
//
// ── Why this is a conversation and not a `plan("<description>")` call ───────
// Motir's planning front door is a persisted, resumable, multi-turn THREAD
// (Story 7.30 · MOTIR-1728): turns ACCUMULATE, and submitting sends every turn
// as ONE accumulated intent, framed so later turns REFINE earlier ones. A
// single-shot description would throw that refinement away — and, worse, would
// make the terminal the owner of a SECOND conversation about the same project.
// So this command is a CLIENT of the existing thread: it addresses it by SCOPE
// (project, or project + anchor keys), which is the thread's identity
// (`@@unique([projectId, scopeKey])`), so a turn typed here appears in the web
// panel and vice versa. That is the whole point — one conversation, two
// surfaces.
//
// ── Three contracts this command must not break ────────────────────────────
//  1. APPENDING IS NOT SUBMITTING. A turn is server-side the moment it is
//     appended, so `/exit` (and Ctrl-D, and a crash) can never lose one; only
//     `/submit` spends the owner's AI credits.
//  2. A SUBMIT PROPOSES; IT DOES NOT WRITE THE TREE. What comes back is a plan
//     of PROPOSALS. Approval happens in Motir, and nothing printed here may read
//     as "created N items" (`plan.ts`'s PROPOSALS_NOT_WORK_ITEMS rides with
//     every rendered tree).
//  3. THE CLI NEVER PICKS THE JOB KIND. motir-ai classifies expand / augment /
//     replan against the thread's own scope; there is no kind argument here and
//     no second submit surface.
//
// ── What this command deliberately does NOT do: onboard a fresh project ────
// The session submit path reaches `augment` / contextual, NEVER `generate_tree`
// (the substrate says so in `lib/mcp/tools/planSession.ts`). Generation belongs
// to the onboarding discovery interview — a different conversation substrate
// whose flow (discovery → direction docs → design-system selection) is a
// designed WEB experience a terminal would serve badly. So `motir plan` serves
// the ONGOING planning loop only and refuses an un-planned project with a
// pointer at onboarding, rather than conversing and then submitting an
// augmentation of nothing.
//
// ── Streams ────────────────────────────────────────────────────────────────
// stdout carries the RESULT (the proposal tree / the detached ids); stderr
// carries the conversation itself — the transcript, the prompt, turn
// confirmations, watch progress — so `motir plan "…" > plan.txt` keeps the
// proposals and leaves the chatter on the terminal (the output.ts split).

export interface PlanOptions {
  /** `--detach` — submit and return with the ids + review URL; do not watch. */
  detach?: boolean;
}

/** Injectable seams; never overridden in production. */
export interface PlanDeps {
  /** The conversation's line reader (stubbed by the interactive tests). */
  readLine?: (question: string) => Promise<string | null>;
  /** Whether there is a TTY to converse with. */
  interactive?: () => boolean;
  /** The watch's clock + sleep, so the poll loop is testable without waiting. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The watch's real delay between polls. Injected away in tests, so it lives
 *  here as a named seam rather than inline in the loop. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The scope arguments every session tool takes: the thread's identity. */
interface Scope {
  projectKey: string;
  targetKeys?: string[];
}

export async function planCommand(
  args: string[] = [],
  opts: PlanOptions = {},
  deps: PlanDeps = {},
): Promise<void> {
  const { targetKeys, text } = parsePlanArgs(args);
  const readLine = deps.readLine ?? promptLineOrNull;
  const interactive = deps.interactive ?? isInteractive;

  // A non-TTY invocation with no text would sit on a prompt nobody can answer.
  // Refuse BEFORE opening anything, naming the shorthand that works unattended —
  // a hung pipe is the one failure mode with no diagnosis.
  if (!text && !interactive()) {
    throw new CliError('`motir plan` needs a terminal to converse in.', {
      hint: 'Non-interactively, pass the turn as text: `motir plan "<what to change>"` (add --detach to skip the wait).',
    });
  }

  await withProjectSession(async (session) => {
    await requirePlannedProject(session);

    const scope: Scope = {
      projectKey: session.projectKey,
      ...(targetKeys.length > 0 ? { targetKeys } : {}),
    };

    const submitted = text
      ? await submitOneShot(session.client, scope, text)
      : await converse(session.client, scope, readLine);
    if (!submitted) return; // left the conversation without submitting

    info(
      `Submitted this conversation's accumulated intent (${scopeLabel(targetKeys)}) — ` +
        `job ${submitted.jobId} · plan ${submitted.planId}.`,
    );

    const reviewUrl = planReviewUrl(session.serverUrl, submitted.planId);
    if (opts.detach) {
      reportDetached(submitted, reviewUrl, targetKeys);
      return;
    }
    await watchAndShow(session.client, submitted.planId, reviewUrl, targetKeys, deps);
  });
}

/**
 * REFUSE a project that has never been planned, before a single turn is
 * appended.
 *
 * The app's own entrance fork reads `project.onboardingRanAt`
 * (`lib/planning/workspaceHost.ts`): marker null → onboarding owns you. That
 * marker does NOT cross the MCP boundary — no tool exposes a project's
 * onboarding state — so the reachable half of the same fork is the other signal
 * the fork is built around: an EMPTY tree. A project with no work items has
 * nothing for an `augment` to augment, which is exactly the case that must not
 * reach a submit.
 *
 * The two signals are not identical, and the difference is stated rather than
 * hidden: a project that finished onboarding but had every item removed reads as
 * un-planned here (and is pointed at onboarding, which is where it would in fact
 * have to start again), while a never-onboarded project that already carries
 * hand-created items is allowed to converse (and augmenting those items is a
 * sensible thing to want). Both are honest outcomes; neither submits into a
 * void.
 */
async function requirePlannedProject(session: ProjectSession): Promise<void> {
  // A COUNT, not a one-row search: "does this project have any work items" is a
  // count question, and asking it as a search was an artefact of the transport
  // that made a total free (ADR Amendment 11 Q3).
  const count = await session.client.countWorkItems({ projectKey: session.projectKey });
  if (count > 0) return;
  throw new CliError(
    `${session.projectKey} has no work items yet — there is no plan here to change.`,
    {
      hint:
        `Start it in Motir: ${onboardingUrl(session.serverUrl)} — the discovery interview is ` +
        'what GENERATES a first plan, and it is a guided web flow. `motir plan` joins the ' +
        'conversation once there is a tree to evolve.',
    },
  );
}

/** The non-interactive shorthand: append ONE turn, then submit the thread. It is
 *  a special case of the conversation, not a second model — the turn lands on
 *  the same thread the interactive form and the web panel share, so a scripted
 *  turn refines whatever was already accumulated there. */
async function submitOneShot(
  client: MotirClient,
  scope: Scope,
  body: string,
): Promise<PlanSubmitResult> {
  const session = await client.appendPlanTurn({ ...scope, body });
  info(`Turn ${session.turnCount} added to the ${scopeLabel(session.targetKeys)} conversation.`);
  return client.submitPlanSession(scope);
}

/**
 * The interactive conversation: resume the thread, show it, then read turns.
 *
 * Returns the submit result, or `null` when the user left without submitting —
 * which loses NOTHING, because every turn was already appended server-side.
 */
async function converse(
  client: MotirClient,
  scope: Scope,
  readLine: (question: string) => Promise<string | null>,
): Promise<PlanSubmitResult | null> {
  // Resume FIRST and render what is already there: a thread the user has been
  // building — in this terminal or in the browser — must not look like nothing
  // happened.
  let session: PlanSession = await client.openPlanSession(scope);
  info(renderThread(session));
  info('');
  info(loopCommands());
  info('');

  for (;;) {
    const input = classifyInput(await readLine('plan> '));
    switch (input.kind) {
      case 'none':
        continue;
      case 'help':
        info(loopCommands());
        continue;
      case 'unknown':
        info(
          `Unknown command ${input.input}. Type /help for the list, or plain text to add a turn.`,
        );
        continue;
      case 'exit':
        info(
          `Left the conversation — ${session.turnCount} turn${
            session.turnCount === 1 ? '' : 's'
          } saved and nothing submitted. Re-enter any time; the thread continues where it stopped.`,
        );
        return null;
      case 'turn':
        session = await client.appendPlanTurn({ ...scope, body: input.body });
        info(
          `Turn ${session.turnCount} added — NOT submitted. /submit sends every turn as one change.`,
        );
        continue;
      case 'submit':
        return client.submitPlanSession(scope);
    }
  }
}

/** `--detach`: the ids + the review URL, and the same two contracts a watched
 *  run prints. Nothing is waited on. */
function reportDetached(
  submitted: PlanSubmitResult,
  reviewUrl: string | null,
  targetKeys: string[],
): void {
  out(`Job: ${submitted.jobId} · Plan: ${submitted.planId}`);
  if (reviewUrl) out(`Review: ${reviewUrl}`);
  out('');
  out('The planner runs in the background — nothing here waited for it.');
  out(PROPOSALS_NOT_WORK_ITEMS);
  out('');
  out(nextStepHint(reviewUrl, targetKeys));
}

/**
 * Poll until the plan leaves `generating`, then print what was proposed.
 *
 * BOUNDED, and terminal on a dead job. A failed motir-ai job leaves its plan at
 * `generating` FOREVER — the plan substrate has no synthetic failed state — so a
 * status-only loop would poll a corpse until the timeout. `watchVerdict` reads
 * the job block for exactly that reason, and surfaces the server's own code +
 * message verbatim rather than a paraphrase the user cannot search for.
 */
async function watchAndShow(
  client: MotirClient,
  planId: string,
  reviewUrl: string | null,
  targetKeys: string[],
  deps: PlanDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? delay;
  const started = now();

  info(
    `Waiting for the planner (up to ${Math.round(WATCH_TIMEOUT_MS / 60_000)} minutes; ` +
      '--detach skips the wait)…',
  );

  for (;;) {
    const verdict = watchVerdict(await client.getPlanStatus({ planId }));
    if (verdict.kind === 'ready') break;
    if (verdict.kind === 'failed') {
      throw new CliError(
        verdict.reachable
          ? `The planning job failed — ${verdict.code}: ${verdict.message}`
          : `Motir could not reach the AI planner — ${verdict.code}: ${verdict.message}`,
        {
          hint:
            `Your turns are intact on the thread — re-run and /submit to retry. Plan ${planId}` +
            (reviewUrl ? ` · ${reviewUrl}` : ''),
        },
      );
    }
    if (now() - started >= WATCH_TIMEOUT_MS) {
      throw new CliError(
        `Plan ${planId} was still generating after ${Math.round(
          WATCH_TIMEOUT_MS / 60_000,
        )} minutes — giving up on the wait, not on the plan.`,
        {
          hint: reviewUrl
            ? `It may still land: ${reviewUrl}. Use --detach to submit without waiting.`
            : 'It may still land. Use --detach to submit without waiting.',
        },
      );
    }
    await sleep(WATCH_POLL_MS);
  }

  const plan = await client.getPlan({ planId });
  out(renderPlan(plan));
  out('');
  out(nextStepHint(reviewUrl, targetKeys));
}
