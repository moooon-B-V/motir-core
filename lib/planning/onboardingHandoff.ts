import { ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';
import type { PlanningLaunchContext } from '@/lib/planning/launcher';
import type { OnboardingRoutingVerdict } from '@/lib/dto/onboardingRouting';

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
