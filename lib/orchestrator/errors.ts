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

/**
 * THE IMAGE COULD NOT BE PULLED — §6.2 of `docs/decisions/fleet-image-pull.md`.
 *
 * A subclass rather than a flag, so every existing `catch (OrchestratorApiError)`
 * keeps working while the ONE caller that cares can tell this apart. And it has
 * to be tellable apart: an unpullable image and an unreachable provider produce
 * the same generic "the orchestrator refused a call (HTTP 400)" today, and they
 * are opposite problems — one is a registry/visibility misconfiguration that no
 * amount of waiting fixes, the other is an outage that resolves itself.
 *
 * ⚠️ WHY IT IS THE BACKSTOP AND NOT THE DETECTION. §6.1 puts the real assertion
 * in the BOOT PREFLIGHT (`verifyFleetBootable()`), which fails once, loudly, for
 * the whole deployment. By the time this error is raised a JIT config has
 * already been minted for a machine that will never exist — which is precisely
 * the per-job cost §6 exists to stop paying. It survives anyway, because the
 * case it catches is real: an image that WAS pullable at preflight and is not
 * now (a garbage-collected mirror, §5.2; a revoked visibility).
 */
export class OrchestratorImageUnpullableError extends OrchestratorApiError {
  constructor(
    provider: OrchestratorProvider,
    status: number | null,
    readonly imageReference: string,
    detail: string,
  ) {
    super(provider, status, detail);
    this.name = 'OrchestratorImageUnpullableError';
    // The message is REPLACED rather than wrapped: this is the sentence that
    // lands in `ci_runner_provisioning_intent.failure_detail` and in the
    // operator dashboard's failure column, and "refused a call" is not a
    // diagnosis. Naming the reference is what makes it one.
    this.message =
      `The ${provider} orchestrator could not PULL the runner image ${imageReference} ` +
      `(${status === null ? 'no response' : `HTTP ${status}`}${detail ? `: ${detail}` : ''}). ` +
      `The registry served no manifest — the image is private, absent, or the pinned digest is gone.`;
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
