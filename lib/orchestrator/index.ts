import { flyOrchestrator } from './adapters/fly';
import { isFlyFleetConfigured } from './adapters/fly/flyMachines';
import { fakeOrchestrator } from './adapters/fake';
import { OrchestratorNotConfiguredError } from './errors';
import type { ContainerOrchestrator, OrchestratorProvider } from './types';

// WHICH adapter is behind the port on this deployment (Story MOTIR-1916 ·
// MOTIR-1921).
//
// This module is the ONLY place that names both adapters, and it is the reason
// no caller has to. `ciRunnerBootService` asks for "the orchestrator" and gets
// one; swapping Fly for §3's documented migration target (B1 · RunsOn) is a new
// file under `adapters/` plus one branch here.
//
// ⚠️ READ AT CALL TIME, never module load. A self-hosted `motir-core` never
// provisions a container (§8.5's posture, one domain over: off-cloud there is no
// meter, no pool and no fleet), and it must not crash on boot for want of a Fly
// token — it must simply be unable to reach this path. Same contract
// `appAuth.ts` and `ciMetering/config.ts` hold.

/** The selector's env var. Unset means `fly`, which is §1's decision; `fake` is
 *  what the test suites and MOTIR-1927's gate select. */
const SELECTOR_ENV = 'MOTIR_FLEET_ORCHESTRATOR';

/** Which adapter this deployment has selected, whether or not it is configured. */
export function selectedOrchestratorProvider(): OrchestratorProvider {
  const raw = process.env[SELECTOR_ENV]?.trim().toLowerCase();
  return raw === 'fake' ? 'fake' : 'fly';
}

/**
 * The orchestrator, or the typed not-configured error.
 *
 * It THROWS rather than returning null for the reason
 * `projectRunnerGroupService.requireRunnerGroupId` does: a nullable return
 * invites a lenient fallback at the call site, and the lenient fallback for "no
 * orchestrator" is silently not booting a runner while reporting success — a job
 * that then queues at GitHub for 24 hours and is cancelled, which reads as an
 * outage rather than a misconfiguration.
 */
export function getOrchestrator(): ContainerOrchestrator {
  const provider = selectedOrchestratorProvider();
  if (provider === 'fake') return fakeOrchestrator;
  if (!isFlyFleetConfigured()) {
    throw new OrchestratorNotConfiguredError(
      'set FLY_FLEET_API_TOKEN, FLY_FLEET_APP and MOTIR_RUNNER_IMAGE, or select the fake adapter',
    );
  }
  return flyOrchestrator;
}

/** Can this deployment provision containers at all? Never throws — the sweep
 *  uses it to stay inert on a self-hosted build rather than logging an error
 *  every minute. */
export function isOrchestratorConfigured(): boolean {
  return selectedOrchestratorProvider() === 'fake' || isFlyFleetConfigured();
}

export * from './types';
export { OrchestratorApiError, OrchestratorNotConfiguredError } from './errors';
export { resolveContainerRate, FLEET_CONTAINER_SIZE } from './rates';
export { buildContainerUsage, billableSecondsFor, isUnpriced } from './usage';
export { recordContainerUsage } from './usageSink';
