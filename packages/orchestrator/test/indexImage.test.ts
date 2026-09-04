import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flyIndexerImage,
  isFlyIndexerImageConfigured,
  OrchestratorNotConfiguredError,
  requireFlyIndexerImage,
  INDEXER_IMAGE_ENV_VAR,
} from '../src/index';

// The INDEXER IMAGE accessor — the package's half of the index fleet's config
// gate (Story MOTIR-1981 · MOTIR-1989).
//
// ⚠️ SPLIT OUT OF `tests/ciFleet/indexFleetConfig.test.ts` (MOTIR-4300), the same
// cut as the image-pull suite one file over and for the same reason: that file
// covers `isIndexFleetConfigured` / `indexFleetConfig`, which read THIS
// DEPLOYMENT through the app's composition root, and this accessor, which is
// three env reads inside `@motir/orchestrator`. The app half cannot be tested
// from here and this half was invisible to the package's own coverage gate, so
// the file was CUT rather than copied. Not one assertion moved or changed.
//
// The property under test is that UNCONFIGURED IS LOUD: the predicate never
// throws (it is consulted on paths that must stay inert off-cloud) and the
// accessor throws NAMING the variable, because a placeholder here writes a
// `succeeded` job_run for a repo nothing ever indexed.

beforeEach(() => {
  vi.stubEnv(INDEXER_IMAGE_ENV_VAR, '');
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
