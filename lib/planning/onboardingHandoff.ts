import { ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';
import type { PlanningLaunchContext } from '@/lib/planning/launcher';
import {
  ONBOARDING_ROUTING_OUTCOMES,
  type OnboardingRoutingOutcome,
  type OnboardingRoutingVerdict,
} from '@/lib/dto/onboardingRouting';
import { isMigrateOnboardingStep } from '@/lib/dto/migrateOnboarding';
import {
  INSTALL_RETURN_CONTEXT_KEYS,
  INSTALL_RETURN_CONTEXT_MAX_LENGTH,
  type InstallReturnContext,
} from '@/lib/github/installReturnContext';

// WHERE THE HAND-OFF GOES, and what it takes with it (Story MOTIR-4753 ·
// MOTIR-4769).
//
// ⚠️ THE MOVE LEAVES THE ROUTE GROUP, which is why anything at all has to
// travel. `PlanningWorkspaceOverlay` is mounted in `app/(authed)/layout.tsx` and
// nowhere else; `app/(onboarding)/` is a SIBLING group that mounts none. So this
// is not a modal swap — it unmounts the overlay and leaves `(authed)` entirely,
// and there is no page underneath to come back to. Everything the return trip
// (MOTIR-4770) will need has to be written into the address on the way out.
//
// ⚠️ WHAT TRAVELS, AND WHY EACH:
//
//   the LAUNCH CONTEXT   the return address. Without it there is nothing to come
//                        back TO — only a generic workspace.
//   the KEPT STEPS       the wizard renders exactly this set (MOTIR-4759). It is
//                        the planner's answer and the rail cannot derive it.
//   the OUTCOME          which flow this is, so the destination does not have to
//                        re-derive a decision that was already made.
//
// ⚠️ AND WHAT DOES NOT: the MISSING-LIST. It is prose, and its rendering surface
// is the hand-off the user has just read — not the wizard. Putting a paragraph
// through a query string to redisplay it somewhere nobody asked for it would be
// carrying a payload for the sake of the manifest.

/** The query names the hand-off writes. Spelled once; read by the destination. */
export const HANDOFF_PARAM_NAMES = {
  /** Which flow — so the destination need not re-derive a settled decision. */
  outcome: 'via',
  /** The kept steps, comma-joined, in the machine's own order. */
  keptSteps: 'steps',
  /** The return address: the launch context, flattened. */
  returnKind: 'backKind',
  returnItem: 'backItem',
  returnRepo: 'backRepo',
} as const;

/** The launch context, flattened onto a query the destination can read back. */
export function handoffReturnParams(context: PlanningLaunchContext): [string, string][] {
  const out: [string, string][] = [[HANDOFF_PARAM_NAMES.returnKind, context.kind]];
  if (context.kind === 'work-item') out.push([HANDOFF_PARAM_NAMES.returnItem, context.itemKey]);
  if (context.kind === 'convention-refine') {
    out.push([HANDOFF_PARAM_NAMES.returnRepo, context.repoKey]);
  }
  return out;
}

/** The launch context, read back off a destination's query. `null` if absent. */
export function readHandoffReturn(params: URLSearchParams): PlanningLaunchContext | null {
  const kind = params.get(HANDOFF_PARAM_NAMES.returnKind);
  if (kind === 'project' || kind === 'roadmap') return { kind };
  if (kind === 'work-item') {
    const itemKey = params.get(HANDOFF_PARAM_NAMES.returnItem);
    return itemKey ? { kind, itemKey } : null;
  }
  if (kind === 'convention-refine') {
    const repoKey = params.get(HANDOFF_PARAM_NAMES.returnRepo);
    return repoKey ? { kind, repoKey } : null;
  }
  return null;
}

/**
 * The address the hand-off's button goes to.
 *
 * ⚠️ THE DESTINATION IS THE VERDICT'S, NOT THIS FUNCTION'S. There is no branch
 * here that reads the project — `onboard_new_project` is the start-fresh
 * entrance and `onboard_existing_project` is the migrate flow, because the
 * planner said so. `/onboarding`'s own entrance router
 * (`shouldRouteToMigrateWizard`) still answers *where onboarding goes* for
 * somebody who arrives by any other door; this one arrives having been told.
 */
export function handoffDestination(
  verdict: OnboardingRoutingVerdict,
  context: PlanningLaunchContext,
): string {
  // ⚠️ `wait_for_index` HAS NO DESTINATION, and the refusal is the point
  // (MOTIR-4829). Nobody is routed anywhere on that outcome: Motir is building
  // the graph and the person waits in the window they opened. Falling through to
  // the start-fresh entrance would be the worst possible move — an interview
  // about a codebase that was seconds from being readable — so it is a THROW
  // rather than a default, because a silent wrong destination is exactly the
  // failure this story exists to remove.
  if (verdict.outcome === 'wait_for_index') {
    throw new Error(
      'handoffDestination: `wait_for_index` routes nowhere — the window shows the wait (MOTIR-4829)',
    );
  }
  const path =
    verdict.outcome === 'onboard_existing_project'
      ? `${ONBOARDING_ENTRY_PATH}/migrate`
      : ONBOARDING_ENTRY_PATH;
  const query = new URLSearchParams([[HANDOFF_PARAM_NAMES.outcome, verdict.outcome]]);
  if (verdict.keptSteps?.length) {
    query.set(HANDOFF_PARAM_NAMES.keptSteps, verdict.keptSteps.join(','));
  }
  for (const [name, value] of handoffReturnParams(context)) query.set(name, value);
  return `${path}?${query.toString()}`;
}

// ── THE CONNECT STEP'S ADDRESS, THROUGH GITHUB (Story MOTIR-8241 · MOTIR-8471) ─
//
// The Connect step can send a person to GitHub to install the Motir App, and
// GitHub hands them back to `/onboarding/migrate`. Everything this module wrote
// onto the wizard's query on the way IN (the outcome, the kept steps, the return
// address) has to survive that trip, or **Save & exit** and the end of
// onboarding forget the window the person came from. It rides inside the signed
// install state (`InstallReturnContext`), and these two functions are the
// bridge in each direction.
//
// ⚠️ THE NARROWING IS `parseReturnSurfaceId`'S RULE, COPIED: a value that does
// not read back through the reader its destination uses is not carried. The
// return address must read back through `readHandoffReturn`, every kept step
// through `isMigrateOnboardingStep`, the outcome must be one the routing verdict
// has. Both directions apply it — on the way in so nothing unread is SIGNED into
// a link, and on the way out so nothing unread reaches a `Location` header even
// from a token minted by an older build.

const OUTCOMES = new Set<string>(ONBOARDING_ROUTING_OUTCOMES);

function bounded(value: string | null | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= INSTALL_RETURN_CONTEXT_MAX_LENGTH
  );
}

/** The return context read off a step's own query — only what reads back. */
export function onboardingReturnContextFrom(params: URLSearchParams): InstallReturnContext {
  const out: InstallReturnContext = {};

  const via = params.get(HANDOFF_PARAM_NAMES.outcome);
  if (bounded(via) && OUTCOMES.has(via)) out.via = via as OnboardingRoutingOutcome;

  // EVERY member must be a step this product has — a partly-readable list is
  // not the planner's answer, and carrying a filtered version of it would be.
  const steps = params.get(HANDOFF_PARAM_NAMES.keptSteps);
  if (bounded(steps)) {
    const members = steps.split(',');
    if (members.every((m) => isMigrateOnboardingStep(m))) out.steps = members.join(',');
  }

  // The return address is carried only as `readHandoffReturn` reads it, and
  // written back through `handoffReturnParams` — so a stray `backItem` beside a
  // `backKind` that does not use it is not carried either.
  const back = readHandoffReturn(params);
  if (back) {
    const pairs = handoffReturnParams(back);
    if (pairs.every(([, v]) => bounded(v))) {
      for (const [name, value] of pairs) {
        if (name === HANDOFF_PARAM_NAMES.returnKind) out.backKind = value;
        if (name === HANDOFF_PARAM_NAMES.returnItem) out.backItem = value;
        if (name === HANDOFF_PARAM_NAMES.returnRepo) out.backRepo = value;
      }
    }
  }
  return out;
}

/** A decoded return context back onto query pairs, re-narrowed, in a fixed
 *  order. Empty when nothing reads back — then the address is exactly the one a
 *  flow with no context produces. */
export function onboardingReturnContextParams(
  context: InstallReturnContext | undefined,
): [string, string][] {
  if (!context) return [];
  const raw = new URLSearchParams();
  for (const key of INSTALL_RETURN_CONTEXT_KEYS) {
    const value = context[key];
    if (typeof value === 'string') raw.set(key, value);
  }
  const narrowed = onboardingReturnContextFrom(raw);
  const out: [string, string][] = [];
  for (const key of INSTALL_RETURN_CONTEXT_KEYS) {
    const value = narrowed[key];
    if (value !== undefined) out.push([key, value]);
  }
  return out;
}
