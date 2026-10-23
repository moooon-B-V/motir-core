import {
  FLEET_CONTAINER_SIZE,
  fakeOrchestrator,
  type ContainerSpec,
  type UsageAttribution,
} from '../../src/index';
import type { OrchestratorContractHarness } from './orchestratorContract';

// The fake adapter behind the shared contract suite (MOTIR-8960). Every control
// maps straight onto the fake's own control surface. The cross-process store
// seam stays OFF — it is the fake's own behaviour, tested in its own file.

const SPEC: ContainerSpec = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  image: 'motir/ci-runner@sha256:abc',
  size: FLEET_CONTAINER_SIZE,
  env: { ACTIONS_RUNNER_INPUT_JITCONFIG: 'jit' },
  timeoutSeconds: 3600,
  region: 'iad',
};

const ATTRIBUTION: UsageAttribution = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  size: FLEET_CONTAINER_SIZE,
  observedStartedAt: null,
};

export function fakeHarness(): OrchestratorContractHarness {
  return {
    orchestrator: fakeOrchestrator,
    reset() {
      fakeOrchestrator.reset();
    },
    spec: (overrides = {}) => ({ ...SPEC, ...overrides }),
    attribution: (overrides = {}) => ({ ...ATTRIBUTION, ...overrides }),
    failNextProvision: () => fakeOrchestrator.failNextProvision(),
    failNextTeardown: () => fakeOrchestrator.failNextTeardown(),
    neverStart: () => fakeOrchestrator.setBootBehaviour('never_start'),
    completeJob: (handle, options) => fakeOrchestrator.completeJob(handle.id, options),
    backdate: (handle, createdAt) => fakeOrchestrator.backdate(handle.id, createdAt),
    liveContainerIds: () => fakeOrchestrator.liveContainerIds(),
  };
}
