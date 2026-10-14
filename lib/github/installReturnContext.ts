// THE INSTALL STATE'S RETURN CONTEXT — its shape only (Story MOTIR-8241 ·
// MOTIR-8471).
//
// ⚠️ A MODULE OF ITS OWN, AND IT MUST STAY PURE. `installState.ts` signs with
// `node:crypto`; `lib/planning/onboardingHandoff.ts` narrows these values and is
// imported by the migrate wizard, a CLIENT island. Declaring the shape here lets
// both read it without dragging the signer into a browser bundle.

/**
 * THE STEP'S OWN ADDRESS, carried through the install (Story MOTIR-8241 ·
 * MOTIR-8471) — payload key `c`. The five values the onboarding hand-off writes
 * onto the migrate wizard's query (`HANDOFF_PARAM_NAMES` in
 * `lib/planning/onboardingHandoff.ts`): the routing outcome, the kept steps and
 * the plan-window return address. Without them, a person who leaves the
 * Connect step for GitHub comes back to a wizard that has forgotten where
 * **Save & exit** and the end of onboarding go (MOTIR-4770).
 *
 * ⚠️ THE SIGNER (`installState.ts`) NARROWS ONLY THE SHAPE: a known key, a string, at most
 * {@link INSTALL_RETURN_CONTEXT_MAX_LENGTH} characters. What each value MEANS
 * is narrowed by the module that owns it, `onboardingReturnContextFrom` /
 * `onboardingReturnContextParams`, on the way in AND on the way out — so
 * nothing read off an address reaches a `Location` header without going through
 * the same reader its destination uses.
 */
export interface InstallReturnContext {
  via?: string;
  steps?: string;
  backKind?: string;
  backItem?: string;
  backRepo?: string;
}

/** The context's keys, in the order they are written back onto an address. */
export const INSTALL_RETURN_CONTEXT_KEYS = [
  'via',
  'steps',
  'backKind',
  'backItem',
  'backRepo',
] as const satisfies readonly (keyof InstallReturnContext)[];

/** The longest value the context carries. A work-item key, a repository key or
 *  the comma-joined step list are all far shorter; anything longer is not one
 *  of them and is dropped rather than signed into a link. */
export const INSTALL_RETURN_CONTEXT_MAX_LENGTH = 200;
