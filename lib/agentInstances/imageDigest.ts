import { createHash } from 'node:crypto';
import { probeImagePull } from '@motir/orchestrator';
import { selectedOrchestratorProvider } from '@/lib/orchestrator';
import { AgentInstancesUnavailableError } from './errors';

// PIN A PROFILE'S MOVING TAG TO ITS DIGEST (Story MOTIR-6860 · MOTIR-6872,
// `docs/decisions/agent-instances.md` §1). An instance boots `…@sha256:<digest>`
// and keeps that digest on its record, so a later publish of the tag never
// changes what an existing instance runs (moving to a newer image is MOTIR-6862's).
//
// The image is PUBLIC (`fleet-image-pull.md` §0), so the digest is asked of the
// registry anonymously — the same probe the fleet's health check makes. On the
// FAKE fleet (every test suite, the E2E lane) nothing boots and no registry is
// asked: the digest is a deterministic stand-in derived from the tag.

/** Test seam: replace the resolver. */
export const imageDigestResolver = {
  resolve: resolveDigest,
};

async function resolveDigest(tag: string): Promise<string> {
  if (selectedOrchestratorProvider() === 'fake') {
    return `sha256:${createHash('sha256').update(tag).digest('hex')}`;
  }
  const verdict = await probeImagePull(tag);
  if (verdict.pullable === true && verdict.digest) return verdict.digest;
  const detail = 'detail' in verdict ? verdict.detail : 'the registry named no digest';
  throw new AgentInstancesUnavailableError(`the image ${tag} could not be resolved (${detail})`);
}

/** The boot reference for a pinned digest: `<repository>@<digest>`. */
export function pinnedImageReference(tag: string, digest: string): string {
  const repository = tag.replace(/:[^/:]+$/, '');
  return `${repository}@${digest}`;
}
