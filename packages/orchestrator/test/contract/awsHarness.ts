import {
  FLEET_CONTAINER_SIZE,
  createAwsOrchestrator,
  type ContainerSpec,
  type UsageAttribution,
} from '../../src/index';
import { AwsEc2Fake } from './awsEc2Fake';
import type { OrchestratorContractHarness } from './orchestratorContract';

// The AWS adapter behind the shared contract suite (MOTIR-9276), over the
// in-memory EC2 of `awsEc2Fake.ts` with the shard's network seeded by tag.
//
// No `liveVolumeIds`: the Docker disk is a `DeleteOnTermination` mapping of the
// instance, so there is no separate volume to leak, and the volume cases skip.
// No capacity reasons yet: typing EC2's capacity codes is MOTIR-9277's.

export const AWS_SHARD_TAG = 'ci-runner-use1-1';
export const AWS_AMI_ID = 'ami-0123456789abcdef0';

/** The env `buildSpec` puts on a CI spec — the four keys plus the dropped flag. */
export const AWS_SPEC_ENV: Readonly<Record<string, string>> = {
  ACTIONS_RUNNER_INPUT_JITCONFIG: 'eyJqaXQiOiJjb25maWcifQ==',
  ACTIONS_RUNNER_CONFIG_ARGS: '--no-default-labels',
  MOTIR_RUNNER_LABEL: 'motir-fleet',
  MOTIR_INTENT_ID: 'intent-1',
  MOTIR_WORKFLOW_JOB_ID: '44001',
};

export const AWS_SPEC: ContainerSpec = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  image: 'unused-on-aws',
  size: FLEET_CONTAINER_SIZE,
  env: AWS_SPEC_ENV,
  timeoutSeconds: 3600,
  region: 'us-east-1',
};

export const AWS_ATTRIBUTION: UsageAttribution = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  size: FLEET_CONTAINER_SIZE,
  observedStartedAt: null,
};

export function awsHarness(): OrchestratorContractHarness {
  const ec2 = new AwsEc2Fake();
  const orchestrator = createAwsOrchestrator({
    ec2,
    region: 'us-east-1',
    shardTag: AWS_SHARD_TAG,
    amiId: AWS_AMI_ID,
  });
  return {
    orchestrator,
    reset() {
      ec2.clear();
      ec2.seedShardNetwork(AWS_SHARD_TAG);
    },
    spec: (overrides = {}) => ({ ...AWS_SPEC, ...overrides }),
    attribution: (overrides = {}) => ({ ...AWS_ATTRIBUTION, ...overrides }),
    // A 4xx: refused outright, not retried.
    failNextProvision: () => ec2.failNext('runInstances', 'InvalidParameterValue', 400),
    capacityReasons: [],
    refuseNextProvisionForCapacity: () => {
      throw new Error('the aws harness declares no capacity reason yet (MOTIR-9277)');
    },
    failNextTeardown: () => ec2.failNext('terminateInstances', 'InternalError', 500),
    neverStart: () => {
      ec2.leaveNextPending = true;
    },
    // The runner exits, the AMI powers the VM off, and the `terminate` shutdown
    // behaviour ends the instance. EC2 keeps no exit code.
    completeJob: (handle) => ec2.endJob(handle.id),
    backdate: (handle, createdAt) => ec2.backdate(handle.id, createdAt),
    liveContainerIds: () => ec2.liveInstanceIds(),
  };
}
