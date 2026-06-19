import 'server-only';

// Is the AI planning layer reachable from this deployment?
//
// Planning runs on Motir Cloud (the closed `motir-ai` backend); `motir-core`
// reaches it server-to-server through the `MOTIR_AI_URL` + `MOTIR_AI_SERVICE_TOKEN`
// env pair (see `lib/ai/motirAiClient.ts`, which throws `MotirAiConfigError` when
// either is missing). So "is planning configured?" is exactly "is that pair set?":
//
//   - **Motir Cloud** sets both → planning is connected → the public front door
//     shows the marketing landing + hero prompt.
//   - **A self-hosted deployment** that has not connected a Motir Cloud token
//     leaves them unset → the front door shows the "Connect Motir AI" gate instead
//     of the hero (the cloud-gated-AI decision; Story 7.3 / the 7.1 boundary).
//
// This is the open-core boundary read as a boolean — it does NOT import `motir-ai`
// or touch any AI table; it only inspects whether the connection is configured.
export function isAiPlanningConfigured(): boolean {
  return Boolean(process.env['MOTIR_AI_URL'] && process.env['MOTIR_AI_SERVICE_TOKEN']);
}
