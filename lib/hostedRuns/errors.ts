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

// --- The hosted-run key wiring (MOTIR-689) ---

/** Why a per-run key could not be minted. Every reason means the same thing to
 *  the start path: fail the run BEFORE the container boots. */
export type HostedRunKeyNotMintedReason =
  /** This deployment lacks `MOTIR_GATEWAY_URL` or `MOTIR_RUN_KEY_MINT_SECRET`. */
  | 'not_configured'
  /** The gateway answered and refused (a 4xx, or its own `run_keys_not_configured`). */
  | 'refused'
  /** The gateway could not be reached, timed out, or failed. */
  | 'unavailable'
  /** The run is past its timeout, or the model is empty — nothing was asked. */
  | 'invalid_request';

/**
 * A per-run key was NOT minted. The start path (MOTIR-690) receives it BEFORE
 * booting anything: no container, no spend (`docs/decisions/hosted-agent-run.md`,
 * and MOTIR-689's approach).
 */
export class HostedRunKeyNotMintedError extends Error {
  constructor(
    readonly reason: HostedRunKeyNotMintedReason,
    message: string,
    /** The gateway's own refusal code, when it answered one. */
    readonly gatewayCode: string | null = null,
  ) {
    super(message);
    this.name = 'HostedRunKeyNotMintedError';
  }
}

// --- The run's git credentials (MOTIR-6449) ---
//
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §5 and §8: a hosted run
// writes as Motir's GitHub App, and a run that cannot write is refused before
// anything boots, naming EVERY repository that cannot be written.

/** What one repository needs before a hosted run can write it — the one fix the
 *  person (or the owner of the GitHub account) has to make. */
export type RunGitWriteFix = 'reconnect' | 'accept_permissions';

/** One repository of the run that its App cannot write, with the decision's
 *  reason verbatim and, for `accept_permissions`, where the owner accepts. */
export interface RunGitWriteRefusal {
  /** `owner/name`. */
  repository: string;
  reason: string;
  fix: RunGitWriteFix;
  /** The installation's settings page on GitHub, when it is known. */
  fixUrl: string | null;
}

/**
 * A run covers at least one repository its App cannot write (§8). Carries every
 * refused repository, not the first: a person fixing them one run at a time
 * would be told the next only after the last fix.
 */
export class HostedRunRepositoryNotWritableError extends Error {
  readonly code = 'hosted_repository_not_writable' as const;
  constructor(readonly refusals: readonly RunGitWriteRefusal[]) {
    super(refusals.map((r) => r.reason).join('; '));
    this.name = 'HostedRunRepositoryNotWritableError';
  }
}

/** Why a git credential could not be produced for reasons that are NOT one of
 *  the two refusals a person can act on. */
export type RunGitCredentialUnavailableReason =
  /** The App the repository needs is not configured on this deployment. */
  | 'not_configured'
  /** GitHub could not be reached, or answered something unexpected. */
  | 'github_unavailable'
  /** A repository of the run has nothing on GitHub yet (its row is not realized). */
  | 'repository_unrealized'
  /** The run covers no repository at all. */
  | 'no_repository';

/** The run's git credential could not be minted, for an operational reason. The
 *  start path fails the run; the refresh route answers it as a server fault. */
export class RunGitCredentialUnavailableError extends Error {
  readonly code = 'run_git_credential_unavailable' as const;
  constructor(
    readonly reason: RunGitCredentialUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'RunGitCredentialUnavailableError';
  }
}
