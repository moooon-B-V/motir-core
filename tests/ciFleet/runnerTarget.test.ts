import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleetRunnerTargetFor } from '@/lib/ciFleet/runnerTarget';

// Which org a fleet runner lives in (Story MOTIR-8699 · MOTIR-8711). A pure read
// of the intent and the provisioning-org env — the three branches, nothing else.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fleetRunnerTargetFor', () => {
  it('answers undefined for a provisioning-org intent, in any letter case', () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
    for (const repoOwner of ['motir-projects', 'Motir-Projects', 'MOTIR-PROJECTS']) {
      expect(fleetRunnerTargetFor({ repoOwner, installationId: '556677' })).toBeUndefined();
    }
  });

  it('answers undefined when no provisioning org is configured', () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    expect(
      fleetRunnerTargetFor({ repoOwner: 'moooon-B-V', installationId: '778899' }),
    ).toBeUndefined();
  });

  it("answers the repository's own org, through the intent's installation, as the provisioning App", () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
    expect(fleetRunnerTargetFor({ repoOwner: 'moooon-B-V', installationId: '778899' })).toEqual({
      org: 'moooon-B-V',
      installationId: '778899',
      role: 'provisioning',
    });
  });
});
