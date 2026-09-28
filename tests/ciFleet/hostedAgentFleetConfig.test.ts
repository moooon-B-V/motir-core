import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOSTED_AGENT_IMAGE_ENV_VAR,
  hostedAgentFleetConfig,
  OrchestratorNotConfiguredError,
} from '@/lib/orchestrator';

// The HOSTED-AGENT workload's config gate (Story MOTIR-683 · MOTIR-690;
// `docs/decisions/hosted-agent-run.md` §6). Two properties: an unconfigured
// deployment names EVERY missing variable at once, and an image pinned by a TAG
// is refused — a tag would let a publish change what a running deployment boots,
// and this image holds the agent a customer's code is handed to.

const FLEET_VARS = [
  'MOTIR_FLEET_ORCHESTRATOR',
  'MOTIR_RUNNER_IMAGE',
  'FLY_FLEET_API_TOKEN',
  'FLY_FLEET_APP',
  'FLY_FLEET_REGION',
  HOSTED_AGENT_IMAGE_ENV_VAR,
];

const DIGEST_IMAGE = 'ghcr.io/moooon-b-v/motir-hosted-agent@sha256:' + 'c'.repeat(64);

function configureFlyFleet(): void {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly-token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-fleet-app');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', 'ghcr.io/moooon-b-v/motir-ci-runner@sha256:' + 'a'.repeat(64));
}

beforeEach(() => {
  for (const key of FLEET_VARS) vi.stubEnv(key, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hostedAgentFleetConfig', () => {
  it('answers a well-formed fake digest under the fake orchestrator', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const config = hostedAgentFleetConfig();
    expect(config.image).toMatch(/@sha256:/);
    expect(config.region).toBe('iad');
  });

  it('names the fleet AND the image when nothing is configured, in one error', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, undefined);
    expect(() => hostedAgentFleetConfig()).toThrow(OrchestratorNotConfiguredError);
    let message = '';
    try {
      hostedAgentFleetConfig();
    } catch (err) {
      message = (err as Error).message;
    }
    // One sentence, one `set`, every variable — never the fleet's own sentence nested.
    expect(message.match(/not configured/g)).toHaveLength(1);
    expect(message).toMatch(/FLY_FLEET_API_TOKEN/);
    expect(message).toContain(HOSTED_AGENT_IMAGE_ENV_VAR);
  });

  it('names only the image when the fleet is configured and the image is not', () => {
    configureFlyFleet();
    expect(() => hostedAgentFleetConfig()).toThrow(
      `The container orchestrator is not configured: set ${HOSTED_AGENT_IMAGE_ENV_VAR}.`,
    );
  });

  it('refuses an image pinned by a tag', () => {
    configureFlyFleet();
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, 'ghcr.io/moooon-b-v/motir-hosted-agent:latest');
    expect(() => hostedAgentFleetConfig()).toThrow(/pinned by digest/);
  });

  it('returns the digest-pinned image and the fleet region', () => {
    configureFlyFleet();
    vi.stubEnv('FLY_FLEET_REGION', 'ams');
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, `  ${DIGEST_IMAGE}  `);
    expect(hostedAgentFleetConfig()).toEqual({ image: DIGEST_IMAGE, region: 'ams' });
  });
});
