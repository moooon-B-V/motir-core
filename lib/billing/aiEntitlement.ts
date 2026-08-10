import type { AiAccessDTO } from '@/lib/dto/aiAccess';

// The two questions a surface asks of an `AiAccessDTO` (Story MOTIR-2542 ·
// Subtask MOTIR-2545). They live here, named, because the DTO's own contract has
// a subtlety that every consumer has to get right and one already got wrong:
//
//   > `applicable` — "Whether the paywall applies AT ALL. … When false the
//   > paywall never renders, WHATEVER ELSE THIS CARRIES."
//
// `notApplicableAiAccess()` is a SENTINEL: it is returned for a self-hosted
// build AND for a `meta` organization (the moooon B.V. dogfood org, exempt from
// the paywall by `Organization.isMeta`), and every one of its fields is inert —
// `hasPaidAiPlan: false` included. So reading `hasPaidAiPlan` off it answers a
// question that was never asked, and answers it "no": the org-settings page did
// exactly that and told the meta organization it needed to buy a plan it is
// explicitly exempt from, with the toggle disabled to match.
//
// Two functions rather than one because the two consumers genuinely ask
// different things — "should I render the upsell?" and "may this org use the
// feature?" — and collapsing them into a single boolean is what invites the next
// caller to reach past it to a raw field again.

/**
 * Does the AI paywall apply to this context at all? False on a self-hosted build
 * (no `MOTIR_CLOUD`, so AI is reached through the self-hoster's own connection
 * and never metered), false for a `meta` organization, and false when there is
 * no resolvable org context. When it is false, NOTHING else on the DTO is a
 * meaningful answer.
 */
export function isAiPaywallApplicable(access: AiAccessDTO | null | undefined): boolean {
  return access?.applicable === true;
}

/**
 * May this organization use a paid-AI feature? True when the paywall does not
 * apply (self-host, meta, no org context) OR the org holds a paid Motir AI plan.
 * False ONLY for a cloud organization on no paid plan — which is exactly the
 * case that should see the upsell.
 *
 * This is the question a FEATURE surface asks — "do I gate this control?" — as
 * opposed to {@link isAiPaywallApplicable}, which the paywall component asks
 * before deciding whether to render itself at all.
 */
export function hasAiEntitlement(access: AiAccessDTO | null | undefined): boolean {
  return !isAiPaywallApplicable(access) || access!.hasPaidAiPlan;
}
