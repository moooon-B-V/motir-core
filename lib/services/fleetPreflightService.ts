import { verifyFleetBootable, type FleetBootableVerdict } from '@/lib/orchestrator';

// THE FLEET BOOT PREFLIGHT (Story MOTIR-1916 · MOTIR-2006) — §6.1 of
// `docs/decisions/fleet-image-pull.md`, given a service seam so a background job
// can consume it.
//
// Thin by design: the whole decision lives in `verifyFleetBootable()`, at the
// orchestrator's composition root, because that is the only place permitted to
// marry the Fly-configured image to a provider-neutral registry probe
// (`tests/ciFleet/orchestratorPortBoundary.test.ts` enforces exactly that). What
// is added HERE is the 4-layer seam every job handler consumes its domain
// through — `jobServices` hands it to `system.daily-health-check`, and the
// handler's test stubs this rather than the network.
//
// ⚠️ WHY A DEPLOYMENT-WIDE PROBE IS A HEALTH CHECK AND NOT A GATE. The fault it
// catches — the fleet is wired, reports "configured", and cannot pull a single
// container image (MOTIR-1980) — is invisible per job: every queued job fails
// identically, minting and de-registering a GitHub runner each time, and the
// operator sees a stream of provider errors with no statement of the cause.
// Asserting it ONCE, on a schedule, is what turns that stream into one sentence
// in the one place a human already looks.

export const fleetPreflightService = {
  /**
   * Can this deployment's fleet pull its configured runner image?
   *
   * Never throws — every arm of {@link FleetBootableVerdict} is an answer,
   * including "could not tell". The CALLER decides which arms are loud; this
   * only establishes which one is true.
   */
  async check(): Promise<FleetBootableVerdict> {
    return verifyFleetBootable();
  },
};
