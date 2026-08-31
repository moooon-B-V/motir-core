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

/**
 * True only on a Motir CLOUD build (`MOTIR_CLOUD=true`); false self-hosted.
 *
 * ⚠️ NOT a synonym for `isCloudBilling()` (MOTIR-4033). The two read the same
 * variable and answer DIFFERENT questions, which ADR §6 already rules on: two
 * questions get two functions even when they read one variable.
 *
 *   `isCloudBilling()` — "is this a BILLING build?"  → checkout, paywalls, the
 *                        §4 entitlement caps, seat sync, the CI cost meters.
 *   `isCloud()`        — "is this a CLOUD build?"    → every other capability
 *                        that exists only on the hosted service.
 *
 * The first consumer is the PUBLIC-PROJECTS gate (Story MOTIR-3908): with
 * `MOTIR_CLOUD` unset there is no public-projects feature at all — not a hidden
 * page, an ABSENT capability. A self-hosted Motir is a team doing project
 * management for itself.
 *
 * A non-billing surface calling `isCloudBilling()` would couple two unrelated
 * capabilities through one name, so that the day billing stops being
 * cloud-only — or starts being sold self-hosted — the public surface silently
 * changes with it. `tests/hosting/cloudBuildFlag.test.ts` asserts the split in
 * BOTH directions and is the reason it cannot re-conflate by accident.
 *
 * Same explicit-flag discipline as `isCloudBilling()`: `MOTIR_CLOUD` is never
 * INFERRED from the presence of other config, and this module is the only
 * reader of it in the tree.
 */
export function isCloud(): boolean {
  return process.env['MOTIR_CLOUD'] === 'true';
}
