import 'server-only';

// Is motir-core wired to a Motir AI deployment? A SERVER-ONLY config probe (the
// `server-only` import keeps it out of any client bundle) — it reads the same
// two env vars the `server-only` motirAiClient validates at call time
// (lib/ai/motirAiClient.ts `config()`), so "configured" here matches "won't
// throw MotirAiConfigError" there.
//
// The "Draft with AI" cloud-gate (8.8.12) needs this BEFORE a job is submitted:
// a self-hosted workspace with no connection shows the disabled button +
// "Connect Motir AI" notice (design/work-items/draft-with-ai 3A) rather than
// letting the user click and hit a 502. Resolved in the Server Component layer
// (the authed layout for the create modal, the edit page for the edit form) and
// threaded to the client surface as a boolean prop.
export function isMotirAiConfigured(): boolean {
  return Boolean(process.env['MOTIR_AI_URL'] && process.env['MOTIR_AI_SERVICE_TOKEN']);
}
