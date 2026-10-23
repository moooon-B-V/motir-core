import { describe, expect, it } from 'vitest';
import { FLEET_CONTAINER_SIZE } from '@motir/orchestrator';
import {
  DERIVED_TENANTS_PER_SHARD_TARGET,
  GITHUB_INSTALLATION_API_PER_HOUR,
  GITHUB_SECONDARY_LIMITS,
  HEADROOM_ALERT_FRACTION,
  SHARD_VCPU_QUOTA_TARGET,
  TARGET_SHARD_LIMITS,
  TENANT_TARGET,
  shardAdmissionCeiling,
  tenantsPerShard,
  type GithubSecondaryLimit,
} from '@/lib/ciFleet/shardTargets';
import { GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN } from '@/lib/github/runnerJitConfig';

// THE FLEET'S SIZING TARGETS AND THEIR DERIVATIONS (Story MOTIR-8953 ·
// MOTIR-8963, `fleet-per-org-pool.md` AMENDMENT 1) — pure, no DB.
//
// Every expectation is computed from the constants, so a revised target or a
// revised GitHub verdict changes the expectation, not the test.

describe('the target tenant', () => {
  it('derives peakVcpu from peakRunners and the container size', () => {
    expect(TENANT_TARGET.peakVcpu).toBe(TENANT_TARGET.peakRunners * FLEET_CONTAINER_SIZE.cpus);
  });

  it('holds the headroom threshold at 70%', () => {
    expect(HEADROOM_ALERT_FRACTION).toBe(0.7);
  });
});

describe('tenantsPerShard', () => {
  it('carries 48 target tenants on the target account with no secondary limit, bound by vCPU or registrations', () => {
    const vcpu = Math.floor(SHARD_VCPU_QUOTA_TARGET / TENANT_TARGET.peakVcpu);
    const registrations = Math.floor(
      GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN / TENANT_TARGET.startsPer5Min,
    );
    const result = tenantsPerShard({
      vcpuQuota: SHARD_VCPU_QUOTA_TARGET,
      registrationsPer5Min: GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN,
      installationApiPerHour: GITHUB_INSTALLATION_API_PER_HOUR,
    });
    expect(result.tenants).toBe(Math.min(vcpu, registrations));
    expect(result.tenants).toBe(48);
    expect(['vcpu_quota', 'github_registrations_per_5_min']).toContain(result.boundBy);
  });

  it('a 500/h content-creating limit counting both calls carries 6, bound by that limit', () => {
    const contentCreatingPerHour: GithubSecondaryLimit = {
      name: 'github_content_creating_per_hour',
      perPeriod: 500,
      periodSeconds: 60 * 60,
      callsCountedPerRunner: 2,
      verdict: 'assumed',
    };
    const result = tenantsPerShard({
      ...TARGET_SHARD_LIMITS,
      secondaryLimits: [contentCreatingPerHour],
    });
    expect(result).toEqual({
      tenants: Math.floor(500 / (TENANT_TARGET.startsPerHour * TENANT_TARGET.githubCallsPerRunner)),
      boundBy: 'github_content_creating_per_hour',
    });
    expect(result.tenants).toBe(6);
  });

  it("given a GitHub org's limits only, counts no vCPU line", () => {
    const result = tenantsPerShard({
      registrationsPer5Min: GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN,
      installationApiPerHour: GITHUB_INSTALLATION_API_PER_HOUR,
      secondaryLimits: Object.values(GITHUB_SECONDARY_LIMITS),
    });
    expect(result.boundBy).not.toBe('vcpu_quota');
    expect(result.tenants).toBe(
      Math.floor(GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN / TENANT_TARGET.startsPer5Min),
    );
  });

  it('counts the paced per-minute mint limit as the 5-minute target spread over its minutes', () => {
    const mint = GITHUB_SECONDARY_LIMITS.jitconfigMintsPerMinute;
    const result = tenantsPerShard({ secondaryLimits: [mint] });
    expect(result).toEqual({
      tenants: Math.floor((mint.perPeriod * 5) / TENANT_TARGET.startsPer5Min),
      boundBy: mint.name,
    });
  });

  it('never lets a long-period limit see more starts than the hourly target allows', () => {
    const daily: GithubSecondaryLimit = {
      name: 'daily',
      perPeriod: 24 * TENANT_TARGET.startsPerHour * 10,
      periodSeconds: 24 * 60 * 60,
      callsCountedPerRunner: 1,
      verdict: 'assumed',
    };
    expect(tenantsPerShard({ secondaryLimits: [daily] }).tenants).toBe(10);
  });

  it('counts a machine limit against peak runners', () => {
    expect(tenantsPerShard({ machineLimit: TENANT_TARGET.peakRunners * 3 })).toEqual({
      tenants: 3,
      boundBy: 'machine_limit',
    });
  });

  it('answers Infinity with no limit given', () => {
    expect(tenantsPerShard({})).toEqual({ tenants: Infinity, boundBy: null });
  });
});

describe('the GitHub secondary limits', () => {
  it('counts every applicable or unmeasured limit as binding', () => {
    for (const limit of Object.values(GITHUB_SECONDARY_LIMITS)) {
      expect(['applies', 'assumed']).toContain(limit.verdict);
    }
    expect(TARGET_SHARD_LIMITS.secondaryLimits).toEqual(Object.values(GITHUB_SECONDARY_LIMITS));
    // The unmeasured DELETE concurrency is assumed to apply to both calls.
    expect(GITHUB_SECONDARY_LIMITS.concurrentRequests).toMatchObject({
      verdict: 'assumed',
      callsCountedPerRunner: TENANT_TARGET.githubCallsPerRunner,
    });
  });

  it('derives the target-account tenants from every limit, never a typed number', () => {
    expect(DERIVED_TENANTS_PER_SHARD_TARGET).toBe(tenantsPerShard(TARGET_SHARD_LIMITS).tenants);
    expect(DERIVED_TENANTS_PER_SHARD_TARGET).toBe(48);
  });
});

describe('shardAdmissionCeiling', () => {
  it('is floor(vcpuQuota ÷ the container vCPU) — 100 for a granted 200 vCPU', () => {
    expect(shardAdmissionCeiling({ vcpuQuota: 200 })).toBe(200 / FLEET_CONTAINER_SIZE.cpus);
    expect(shardAdmissionCeiling({ vcpuQuota: 200 })).toBe(100);
    expect(shardAdmissionCeiling({ vcpuQuota: 201 })).toBe(100);
  });

  it('is bound by a recorded machine limit below the quota', () => {
    expect(shardAdmissionCeiling({ vcpuQuota: 200, machineLimit: 50 })).toBe(50);
    expect(shardAdmissionCeiling({ vcpuQuota: 200, machineLimit: 500 })).toBe(100);
    expect(shardAdmissionCeiling({ machineLimit: 50 })).toBe(50);
  });

  it('is null with neither recorded', () => {
    expect(shardAdmissionCeiling({})).toBeNull();
    expect(shardAdmissionCeiling({ vcpuQuota: null, machineLimit: null })).toBeNull();
  });
});
