import { flyOrchestrator } from './adapters/fly';
import { flyFleetConfig, isFlyFleetConfigured } from './adapters/fly/flyMachines';
import { fakeOrchestrator } from './adapters/fake';
import { OrchestratorNotConfiguredError } from './errors';
import { probeImagePull } from './imagePull';
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

/**
 * What the boot preflight concluded about this deployment's runner image.
 *
 * Four arms, and the split between the last two is the whole reason this is not
 * a boolean: `unpullable` is a DEFINITE registry refusal that no amount of
 * waiting fixes, while `indeterminate` means the probe could not reach the
 * registry at all. Only the first fails the health check loudly — see
 * `system.daily-health-check`.
 */
export type FleetBootableVerdict =
  /** The registry served the manifest anonymously. A Fly Machine can boot it. */
  | { verdict: 'bootable'; reference: string; digest: string | null }
  /** DEFINITE: the registry will not serve this image. The loud one. */
  | { verdict: 'unpullable'; reference: string; detail: string }
  /** Nothing to check — this deployment provisions no real containers. */
  | { verdict: 'not_applicable'; detail: string }
  /** Could not tell. A transport failure, never a claim about the image. */
  | { verdict: 'indeterminate'; reference: string; detail: string };

/**
 * CAN THIS DEPLOYMENT'S FLEET ACTUALLY BOOT? — §6.1 + §7 of
 * `docs/decisions/fleet-image-pull.md`, and the sibling `isFlyFleetConfigured()`
 * deliberately is not.
 *
 * The assertion MOTIR-1980 needed and did not have. The fleet shipped
 * code-complete and unbootable while every predicate in the codebase answered
 * "configured", because none of them asked the only question that matters: does
 * the registry serve the image the deployment is pinned to? This asks it, once,
 * out of band.
 *
 * ⚠️ CONSUMED BY THE HEALTH / PREFLIGHT SURFACE, NEVER BY THE PER-JOB PATH — §7
 * fixes this and it is not a stylistic preference. Per-job it would be a
 * registry round-trip inside `ci-runner-fleet.md` §6's ≤30s p50 boot budget,
 * taken once per queued job, to re-answer a deployment-wide question whose
 * answer changes about as often as an env var. The per-job backstop is
 * `OrchestratorImageUnpullableError` (§6.2) — a different mechanism for a
 * different case: an image that WAS pullable at preflight and is not now.
 *
 * ⚠️ IT NAMES FLY, AND THAT IS WHY IT LIVES HERE. This module is the
 * COMPOSITION ROOT — the one file outside `adapters/fly/` that
 * `tests/ciFleet/orchestratorPortBoundary.test.ts` permits to name the adapter.
 * The probe itself (`./imagePull`) knows nothing about Fly; marrying it to the
 * configured image is exactly the composition this file exists for, and a second
 * adapter would add one branch here rather than a new leak somewhere else.
 *
 * NEVER THROWS: the caller is a health check, and every "no" is more useful as a
 * sentence than as a stack trace.
 */
export async function verifyFleetBootable(): Promise<FleetBootableVerdict> {
  if (selectedOrchestratorProvider() === 'fake') {
    return {
      verdict: 'not_applicable',
      detail: 'the fake orchestrator is selected; no image is pulled',
    };
  }
  let image: string;
  try {
    image = flyFleetConfig().image;
  } catch {
    // A self-hosted build, or a cloud deploy not yet wired. NOT a failure —
    // `isOrchestratorConfigured()` already keeps this deployment out of the
    // provisioning path, so there is nothing here to be loud about. The CONFIG
    // ACCESSOR is asked rather than `isFlyFleetConfigured()`, even though the two
    // check the same three variables: the accessor is the thing that would
    // actually be used to boot, so consulting it here leaves no way for the
    // preflight and the boot to disagree about what "configured" means.
    return {
      verdict: 'not_applicable',
      detail: 'this deployment has no container fleet configured',
    };
  }

  const probe = await probeImagePull(image);
  if (probe.pullable === true) {
    return { verdict: 'bootable', reference: probe.reference, digest: probe.digest };
  }
  if (probe.pullable === false) {
    return {
      verdict: 'unpullable',
      reference: probe.reference,
      detail: `${probe.registry}: ${probe.detail} (${probe.reason})`,
    };
  }
  return { verdict: 'indeterminate', reference: probe.reference, detail: probe.detail };
}

export * from './types';
export {
  OrchestratorApiError,
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
  OrchestratorTimeoutError,
  ORCHESTRATOR_REQUEST_TIMEOUT_MS,
} from './errors';
export { resolveContainerRate, FLEET_CONTAINER_SIZE } from './rates';
export { buildContainerUsage, billableSecondsFor, isUnpriced } from './usage';
export { recordContainerUsage } from './usageSink';
