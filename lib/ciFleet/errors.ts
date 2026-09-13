import type { ContainerSize, OrchestratorProvider } from '@motir/orchestrator';

// Typed refusals from the HOSTED-AGENT metering seam (Story MOTIR-4336 ·
// MOTIR-4713). Both fire BEFORE anything is reserved or provisioned, so a throw
// leaks neither a fleet slot nor a container.

/**
 * A hosted-agent container was asked for on a machine class the rate table does
 * not price.
 *
 * ⚠️ THE METER WOULD NOT HAVE THROWN, AND THAT IS WHY THIS DOES. `buildContainerUsage`
 * records an unpriced triple at `usdPerSecond = 0` with a null
 * `rateEffectiveFrom` and a log line — the right posture for a container that
 * already ran, and the wrong one for the single workload whose price the agent
 * lane's multiplier is calibrated against: its hosting share would read as zero.
 * The remedy is a new row in `packages/orchestrator/src/rates.ts`, which is the
 * deliverable of whichever decision picked the machine class.
 */
export class HostedAgentContainerUnpricedError extends Error {
  readonly code = 'HOSTED_AGENT_CONTAINER_UNPRICED' as const;
  constructor(
    readonly provider: OrchestratorProvider,
    readonly size: ContainerSize,
    readonly region: string,
  ) {
    super(
      `no container rate prices ${provider} ${size.cpuKind}-${size.cpus}x/${size.memoryMb}MB in ` +
        `${region}; a hosted-agent container is not booted unpriced — add the rate row first`,
    );
    this.name = 'HostedAgentContainerUnpricedError';
  }
}

/** A hosted-agent container request that cannot be supervised as asked — a
 *  timeout outside the seam's bounds. A dispatcher bug, never a transient. */
export class HostedAgentContainerRequestInvalidError extends Error {
  readonly code = 'HOSTED_AGENT_CONTAINER_REQUEST_INVALID' as const;
  constructor(readonly detail: string) {
    super(`invalid hosted-agent container request: ${detail}`);
    this.name = 'HostedAgentContainerRequestInvalidError';
  }
}
