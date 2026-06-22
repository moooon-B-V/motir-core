// The cloud-vs-self-host build gate for the commercial layer (Story 8.1, ADR
// `docs/decisions/billing-tiering.md` §6). Billing AND the §4 entitlement caps
// exist ONLY on Motir cloud; a self-hosted (GPL-3.0) build is uncapped and shows
// no checkout, no paywall, no caps.
//
// `MOTIR_CLOUD` is an EXPLICIT flag (default `false`), deliberately NOT inferred
// from the presence of `motir-ai` / Stripe config — so a self-hoster who connects
// their OWN motir-ai is never force-billed. This is DISTINCT from
// `isAiPlanningConfigured` (which answers "is AI reachable?", lib/ai/planningConfig):
// both are false on a bare self-host, but they answer different questions and
// must stay separate flags (ADR §6).

/** True only on a Motir cloud build (MOTIR_CLOUD=true); false self-hosted. */
export function isCloudBilling(): boolean {
  return process.env['MOTIR_CLOUD'] === 'true';
}
