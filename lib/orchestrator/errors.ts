import type { OrchestratorProvider } from './types';

// Typed failures the port raises. Every one carries the PROVIDER, because a
// fleet with two adapters produces two dialects of failure and "which one broke"
// is the first question an operator asks.
//
// None of them carries the provider's raw body — the same posture
// `repoProvisioning.ts` and `runnerGroups.ts` hold: a status and a short detail
// is what a log needs, and a raw body is how a token ends up in one.

/** Any provider refusal or transport failure while managing a container. */
export class OrchestratorApiError extends Error {
  readonly code = 'ORCHESTRATOR_API_FAILED' as const;
  constructor(
    readonly provider: OrchestratorProvider,
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `The ${provider} orchestrator could not be reached (${detail}).`
        : `The ${provider} orchestrator refused a call (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'OrchestratorApiError';
  }
}

/** The deployment has no orchestrator wired — a self-hosted build, or a cloud
 *  deployment whose fleet credentials are not set. Read at CALL time (never
 *  module load), so an instance that never provisions simply cannot reach the
 *  flow rather than crashing on boot — `appAuth.ts`'s contract. */
export class OrchestratorNotConfiguredError extends Error {
  readonly code = 'ORCHESTRATOR_NOT_CONFIGURED' as const;
  constructor(detail: string) {
    super(`The container orchestrator is not configured: ${detail}.`);
    this.name = 'OrchestratorNotConfiguredError';
  }
}
