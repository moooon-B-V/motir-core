// `context.routeOnboarding` — the flag that ASKS motir-ai for a routing verdict
// (Story MOTIR-4753 · MOTIR-4769, consumed by MOTIR-4767).
//
// ⚠️ THE VERDICT IS REQUESTED, NOT INFERRED, AND THE FLAG IS THE CONTRACT RATHER
// THAN A CONVENIENCE. A `plan` job dispatched from INSIDE onboarding — the
// migrate wizard's own generate step — is ALSO a first-plan run over an empty
// tree, so a verdict inferred from the tree would send a user who is already in
// onboarding back to the start of it. **Only the caller knows which of the two a
// run is**, so only the caller may say.
//
// ⚠️ IT IS NOT `context.onboarding` (MOTIR-4736 / MOTIR-4737), and the two are
// easy to confuse:
//
//   | field              | question                                        |
//   | ------------------ | ----------------------------------------------- |
//   | `onboarding`       | has this PROJECT ever had a plan approved?      |
//   | `routeOnboarding`  | does this RUN need its route decided?           |
//
// The first is a property of the project and is true for the wizard's own run
// too. The second is a property of the request, and exactly one dispatch sets
// it: the universal plan window opening on a project that has never been
// planned.
//
// ⚠️ AND IT IS DERIVED SERVER-SIDE, NEVER TAKEN FROM A CLIENT. The route knows
// the project; a caller that could ask for a routing verdict on somebody else's
// terms is a caller that could route a user into onboarding they do not need.

/** The context key, spelled once. There is no shared type across the boundary. */
export const ROUTE_ONBOARDING_CONTEXT_FIELD = 'routeOnboarding' as const;

/**
 * Should THIS dispatch ask for a routing verdict?
 *
 * ⚠️ ABSENT rather than `false` when it should not, deliberately, and this is
 * the opposite of `onboarding`'s rule. There, absence means *the producer
 * predates the field* and the consumer must not read it as `false`. Here the
 * consumer's default IS the safe one — no flag, no verdict, today's behaviour —
 * so sending `false` would add a key to every planning envelope in the product
 * to say the thing its absence already says.
 */
export function routeOnboardingContextFor(project: { onboardingRanAt: Date | string | null }): {
  readonly routeOnboarding?: true;
} {
  return project.onboardingRanAt ? {} : { [ROUTE_ONBOARDING_CONTEXT_FIELD]: true };
}
