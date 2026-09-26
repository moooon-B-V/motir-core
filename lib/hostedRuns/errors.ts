// Typed errors for the HOSTED RUN domain (Story MOTIR-683).
//
// Kept in their own file, like every other domain's, so a route handler can map
// them without importing the service. Each carries a stable string `code`.
//
// ⚠️ THE TWO MODEL ERRORS ARE DISTINCT ON PURPOSE (MOTIR-6483). They need
// different copy — "choose again" against "try later" — and collapsing them would
// let "motir-ai is down" read as "that model is not allowed", or the reverse.
// The codes are the literals `docs/decisions/hosted-agent-run.md` §7 names, so
// the start path, the route and the design all speak one spelling.

/**
 * The chosen model is not on motir-ai's offered list — it was never offered,
 * or it has left the list since the page loaded. The person chooses again.
 */
export class HostedModelNotOfferedError extends Error {
  readonly code = 'hosted_model_not_offered' as const;
  constructor(readonly model: string) {
    super(`The model ${model} is not offered for hosted runs.`);
    this.name = 'HostedModelNotOfferedError';
  }
}

/**
 * motir-ai could not answer which models are offered — unreachable, timed out,
 * a 5xx, an unconfigured client, or an answer that is not a model list. Nothing
 * is started; the person tries again later.
 */
export class HostedModelsUnavailableError extends Error {
  readonly code = 'hosted_models_unavailable' as const;
  constructor(detail: string) {
    super(`The models a hosted run may use could not be read: ${detail}`);
    this.name = 'HostedModelsUnavailableError';
  }
}
