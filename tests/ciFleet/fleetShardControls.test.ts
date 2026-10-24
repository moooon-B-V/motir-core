import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CiRunnerProvisioningIntent,
  FleetShard,
  PlatformRole,
} from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { randomInt, randomToken } from '../helpers/random';

// THE ACCOUNT CONTROLS BESIDE ADD-SHARD (Story MOTIR-8953 · MOTIR-8972), through
// the `fleet-admin` command against real Postgres: set-ceiling (set, clear, the
// provider-limit refusal), disable and enable (and their wrong-state refusals),
// the audit row of each, and admission taking each change on the very next job.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const NOW = new Date('2026-07-15T12:00:00.000Z');

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

let operatorEmail: string;
let jobSeq = 0;

async function staff(role: PlatformRole | null): Promise<string> {
  const user = await usersService.createUser({
    email: `fleet-controls-${randomToken(6).toLowerCase()}@example.com`,
    password: PASSWORD,
    name: 'Operator',
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return user.email;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `fleet-controls-tenant-${suffix}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `A${randomInt(100, 1000)}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

async function seedIntent(
  fx: Fixture,
  overrides: { status?: string; fleetShardId?: string | null } = {},
): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(80_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW,
      status: overrides.status ?? 'pending',
      fleetShardId: overrides.fleetShardId ?? null,
    },
  });
}

async function account(
  machineLimit: number,
  overrides: Partial<{ state: 'active' | 'disabled' | 'provisioning' }> = {},
): Promise<FleetShard> {
  const slug = randomToken(6).toLowerCase();
  return adminDb.fleetShard.create({
    data: {
      name: `acct-${slug}`,
      fleetKind: 'ci_runner',
      provider: 'fly',
      state: overrides.state ?? 'active',
      githubOrg: MOTIR_ORG,
      githubInstallationId: '556677',
      flyOrg: 'motir',
      flyApp: `motir-ci-${slug}`,
      flyRegion: 'iad',
      credentialRef: 'FLEET_SHARD_TEST_TOKEN',
      machineLimit,
    },
  });
}

async function occupy(fx: Fixture, shard: FleetShard, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await seedIntent(fx, { status: 'running', fleetShardId: shard.id });
  }
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFleetAdmin([...argv, '--operator', operatorEmail], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function rowOf(shard: FleetShard): Promise<FleetShard> {
  return adminDb.fleetShard.findUniqueOrThrow({ where: { id: shard.id } });
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({
    where: { action: { startsWith: 'fleet.shard.' } },
    orderBy: { seq: 'asc' },
  });
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '100');
  vi.stubEnv('FLEET_SHARD_TEST_TOKEN', 'fly-test-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      if (String(url).includes('/v1/usage')) {
        return new Response(JSON.stringify({ balance: 1_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch to ${String(url)}`);
    }),
  );
  wireFleetKindSwitch('ci_runner', () => true);
  operatorEmail = await staff('superadmin');
});

afterEach(async () => {
  wireFleetKindSwitch('ci_runner', null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('set-ceiling', () => {
  it('a ceiling below in-flight sends the next job to the kind’s other account, audited before and after', async () => {
    const fx = await seedTenant();
    const a = await account(10);
    const b = await account(5);
    await occupy(fx, a, 3); // A: 7 free, B: 5 free

    const first = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(first)).toMatchObject({ fleetShardId: a.id });

    const result = await run(['set-ceiling', '--name', a.name, '--ceiling', '2']);
    expect(result.code).toBe(0);
    expect((await rowOf(a)).admissionCeilingOverride).toBe(2);

    const second = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(second)).toMatchObject({ fleetShardId: b.id });

    const [row] = await auditRows();
    expect(row).toMatchObject({
      action: 'fleet.shard.ceiling',
      targetKind: 'platform',
      targetId: a.id,
      targetLabel: a.name,
    });
    expect(row!.metadata).toEqual({ fleetKind: 'ci_runner', from: null, to: 2 });
  });

  it('with the other account full too, the next job defers shard_capacity and is never claimed', async () => {
    const fx = await seedTenant();
    const a = await account(10);
    const b = await account(1);
    await occupy(fx, a, 3);
    await occupy(fx, b, 1);

    await run(['set-ceiling', '--name', a.name, '--ceiling', '2']);
    const intent = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      outcome: 'deferred',
      reason: 'shard_capacity',
    });
    const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(row).toMatchObject({ status: 'pending', fleetShardId: null });
  });

  it('--clear returns the account to its derived ceiling', async () => {
    const a = await account(10);
    await run(['set-ceiling', '--name', a.name, '--ceiling', '3']);

    const result = await run(['set-ceiling', '--name', a.name, '--clear']);

    expect(result.code).toBe(0);
    const row = await rowOf(a);
    expect(row.admissionCeilingOverride).toBeNull();
    expect(fleetShardAdmissionService.effectiveCeiling(row)).toBe(10);
    expect((await auditRows()).at(-1)!.metadata).toEqual({
      fleetKind: 'ci_runner',
      from: 3,
      to: null,
    });
  });

  it('refuses a value above the account’s recorded provider limit and writes nothing', async () => {
    const a = await account(10);

    const result = await run(['set-ceiling', '--name', a.name, '--ceiling', '11']);

    expect(result.code).toBe(1);
    expect(result.err).toContain('above ' + a.name + "'s provider limit of 10");
    expect((await rowOf(a)).admissionCeilingOverride).toBeNull();
    expect(await auditRows()).toEqual([]);
  });
});

describe('disable and enable', () => {
  it('a disabled account takes no new job while its running job settles through it; enable restores it', async () => {
    const fx = await seedTenant();
    const a = await account(10);
    const b = await account(2);
    const running = await seedIntent(fx, { status: 'running', fleetShardId: a.id });

    const disabled = await run([
      'disable',
      '--name',
      a.name,
      '--reason',
      'quota cut by the provider',
    ]);
    expect(disabled.code).toBe(0);
    expect((await rowOf(a)).state).toBe('disabled');

    const next = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(next)).toMatchObject({ fleetShardId: b.id });
    // The running container is untouched and still reached through its account.
    expect(
      (await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: running.id } }))
        .status,
    ).toBe('running');
    await expect(fleetShardOrchestratorService.forIntent(running)).resolves.toBeDefined();

    const enabled = await run(['enable', '--name', a.name]);
    expect(enabled.code).toBe(0);
    const after = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(after)).toMatchObject({ fleetShardId: a.id });

    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.reason, r.metadata])).toEqual([
      [
        'fleet.shard.disable',
        'quota cut by the provider',
        { fleetKind: 'ci_runner', from: 'active', to: 'disabled' },
      ],
      [
        'fleet.shard.enable',
        `fleet-admin enable ${a.name}`,
        { fleetKind: 'ci_runner', from: 'disabled', to: 'active' },
      ],
    ]);
  });

  it('disable refuses an account that is not active', async () => {
    const p = await account(10, { state: 'provisioning' });
    const d = await account(10, { state: 'disabled' });

    for (const shard of [p, d]) {
      const result = await run(['disable', '--name', shard.name, '--reason', 'x']);
      expect(result.code).toBe(1);
      expect(result.err).toContain('only an active account can be disabled');
    }
    expect((await rowOf(p)).state).toBe('provisioning');
    expect(await auditRows()).toEqual([]);
  });

  it('enable refuses an account that is not disabled — a provisioning one stays for add-shard', async () => {
    const p = await account(10, { state: 'provisioning' });
    const a = await account(10);

    for (const shard of [p, a]) {
      const result = await run(['enable', '--name', shard.name]);
      expect(result.code).toBe(1);
      expect(result.err).toContain('only a disabled account can be re-enabled');
    }
    expect((await rowOf(p)).state).toBe('provisioning');
  });

  it('disable needs a reason, and every control refuses an operator below superadmin', async () => {
    const a = await account(10);

    expect((await run(['disable', '--name', a.name, '--reason', '  '])).err).toContain(
      '--reason is required',
    );
    operatorEmail = await staff('operator');
    const refused = await run(['set-ceiling', '--name', a.name, '--ceiling', '2']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('is not a superadmin');
    expect((await rowOf(a)).admissionCeilingOverride).toBeNull();
  });
});
