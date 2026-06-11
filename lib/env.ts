// Centralized environment access for the background-jobs runtime (Story 1.6).
//
// Why a dedicated module and not inline `process.env` reads: the Inngest env
// vars have non-obvious presence rules that are easy to get wrong if every
// call site re-derives them. Naming them here once, with the rule documented,
// keeps the client + serve route honest.
//
// PRESENCE RULES (PRODECT_FINDINGS #30):
//   - INNGEST_DEV: set to "1" in LOCAL dev only (the `dev:inngest` script does
//     this). Without it Inngest's serve route defaults to CLOUD mode and 500s
//     locally with "in cloud mode but no signing key found" (sharp edge #2).
//     Preview/prod leave it UNSET. The client passes this through as `isDev`.
//   - INNGEST_EVENT_KEY: authenticates `inngest.send()` against the cloud event
//     API. Required in PREVIEW + PROD; `undefined` is valid in dev (the local
//     dev server doesn't need it) and in the in-process test harness (which
//     never sends). The client reads it through `inngestEventKey()`.
//   - INNGEST_SIGNING_KEY: required in PREVIEW + PROD; read AUTOMATICALLY by the
//     SDK from the environment (it's a read-only getter on the client, not a
//     settable option), so there's no accessor here. In cloud mode a missing
//     key raises Inngest's OWN clear error at request time — that's the loud-
//     failure surface, NOT a Motir boot check (forcing a module-load throw
//     would break local dev / CI / concurrent sibling worktrees that have no
//     reason to set it — finding #30 sharp edge #6).
//
// Both keys are supplied in preview/prod via the official Inngest↔Vercel
// integration (human-gated carry-over, finding #30) — left blank locally.

/** Local-dev flag — true only when INNGEST_DEV=1 (never in preview/prod). */
export function isInngestDev(): boolean {
  return process.env['INNGEST_DEV'] === '1';
}

/** The Inngest event key, or undefined in dev / the test harness. */
export function inngestEventKey(): string | undefined {
  return process.env['INNGEST_EVENT_KEY'];
}
