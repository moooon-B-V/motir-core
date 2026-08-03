import { flyOrchestrator } from './adapters/fly';
import { flyFleetConfig, isFlyFleetConfigured } from './adapters/fly/flyMachines';
import {
  flyIndexerImage,
  isFlyIndexerImageConfigured,
  INDEXER_IMAGE_ENV_VAR,
} from './adapters/fly/indexImage';
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

// ── The INDEX workload's configuration (MOTIR-1981 · MOTIR-1989) ─────────────
//
// The index fleet needs everything the CI fleet needs (an orchestrator that can
// boot a machine) PLUS its own digest-pinned image, which is a different image
// with its own release lane. The two accessors below are the index workload's
// twin of `getOrchestrator()` / `isOrchestratorConfigured()`, and they live here
// — the composition root — for the reason that function does: this is the one
// file outside `adapters/fly/` permitted to name the adapter, so the CONFIG
// stays Fly-shaped in exactly one place and every consumer above sees a
// provider-neutral `{ image, region }`.

/** What an index container needs from this deployment's configuration. Neutral:
 *  no Fly type, no token, no app name — a second adapter fills the same shape. */
export interface IndexFleetConfig {
  /** The digest-pinned indexer image. On Fly, the `registry.fly.io` reference. */
  readonly image: string;
  readonly region: string;
}

/**
 * Is this deployment wired to run INDEX containers? Never throws.
 *
 * True on the `fake` adapter — which is what the test suites select — for the
 * same reason `isOrchestratorConfigured()` is: the fake boots no real machine, so
 * there is no image to pull and nothing to configure. Requiring a real image
 * there would put a production-only variable in front of every test that drives
 * the port, and the usual response to that is a placeholder in the test env,
 * which is the same placeholder that would then work in production.
 */
export function isIndexFleetConfigured(): boolean {
  if (selectedOrchestratorProvider() === 'fake') return true;
  return isFlyFleetConfigured() && isFlyIndexerImageConfigured();
}

/**
 * The index workload's configuration, or the typed not-configured error naming
 * EVERY missing variable at once.
 *
 * ⚠️ ALL OF THEM, NOT THE FIRST. A misconfigured deployment discovers its gaps
 * one boot at a time otherwise, and every one of those boots is a billed machine
 * and a dead-lettered run. `flyFleetConfig()` already collects its three; this
 * adds the image to the same message.
 *
 * ⚠️ AND IT THROWS RATHER THAN NO-OPPING. `docs/decisions/code-graph-index-fleet.md`
 * §5's hard constraint is the ledger: one `job_run` per repo, `succeeded`, with
 * one `output.repoRef`. A path that quietly returned "nothing to do" when
 * unconfigured would still let the job record that row — telling the enqueue gate
 * (`listSucceededCodeGraphIndexRepoRefs`) and the onboarding wizard's per-repo
 * rows that a repo is indexed when nothing ever ran. Unconfigured must be
 * LOUD; {@link isIndexFleetConfigured} is what keeps a self-hosted deploy out of
 * this path, and it is not a licence to be silent once inside it.
 *
 * ⚠️ IT ALSO REQUIRES `MOTIR_RUNNER_IMAGE`, WHICH INDEXING DOES NOT USE — stated
 * rather than hidden. The index workload shares the fleet's Fly ORG, APP and
 * TOKEN with CI (§3: one shared `motir-fleet` org), and those three arrive
 * through `flyFleetConfig()`, which also demands the CI runner's image. Reading
 * the app and token here instead would put a SECOND copy of two env-var names in
 * the codebase, which `lib/ciFleet/config.ts` records the cost of: "two literals
 * that agree today are not one constant." No deployment is affected — the cloud
 * sets both, and a self-hosted one sets neither — so the coupling is accepted and
 * named. Splitting the accessor belongs with the second adapter, alongside the
 * `defaultSpecDefaults()` the port boundary's own guard already anticipates.
 */
export function indexFleetConfig(): IndexFleetConfig {
  if (selectedOrchestratorProvider() === 'fake') {
    // The fake adapter boots nothing, so this reference is never pulled. It is
    // still a well-formed DIGEST rather than a tag, so a test asserting "the spec
    // is digest-pinned" exercises the real shape.
    return { image: 'motir/indexer@sha256:fake', region: 'iad' };
  }
  const missing: string[] = [];
  let region = 'iad';
  try {
    region = flyFleetConfig().region;
  } catch (err) {
    // Its message already reads `set A, B, C` — unwrap the verb so this one can
    // re-add it once, over the union of BOTH accessors' missing variables.
    const detail = err instanceof Error ? err.message.replace(/^set /, '') : '';
    missing.push(detail || 'the fleet configuration');
  }
  const image = flyIndexerImage();
  if (!image) missing.push(INDEXER_IMAGE_ENV_VAR);
  // `|| !image` is what narrows the type; `missing.length` alone cannot, and a
  // cast here would be a cast that outlives the reason for it.
  if (missing.length > 0 || !image) {
    throw new OrchestratorNotConfiguredError(`set ${missing.join(', ')}`);
  }
  return { image, region };
}

/**
 * What the boot preflight concluded about ONE of this deployment's pull paths.
 *
 * Four arms, and the split between the last two is the whole reason this is not
 * a boolean: `unpullable` is a DEFINITE registry refusal that no amount of
 * waiting fixes, while `indeterminate` means the probe could not reach the
 * registry at all. Only the first fails the health check loudly — see
 * `system.daily-health-check`.
 *
 * ⚠️ IT DESCRIBES ONE IMAGE, AND THAT IS DELIBERATE (MOTIR-2030). `reference` is
 * a single string, so the fleet's SECOND pull path gets its own verdict rather
 * than widening this one. See {@link verifyIndexFleetBootable} for why a
 * per-path verdict is the honest shape.
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

  return probeToVerdict(image);
}

/**
 * One pull path's probe, mapped onto the verdict's three non-trivial arms.
 *
 * Shared by both preflights (MOTIR-2030) so the two paths cannot drift in what
 * `unpullable` vs `indeterminate` MEANS — which is the one distinction the
 * health check branches on, and therefore the one a second copy would eventually
 * get subtly wrong. The `not_applicable` arm is NOT here: it is decided from
 * CONFIGURATION, before there is an image to probe, and each path decides it
 * differently.
 */
async function probeToVerdict(image: string): Promise<FleetBootableVerdict> {
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

/**
 * CAN THIS DEPLOYMENT BOOT AN INDEX CONTAINER? — the INDEXER image's own
 * preflight (MOTIR-2030), and the twin of {@link verifyFleetBootable}.
 *
 * ⚠️ A SECOND PULL PATH NEEDS A SECOND PREFLIGHT, AND THE ADR SAYS SO IN THOSE
 * WORDS. `docs/decisions/fleet-image-pull.md` §5 lists three constraints on the
 * indexer's mirror and the third is this one verbatim: *"It is a second pull
 * path. The fleet then has two, and each needs §6's preflight independently."*
 * Before MOTIR-1989 there was one image and `verifyFleetBootable()` covered the
 * fleet; after it there are two, with two registries, two release lanes and two
 * failure modes — and the indexer's was probed by nothing.
 *
 * ⚠️ AND IT IS THE PATH MORE LIKELY TO GO MISSING. §5's second constraint:
 * `registry.fly.io` garbage-collects UNREFERENCED images ("we clean old ones up
 * after a few days"), and the reading that a live Machine's image is immune is
 * precisely the wrong shape for a fleet whose machines are ephemeral by design —
 * between jobs, nothing references it. Fly publishes no retention SLA, so this
 * cannot be reasoned away; §6 names the preflight as "what turns a GC'd image
 * into a loud failure instead of an outage."
 *
 * ⚠️ WHY A SEPARATE FUNCTION RATHER THAN A WIDER VERDICT.
 * {@link FleetBootableVerdict} is single-image by construction, and the two paths
 * genuinely fail independently: the CI runner can be perfectly pullable on a
 * deployment whose indexer image was collected last night. One verdict covering
 * both would have to pick which reference to name, and the operator surface is a
 * MESSAGE — naming the wrong image is worse than naming none.
 *
 * NEVER THROWS, for the reason its twin does not: the caller is a health check.
 */
export async function verifyIndexFleetBootable(): Promise<FleetBootableVerdict> {
  if (selectedOrchestratorProvider() === 'fake') {
    return {
      verdict: 'not_applicable',
      detail: 'the fake orchestrator is selected; no image is pulled',
    };
  }
  let image: string;
  try {
    // ⚠️ THE ACCESSOR, NOT THE PREDICATE — the same choice, for the same reason,
    // its twin makes over `isFlyFleetConfigured()`: `indexFleetConfig()` is what
    // would actually be used to boot an index container, so consulting it here
    // leaves no way for the preflight and the boot to disagree about what
    // "configured" means. It also folds BOTH not-applicable shapes into one
    // branch — no fleet at all, and a fleet with no indexer image.
    image = indexFleetConfig().image;
  } catch {
    // ⚠️ `not_applicable`, NEVER `unpullable`. A deployment that runs CI but has
    // not wired `MOTIR_INDEXER_IMAGE` is a deployment that does not INDEX — not a
    // broken one — and reporting it as a registry refusal would fail a daily
    // health check over a feature nobody enabled. That is the false alarm that
    // teaches an operator to ignore the row, which is how the next MOTIR-1980
    // gets missed. `isIndexFleetConfigured()` is what keeps such a deployment out
    // of the index path; this is the preflight agreeing with it.
    return {
      verdict: 'not_applicable',
      detail: 'this deployment is not configured to run index containers',
    };
  }

  return probeToVerdict(image);
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
