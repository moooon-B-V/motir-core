import { OrchestratorNotConfiguredError } from '../../errors';

// The INDEX CONTAINER's image, as this deployment configures it (Story
// MOTIR-1981 · MOTIR-1989) — `docs/decisions/code-graph-index-fleet.md` §2.
//
// It lives beside `flyMachines.ts` rather than inside it for one reason and it is
// not tidiness: `flyFleetConfig()` is the CI RUNNER's configuration, and the
// index workload's image is a different image with a different release lane and a
// different registry story. Folding a second image into that accessor would make
// `isFlyFleetConfigured()` — which gates whether the CI fleet may boot at all —
// answer false because the INDEXER image is unset, taking CI down for an
// unrelated variable. They are separate questions and they get separate reads.
//
// ⚠️ THE DEPLOYABLE REFERENCE IS THE `registry.fly.io` DIGEST, NOT THE GHCR ONE.
// `docs/decisions/fleet-image-pull.md` §0 measured why: the Fly Machines API
// create payload has NO field for registry authentication — no `registry_auth`,
// no `docker_auth`, no `image_pull_secret` — so Fly cannot pull a private
// third-party image and rejects one at create time with
// `HTTP 400 · failed to get manifest …: unauthorized`. §1's rule (visibility
// follows the source's visibility) puts an image built from the CLOSED `motir-ai`
// source in the MIRROR column, so the release lane `skopeo copy`s it into
// `registry.fly.io`, which Fly authenticates itself. Pasting the GHCR digest here
// produces a reference no fleet machine can pull, and the failure surfaces at
// boot as an image-pull refusal rather than as a configuration error.
//
// Read at CALL time, never module load — the contract `appAuth.ts` and
// `flyMachines.ts` hold. A self-hosted `motir-core` never provisions a container
// and must not crash on boot for want of a variable it will never use; it must
// simply be unable to reach this path.

/** The env var holding the digest-pinned indexer image. */
const INDEXER_IMAGE_ENV = 'MOTIR_INDEXER_IMAGE';

/**
 * The configured indexer image reference, or `null` when unset.
 *
 * Returns null rather than throwing because its two callers ask different
 * questions: the predicate wants a boolean and must never throw (it is consulted
 * on paths that have to stay inert off-cloud), and the accessor wants to throw
 * with a message naming every missing variable at once — which it cannot do if
 * this throws on the first one.
 */
export function flyIndexerImage(): string | null {
  const image = process.env[INDEXER_IMAGE_ENV]?.trim();
  return image ? image : null;
}

/** Is the indexer image configured? Never throws. */
export function isFlyIndexerImageConfigured(): boolean {
  return flyIndexerImage() !== null;
}

/**
 * The indexer image, or the typed not-configured error naming the variable.
 *
 * ⚠️ IT THROWS, AND THAT IS THE POINT. An unconfigured index fleet must fail
 * LOUDLY: the alternative — returning a placeholder and letting the job carry on
 * — writes a `succeeded` `job_run` carrying an `output.repoRef` for a repo
 * nothing ever indexed, which tells `listSucceededCodeGraphIndexRepoRefs` and the
 * onboarding wizard's per-repo rows that the repo HAS a code graph. A silent
 * no-op here is indistinguishable from success everywhere downstream, forever.
 */
export function requireFlyIndexerImage(): string {
  const image = flyIndexerImage();
  if (!image) throw new OrchestratorNotConfiguredError(`set ${INDEXER_IMAGE_ENV}`);
  return image;
}

/** The variable's name, so a caller composing a missing-config message does not
 *  re-type it. Exported for the composition root and its test. */
export const INDEXER_IMAGE_ENV_VAR = INDEXER_IMAGE_ENV;
