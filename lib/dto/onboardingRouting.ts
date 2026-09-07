// THE ROUTING VERDICT, as motir-core reads it off the wire (Story MOTIR-4753 ·
// MOTIR-4769).
//
// ⚠️ THE PRODUCER IS `motir-ai` AND THE JUDGEMENT IS ENTIRELY ITS OWN
// (MOTIR-4767). Whether this project can be planned from what it has is a
// question no predicate can answer — the shapes a project can be in are
// uncountable — so the planner decides and this side CARRIES the answer.
//
// ⚠️ SO THERE IS NO HEURISTIC HERE, AND THERE MUST NOT BE ONE. A consuming
// surface that adds its own sanity check — *the planner said this project is
// plannable but the item count looks low, so let us onboard them anyway* —
// reinstates exactly the proxy this story removed, in a place nobody will look
// for it, and it will be added in good faith by somebody defending against a bad
// verdict.
//
// The ONE thing this module may refuse is a verdict it cannot PARSE — an unknown
// outcome, a kept step the wizard does not have, a missing message. That is not
// disagreeing with a well-formed answer; it is declining a malformed one, and
// the two must not be confused. A refusal takes the SAFE route
// ({@link ONBOARDING_ROUTING_REFUSAL}) and is reported as a refusal rather than
// presented as a judgement about the project.

import type { MigrateOnboardingStepDto } from '@/lib/dto/migrateOnboarding';

/** What the planner decided about this run. */
export type OnboardingRoutingOutcome =
  /**
   * The substrate answers what planning needs — no onboarding.
   *
   * ⚠️ AND NOTHING WAS PLANNED. The window stays and the session becomes an
   * ordinary planning session that ASKS the user what to plan (Yue,
   * 2026-09-07). The verdict's `message` is that opening question.
   */
  | 'continue'
  /** Nothing readable — the user goes to the start-fresh entrance. */
  | 'onboard_new_project'
  /** Something real, something missing — the user goes to the migrate flow. */
  | 'onboard_existing_project'
  /**
   * THE REPOSITORY IS THERE AND ITS CODE GRAPH IS NOT (MOTIR-4828 / MOTIR-4829).
   *
   * ⚠️ NOBODY IS ROUTED ANYWHERE, which is what makes it unlike the two
   * onboarding outcomes: there is no destination and no button that leads to
   * one. Motir is building the graph, the surface shows that, and the person
   * plans when it lands. `handoffDestination` refuses it for exactly that
   * reason — a hand-off with nowhere to hand off to is a dead end.
   */
  | 'wait_for_index';

/** Every outcome, for a caller that has to enumerate them. */
export const ONBOARDING_ROUTING_OUTCOMES: readonly OnboardingRoutingOutcome[] = [
  'continue',
  'onboard_new_project',
  'onboard_existing_project',
  'wait_for_index',
];

/**
 * The migrate wizard's steps, as a verdict may name them.
 *
 * ⚠️ TYPED AGAINST THE STATE MACHINE'S OWN DTO, not against a local list. A
 * verdict naming a step this product does not have must be refused HERE rather
 * than rendered as a broken rail there, and the only way that stays true as the
 * machine grows is if the check reads the machine's own enum.
 */
export const MIGRATE_ROUTING_STEPS = [
  'connect',
  'index',
  'import',
  'audit_convention',
  'discovery',
  'generate',
  'review',
] as const satisfies readonly MigrateOnboardingStepDto[];

export type MigrateRoutingStep = (typeof MIGRATE_ROUTING_STEPS)[number];

/** The verdict, as the surface that acts on it reads it. */
export interface OnboardingRoutingVerdict {
  outcome: OnboardingRoutingOutcome;
  /**
   * WHAT THE USER READS — the planner's own turn, rendered in the conversation.
   *
   * On `continue` it ends in the ASK; on either onboarding outcome it says what
   * was found and where they are going. Never a report, and never an apology:
   * nothing failed, the read worked and it produced a finding.
   */
  message: string;
  /** Which steps the migrate wizard should RUN — `onboard_existing_project` only. */
  keptSteps?: MigrateRoutingStep[];
  /**
   * What is missing, in the user's own words — SHORT SEPARATE ITEMS, because the
   * hand-off renders one row per entry (`design/ai-chat/reading-and-handoff.mock.html`
   * panel 4). `onboard_existing_project` only.
   */
  missing?: string[];
}

/**
 * THE SAFE ROUTE for a verdict this side could not parse.
 *
 * ⚠️ IT IS THE ONE OUTCOME WITH NO PRECONDITION, which is what makes it safe.
 * `continue` requires a linked repository and `onboard_existing_project`
 * requires something to build on; a refusal is precisely the state in which we
 * do not know that either holds.
 */
export const ONBOARDING_ROUTING_REFUSAL =
  'onboard_new_project' as const satisfies OnboardingRoutingOutcome;

/** A parsed verdict, or the reason this side declined the one it was sent. */
export type OnboardingRoutingRead =
  | { ok: true; verdict: OnboardingRoutingVerdict }
  | { ok: false; outcome: typeof ONBOARDING_ROUTING_REFUSAL; reason: string };

const isStep = (v: unknown): v is MigrateRoutingStep =>
  typeof v === 'string' && (MIGRATE_ROUTING_STEPS as readonly string[]).includes(v);

/**
 * Read the verdict off a job's result envelope. Pure, total, and it never
 * throws.
 *
 * ⚠️ IT ONLY EVER DECLINES A MALFORMED ANSWER. Every branch below is a SHAPE
 * check — is the outcome one of three, is the message a non-empty string, is
 * every kept step one this product has. None of them looks at the project. A
 * well-formed verdict is acted on exactly as given, including one this side
 * might find surprising: that is the whole value of asking a judge.
 */
export function readOnboardingRoutingVerdict(result: unknown): OnboardingRoutingRead | null {
  if (typeof result !== 'object' || result === null) return null;
  const raw = (result as Record<string, unknown>)['onboardingRouting'];
  // NOT a refusal: an envelope with no verdict is a run that was never asked for
  // one. `null` says *no answer here*, which is different from *a bad answer*.
  if (raw === undefined || raw === null) return null;

  const declined = (reason: string): OnboardingRoutingRead => ({
    ok: false,
    outcome: ONBOARDING_ROUTING_REFUSAL,
    reason,
  });

  if (typeof raw !== 'object') return declined('verdict is not an object');
  const obj = raw as Record<string, unknown>;

  const outcome = obj['outcome'];
  if (!ONBOARDING_ROUTING_OUTCOMES.includes(outcome as OnboardingRoutingOutcome)) {
    return declined(`unknown outcome: ${String(outcome)}`);
  }
  const message = typeof obj['message'] === 'string' ? obj['message'].trim() : '';
  if (message.length === 0) return declined('verdict carries no message');

  const verdict = outcome as OnboardingRoutingOutcome;
  if (verdict !== 'onboard_existing_project')
    return { ok: true, verdict: { outcome: verdict, message } };

  const rawSteps = obj['keptSteps'];
  if (!Array.isArray(rawSteps) || !rawSteps.every(isStep)) {
    return declined(`kept steps this product does not have: ${JSON.stringify(rawSteps)}`);
  }
  const rawMissing = obj['missing'];
  const missing = Array.isArray(rawMissing)
    ? rawMissing.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    : [];

  return {
    ok: true,
    verdict: { outcome: verdict, message, keptSteps: rawSteps as MigrateRoutingStep[], missing },
  };
}
