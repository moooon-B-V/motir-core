import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getOrchestrator,
  isOrchestratorConfigured,
  selectedOrchestratorProvider,
} from '@/lib/orchestrator';
import { flyOrchestrator } from '@/lib/orchestrator/adapters/fly';
import { fakeOrchestrator } from '@/lib/orchestrator/adapters/fake';
import { OrchestratorNotConfiguredError } from '@/lib/orchestrator/errors';
import { recordContainerUsage } from '@/lib/orchestrator/usageSink';
import { buildContainerUsage } from '@/lib/orchestrator/usage';
import { FLEET_CONTAINER_SIZE } from '@/lib/orchestrator/rates';
import type { ContainerHandle, UsageAttribution } from '@/lib/orchestrator/types';

// The COMPOSITION ROOT and the usage SINK (Story MOTIR-1916 · MOTIR-1921).
//
// Two small modules that the provisioner's own suite reaches only incidentally,
// and both of which decide something that matters on a deployment nobody is
// watching: whether a self-hosted `motir-core` can BOOT (it must, with no fleet
// credentials at all), and whether an unpriced container is visible (it must be,
// or a missing rate row is silent forever).

const ATTRIBUTION: UsageAttribution = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workflowJobId: 44001,
  size: FLEET_CONTAINER_SIZE,
  observedStartedAt: null,
};

function handleIn(region: string): ContainerHandle {
  return { provider: 'fly', id: 'm-1', region, createdAt: new Date('2026-08-02T10:00:00.000Z') };
}

function usageIn(region: string) {
  return buildContainerUsage({
    handle: handleIn(region),
    attribution: ATTRIBUTION,
    reason: 'job_completed',
    lifecycle: {
      createdAt: new Date('2026-08-02T10:00:00.000Z'),
      startedAt: new Date('2026-08-02T10:00:00.000Z'),
      stoppedAt: new Date('2026-08-02T10:01:00.000Z'),
      terminalState: 'destroyed',
    },
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the selector — one branch, which is the point of the port', () => {
  it("defaults to Fly, which is §1's decision", () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    expect(selectedOrchestratorProvider()).toBe('fly');
  });

  it('selects the fake adapter when the deployment asks for it', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    expect(selectedOrchestratorProvider()).toBe('fake');
    expect(getOrchestrator()).toBe(fakeOrchestrator);
    // The fake needs no credentials, so a fake-selected deployment is always
    // configured — which is what lets a test suite drive the real service.
    expect(isOrchestratorConfigured()).toBe(true);
  });

  it('is case- and whitespace-insensitive about the selector value', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '  FAKE ');
    expect(selectedOrchestratorProvider()).toBe('fake');
  });

  it('treats an unrecognised value as Fly rather than silently disabling the fleet', () => {
    // The dangerous failure would be the other way round: a typo'd selector that
    // resolves to "no orchestrator" boots no runners while every job queues at
    // GitHub for 24 hours — an outage that looks like a misconfiguration only in
    // hindsight.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'kubernetes');
    expect(selectedOrchestratorProvider()).toBe('fly');
  });

  it('returns the Fly adapter when Fly IS wired', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 't');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', 'img@sha256:a');
    expect(isOrchestratorConfigured()).toBe(true);
    expect(getOrchestrator()).toBe(flyOrchestrator);
  });

  it('THROWS rather than returning null when Fly is selected but unwired', () => {
    // A nullable return invites the lenient fallback that reports success while
    // booting nothing — the same reason `requireRunnerGroupId` throws.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    expect(isOrchestratorConfigured()).toBe(false);
    expect(() => getOrchestrator()).toThrow(OrchestratorNotConfiguredError);
  });

  it('answering "not configured" NEVER throws — a self-hosted build must boot', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    expect(() => isOrchestratorConfigured()).not.toThrow();
    expect(isOrchestratorConfigured()).toBe(false);
  });
});

describe('the usage sink', () => {
  it('WARNS on an unpriced container — the only signal that a rate row is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await recordContainerUsage(usageIn('syd'));
    expect(warn).toHaveBeenCalledWith(
      '[containerUsage] no rate row covers this container — recorded with a zero cost',
      expect.objectContaining({ provider: 'fly', region: 'syd', cpus: 2 }),
    );
  });

  it('says nothing about a normally-priced container', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await recordContainerUsage(usageIn('iad'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('NEVER THROWS — it is called from the `finally` that guarantees teardown', async () => {
    // A sink failure propagating out of that `finally` would turn "the container
    // was destroyed and we could not record it" into "the container may not have
    // been destroyed" — trading a bookkeeping gap for a billing leak.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('logging exploded');
    });
    await expect(recordContainerUsage(usageIn('syd'))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      '[containerUsage] could not record a container-seconds row',
      expect.objectContaining({ handleId: 'm-1' }),
    );
  });
});
