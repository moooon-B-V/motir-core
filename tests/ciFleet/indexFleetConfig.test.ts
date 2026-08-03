import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  indexFleetConfig,
  isIndexFleetConfigured,
  isOrchestratorConfigured,
  OrchestratorNotConfiguredError,
} from '@/lib/orchestrator';
import {
  flyIndexerImage,
  isFlyIndexerImageConfigured,
  requireFlyIndexerImage,
  INDEXER_IMAGE_ENV_VAR,
} from '@/lib/orchestrator/adapters/fly/indexImage';

// The INDEX FLEET's config gate (Story MOTIR-1981 · MOTIR-1989).
//
// The property under test is that UNCONFIGURED IS LOUD. §5 of
// `docs/decisions/code-graph-index-fleet.md` makes the ledger the hard
// constraint — one `job_run` per repo, `succeeded`, with one `output.repoRef` —
// and `listSucceededCodeGraphIndexRepoRefs` plus the onboarding wizard's
// per-repo rows both read exactly that. So a config gate that quietly answered
// "nothing to do" would let a repo read as INDEXED forever while nothing ever
// ran. Silence here is indistinguishable from success everywhere downstream.

const FLEET_VARS = [
  'MOTIR_FLEET_ORCHESTRATOR',
  'FLY_FLEET_API_TOKEN',
  'FLY_FLEET_APP',
  'FLY_FLEET_REGION',
  'MOTIR_RUNNER_IMAGE',
  INDEXER_IMAGE_ENV_VAR,
];

/** Start from a deployment that has NOTHING configured — the self-hosted shape. */
function clearFleetEnv(): void {
  for (const key of FLEET_VARS) vi.stubEnv(key, '');
}

/** Everything a real (non-fake) cloud deployment sets. */
function configureCloudFleet(): void {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly-token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-fleet-app');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', 'ghcr.io/moooon-b-v/motir-ci-runner@sha256:' + 'a'.repeat(64));
  vi.stubEnv(INDEXER_IMAGE_ENV_VAR, 'registry.fly.io/motir-fleet-app@sha256:' + 'b'.repeat(64));
}

beforeEach(() => {
  clearFleetEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the indexer image accessor (the Fly-side read)', () => {
  it('reads MOTIR_INDEXER_IMAGE at CALL time, not module load', () => {
    expect(flyIndexerImage()).toBeNull();
    vi.stubEnv(INDEXER_IMAGE_ENV_VAR, 'registry.fly.io/app@sha256:' + 'c'.repeat(64));
    // Same module instance, different answer — which is what lets a self-hosted
    // build import this without crashing on boot.
    expect(flyIndexerImage()).toBe('registry.fly.io/app@sha256:' + 'c'.repeat(64));
  });

  it('treats a blank / whitespace value as UNSET', () => {
    vi.stubEnv(INDEXER_IMAGE_ENV_VAR, '   ');
    expect(flyIndexerImage()).toBeNull();
    expect(isFlyIndexerImageConfigured()).toBe(false);
    // An empty string in a deployment's env is the commonest way a variable is
    // "set" but useless; it must not produce an image reference of `''`.
    expect(() => requireFlyIndexerImage()).toThrow(OrchestratorNotConfiguredError);
  });

  it('requireFlyIndexerImage names the variable in its message', () => {
    expect(() => requireFlyIndexerImage()).toThrow(new RegExp(INDEXER_IMAGE_ENV_VAR));
  });

  it('requireFlyIndexerImage RETURNS the configured reference on a wired deployment', () => {
    // The accessor's success path — the half that actually boots a container.
    // Asserting only the throw leaves the branch that produces the image
    // reference unexecuted, so a regression returning the variable's NAME, a
    // trimmed-to-empty value, or the CI runner's image would go unnoticed here
    // and surface as an image-pull refusal at boot.
    const reference = 'registry.fly.io/motir-fleet@sha256:' + 'd'.repeat(64);
    vi.stubEnv(INDEXER_IMAGE_ENV_VAR, `  ${reference}  `);
    // Trimmed, and it is the DIGEST-pinned mirror reference — never the GHCR one
    // (`docs/decisions/fleet-image-pull.md` §0: Fly's create payload has no field
    // for registry auth, so a private third-party image cannot be pulled at all).
    expect(requireFlyIndexerImage()).toBe(reference);
    expect(isFlyIndexerImageConfigured()).toBe(true);
  });

  it('the predicate never throws, whatever the environment', () => {
    expect(() => isFlyIndexerImageConfigured()).not.toThrow();
    vi.stubEnv(INDEXER_IMAGE_ENV_VAR, 'x');
    expect(() => isFlyIndexerImageConfigured()).not.toThrow();
  });
});

describe('isIndexFleetConfigured', () => {
  it('is FALSE on an unconfigured (self-hosted) deployment', () => {
    expect(isIndexFleetConfigured()).toBe(false);
  });

  it('is TRUE for the fake adapter — the test suites boot no real machine', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    expect(isIndexFleetConfigured()).toBe(true);
    // It agrees with the CI fleet's own predicate on the same deployment, so the
    // two workloads cannot disagree about whether the fake is usable.
    expect(isOrchestratorConfigured()).toBe(true);
  });

  it('is FALSE when the FLEET is wired but the INDEXER IMAGE is not', () => {
    // The case this predicate exists for: a deployment that runs CI runners
    // today and has not yet pasted the indexer digest. CI keeps working; the
    // index workload correctly reports itself unavailable.
    configureCloudFleet();
    vi.stubEnv(INDEXER_IMAGE_ENV_VAR, '');
    expect(isIndexFleetConfigured()).toBe(false);
    expect(isOrchestratorConfigured()).toBe(true);
  });

  it('is FALSE when the IMAGE is wired but the fleet is not', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv(INDEXER_IMAGE_ENV_VAR, 'registry.fly.io/app@sha256:' + 'd'.repeat(64));
    expect(isIndexFleetConfigured()).toBe(false);
  });

  it('is TRUE on a fully-wired cloud deployment', () => {
    configureCloudFleet();
    expect(isIndexFleetConfigured()).toBe(true);
  });

  it('never throws, on any of those', () => {
    expect(() => isIndexFleetConfigured()).not.toThrow();
    configureCloudFleet();
    expect(() => isIndexFleetConfigured()).not.toThrow();
  });
});

describe('indexFleetConfig — unconfigured must be LOUD', () => {
  it('THROWS the typed error when nothing is configured', () => {
    // Not a null, not a placeholder, not a no-op verdict. A silent answer here
    // is what would let a `succeeded` job_run carry an output.repoRef for a repo
    // nothing indexed.
    expect(() => indexFleetConfig()).toThrow(OrchestratorNotConfiguredError);
  });

  it('names EVERY missing variable at once, not just the first', () => {
    // A misconfigured deployment otherwise discovers its gaps one boot at a
    // time, and each of those boots is a billed machine and a dead-lettered run.
    const err = (() => {
      try {
        indexFleetConfig();
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(err!.message).toContain('FLY_FLEET_API_TOKEN');
    expect(err!.message).toContain('FLY_FLEET_APP');
    expect(err!.message).toContain(INDEXER_IMAGE_ENV_VAR);
  });

  it('names ONLY the indexer image when the rest of the fleet is wired', () => {
    configureCloudFleet();
    vi.stubEnv(INDEXER_IMAGE_ENV_VAR, '');
    const err = (() => {
      try {
        indexFleetConfig();
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(err!.message).toContain(INDEXER_IMAGE_ENV_VAR);
    expect(err!.message).not.toContain('FLY_FLEET_API_TOKEN');
  });

  it('returns the image + region on a wired deployment', () => {
    configureCloudFleet();
    vi.stubEnv('FLY_FLEET_REGION', 'ams');
    expect(indexFleetConfig()).toEqual({
      image: 'registry.fly.io/motir-fleet-app@sha256:' + 'b'.repeat(64),
      region: 'ams',
    });
  });

  it('defaults the region to iad (§11 fixes the fleet there)', () => {
    configureCloudFleet();
    expect(indexFleetConfig().region).toBe('iad');
  });

  it('returns a DIGEST-pinned placeholder for the fake adapter', () => {
    // The fake boots nothing, so the reference is never pulled — but it is still
    // a digest and not a tag, so a downstream test asserting "the spec is
    // digest-pinned" exercises the real shape rather than a special case.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const config = indexFleetConfig();
    expect(config.image).toContain('@sha256:');
    expect(config.image).not.toMatch(/:latest$/);
    expect(() => indexFleetConfig()).not.toThrow();
  });

  it('is read at CALL time — configuring the deployment flips it without a reimport', () => {
    expect(() => indexFleetConfig()).toThrow();
    configureCloudFleet();
    expect(() => indexFleetConfig()).not.toThrow();
  });
});
