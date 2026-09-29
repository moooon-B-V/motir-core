import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePersistentOrchestrator as fleet } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  AgentInstanceNameInvalidError,
  AgentInstanceNameTakenError,
  AgentInstanceNotFoundError,
  AgentInstanceStartRefusedError,
  AgentInstanceStateConflictError,
  AgentProfileNotOfferedError,
} from '@/lib/agentInstances/errors';
import { INSTANCE_WORKSPACE_PATH } from '@/lib/agentInstances/config';
import { OFFERED_AGENT_PROFILES } from '@/lib/agentInstances/profiles';
import { imageDigestResolver } from '@/lib/agentInstances/imageDigest';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import {
  agentInstanceClock,
  agentInstanceLifecycleService as lifecycle,
} from '@/lib/services/agentInstanceLifecycleService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { setWorkspaceRoleFor } from '../helpers/workspaceRoleFixtures';

// THE AGENT-INSTANCE LIFECYCLE (Story MOTIR-6860 · MOTIR-6872) — create, wake,
// hibernate and delete over the real services and a real Postgres, with the
// instance fleet on the FAKE persistent orchestrator and motir-ai and GitHub
// stubbed at their HTTP seam (`fetch`), the way the hosted-run suites stub them.
//
// ⚠️ THE ABSENCES ARE THE ASSERTIONS for every refusal: no instance row, no
// fleet slot, no interval, nothing provisioned. A refusal that took a slot or
// booted a machine and then threw would read, from the error alone, exactly like
// one that did none of it.

const AI = 'https://ai.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  authorization: string | null;
}
let calls: Call[] = [];
let mayRun: boolean | 'unanswerable' = true;
let tokenSeq = 0;

function stubFetch(): void {
  calls = [];
  tokenSeq = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method, body, authorization: headers['authorization'] ?? null });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url === `${AI}/v1/credits/agent-run-check`) {
        if (mayRun === 'unanswerable') return json(503, { code: 'internal_error' });
        return json(200, { balanceCredits: mayRun ? 100 : 0, mayRun });
      }
      if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(url)) {
        return json(200, {
          id: 42,
          account: { login: 'acme' },
          permissions: {},
          suspended_at: null,
        });
      }
      if (url.endsWith('/app/installations/42/access_tokens') && method === 'POST') {
        tokenSeq += 1;
        return json(201, { token: `ghs_clone_${tokenSeq}`, expires_at: '2026-09-28T23:00:00Z' });
      }
      if (url.endsWith('/installation/token') && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

let fx: WorkItemFixture;
let repoSeq = 0;

async function seedRepo(owner: string, name: string): Promise<void> {
  repoSeq += 1;
  const organizationId = fx.workspace.organizationId;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-${owner}` },
    create: {
      installationId: `inst-${fx.workspaceId}-${owner}`,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId,
      repoId: String(900_000 + repoSeq),
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'connected',
      position: `a${String(repoSeq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
}

/** A second member of the workspace, with a role. */
async function member(role: 'member' | 'viewer' = 'member') {
  const user = await adminDb.user.create({
    data: { name: `M ${role}`, email: `m-${role}-${Date.now()}-${Math.random()}@example.com` },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: fx.workspaceId, userId: user.id, workspaceRole: 'member' },
  });
  if (role === 'viewer') await setWorkspaceRoleFor(user.id, fx.workspaceId, 'viewer');
  return { userId: user.id, workspaceId: fx.workspaceId };
}

const slots = () => adminDb.fleetInFlightSlot.findMany({ where: { workload: 'agent_instance' } });
const instances = () => adminDb.agentInstance.findMany({});
const intervals = () => adminDb.agentInstanceInterval.findMany({ orderBy: { createdAt: 'asc' } });

async function expectNothingStarted(): Promise<void> {
  expect(await instances()).toEqual([]);
  expect(await slots()).toEqual([]);
  expect(await intervals()).toEqual([]);
  expect(fleet.persistentSpecs).toEqual([]);
}

/** A virtual clock: `sleep` advances it, so a bounded wait never waits for real. */
let virtualNow = new Date('2026-09-28T10:00:00.000Z').getTime();

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fleet.reset();
  fx = await makeWorkItemFixture();
  mayRun = true;
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '111');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('GITHUB_APP_ID', '222');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('MOTIR_INSTANCE_MAX_RUNNING', '');
  stubFetch();
  virtualNow = new Date('2026-09-28T10:00:00.000Z').getTime();
  vi.spyOn(agentInstanceClock, 'now').mockImplementation(() => new Date(virtualNow));
  vi.spyOn(agentInstanceClock, 'sleep').mockImplementation(async (ms: number) => {
    virtualNow += ms;
  });
  fleet.setNow(() => new Date(virtualNow));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const KEY = () => fx.projectIdentifier;
const create = (name = 'yue-claude', profileId = 'claude', ctx = fx.ctx) =>
  lifecycle.create(KEY(), { name, profileId }, ctx);

describe('create', () => {
  it('pins a digest, provisions machine + volume in the org’s instance app, clones every repository, holds ONE slot, opens ONE interval, ends running', async () => {
    await seedRepo('acme', 'web');
    await seedRepo('acme', 'api');
    const dto = await create();

    expect(dto).toMatchObject({ name: 'yue-claude', profileId: 'claude', state: 'running' });
    expect(dto.imageTag).toBe('ghcr.io/moooon-b-v/motir-sandbox:claude');
    expect(dto.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(fleet.persistentSpecs).toHaveLength(1);
    const spec = fleet.persistentSpecs[0]!;
    expect(spec.image).toBe(`ghcr.io/moooon-b-v/motir-sandbox@${dto.imageDigest}`);
    expect(spec).toMatchObject({
      volumeSizeGb: 10,
      mountPath: '/home/node',
      orgId: fx.workspace.organizationId,
    });
    expect(fleet.appNames()).toEqual([fleet.appNameFor(fx.workspace.organizationId)]);
    expect(fleet.liveVolumeIds()).toHaveLength(1);

    const row = (await instances())[0]!;
    expect(row.machineId).toBeTruthy();
    expect(row.volumeId).toBeTruthy();
    expect(await slots()).toHaveLength(1);
    const [interval] = await intervals();
    expect(interval).toMatchObject({ agentInstanceId: row.id, endedAt: null });
    expect((await slots())[0]!.ownerRef).toBe(interval!.id);

    // One clone exec over BOTH repositories (one installation → one token).
    expect(fleet.execs).toHaveLength(1);
    const command = fleet.execs[0]!.command;
    expect(command.slice(-2)).toEqual(['acme/web', 'acme/api']);
  });

  it('the clone token is READ-scoped and revoked; it is absent from the env, and every remote URL is token-free', async () => {
    await seedRepo('acme', 'web');
    await create();
    const mint = calls.find((c) => c.url.endsWith('/access_tokens'))!;
    expect(mint.body).toMatchObject({ permissions: { contents: 'read' } });
    expect(
      calls.some(
        (c) =>
          c.url.endsWith('/installation/token') &&
          c.method === 'DELETE' &&
          c.authorization === 'token ghs_clone_1',
      ),
    ).toBe(true);

    // The machine's env carries no credential at all — only which record it is.
    expect(fleet.persistentSpecs[0]!.env).toEqual({
      MOTIR_INSTANCE_ID: (await instances())[0]!.id,
    });

    const command = fleet.execs[0]!.command.join('\n');
    expect(command).toContain('https://github.com/$repo.git');
    expect(command).not.toMatch(/https:\/\/[^@\s]*ghs_/);
    expect(command).not.toContain('ghs_clone_1');
    expect(command).toContain(Buffer.from('x-access-token:ghs_clone_1').toString('base64'));
    expect(command).toContain(INSTANCE_WORKSPACE_PATH);
    expect(fleet.execs[0]!.command.slice(0, 4)).toEqual(['runuser', '-u', 'node', '--']);
  });

  it('a project with no repositories clones nothing and still runs', async () => {
    const dto = await create();
    expect(dto.state).toBe('running');
    expect(fleet.execs).toEqual([]);
    expect(calls.some((c) => c.url.endsWith('/access_tokens'))).toBe(false);
  });

  it('corrects the interval’s start to the machine’s own start instant', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    expect(dto.state).toBe('starting');
    const row = (await instances())[0]!;
    const opened = (await intervals())[0]!.startedAt;
    virtualNow += 45_000;
    fleet.completeBoot(row.machineId!);
    expect(await lifecycle.settleBoot(row.id)).toBe('running');
    const corrected = (await intervals())[0]!.startedAt;
    expect(corrected.getTime()).toBe(opened.getTime() + 45_000 + 20_000);
    expect(await lifecycle.settleBoot(row.id)).toBe('noop');
  });

  describe('every refusal changes nothing and provisions nothing', () => {
    it('a profile that is not offered', async () => {
      await expect(create('x', 'cursor')).rejects.toThrow(AgentProfileNotOfferedError);
      await expect(create('x', 'antigravity')).rejects.toThrow(/Antigravity isn.t offered/);
      await expectNothingStarted();
      expect(OFFERED_AGENT_PROFILES.map((p) => p.id)).toEqual([
        'claude',
        'codex',
        'opencode',
        'kimi',
        'aider',
        'goose',
      ]);
    });

    it('a malformed name, and a name already taken on this project', async () => {
      await expect(create('Bad Name')).rejects.toThrow(AgentInstanceNameInvalidError);
      await expectNothingStarted();
      await create('taken');
      await expect(create('taken')).rejects.toThrow(AgentInstanceNameTakenError);
      expect(await instances()).toHaveLength(1);
      expect(await slots()).toHaveLength(1);
    });

    it('credits that cannot start a machine — and credits that could not be checked', async () => {
      mayRun = false;
      await expect(create()).rejects.toMatchObject({ reason: 'credits' });
      mayRun = 'unanswerable';
      await expect(create()).rejects.toMatchObject({ reason: 'credits_unknown' });
      await expectNothingStarted();
    });

    it('there is no per-organisation cap: one organisation runs as many agents as it has credits for', async () => {
      for (const name of ['one', 'two', 'three', 'four', 'five']) await create(name);
      expect((await instances()).map((r) => r.state)).toEqual(Array(5).fill('running'));
      expect(await slots()).toHaveLength(5);
    });

    it('the agent pool’s safety valve reads as Motir being busy', async () => {
      vi.stubEnv('MOTIR_INSTANCE_MAX_RUNNING', '1');
      await create('one');
      await expect(create('two')).rejects.toMatchObject({ reason: 'fleet_busy' });
      expect(await instances()).toHaveLength(1);
      expect(await slots()).toHaveLength(1);
    });

    it('agents have their OWN pool: CI’s shared ceiling neither refuses them nor counts them', async () => {
      vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '1');
      await create('one');
      await create('two');
      expect(await slots()).toHaveLength(2);
      const census = await withSystemContext((tx) => fleetCeilingService.census(new Date(), tx));
      expect(census.byWorkload.agent_instance).toBe(2);
      expect(census.total).toBe(0);
    });

    it('the ten-per-user cap', async () => {
      for (let i = 0; i < 10; i++) {
        await adminDb.agentInstance.create({
          data: {
            workspaceId: fx.workspaceId,
            organizationId: fx.workspace.organizationId,
            projectId: fx.projectId,
            ownerId: fx.ownerId,
            name: `old-${i}`,
            profileId: 'claude',
            imageTag: 't',
            imageDigest: 'sha256:x',
            region: 'iad',
            state: 'hibernated',
          },
        });
      }
      await expect(create()).rejects.toMatchObject({ reason: 'user_cap' });
      expect(await slots()).toEqual([]);
      expect(fleet.persistentSpecs).toEqual([]);
    });

    it('no permission — a viewer is refused `instance:use`', async () => {
      const viewer = await member('viewer');
      await expect(create('v', 'claude', viewer)).rejects.toThrow(PermissionDeniedError);
      await expectNothingStarted();
    });
  });

  it('a provider failure mid-create leaves the instance failed with its reason, no slot, no machine', async () => {
    fleet.failNextMachineCreate('no capacity in iad');
    const dto = await create();
    expect(dto.state).toBe('failed');
    expect(dto.failureReason).toMatch(/no capacity in iad/);
    expect(await slots()).toEqual([]);
    expect(fleet.liveMachineIds()).toEqual([]);
    expect(fleet.liveVolumeIds()).toEqual([]);
    const [interval] = await intervals();
    expect(interval).toMatchObject({ endReason: 'lost', billableSeconds: 0 });
  });

  it('a clone that fails fails the instance with the reason', async () => {
    await seedRepo('acme', 'web');
    fleet.setNextExecResult({ exitCode: 128, stdout: '', stderr: 'fatal: repository not found' });
    const dto = await create();
    expect(dto).toMatchObject({ state: 'failed' });
    expect(dto.failureReason).toMatch(/repository not found/);
    expect(await slots()).toEqual([]);
  });

  it('a digest the registry cannot resolve refuses before anything is taken', async () => {
    vi.spyOn(imageDigestResolver, 'resolve').mockRejectedValueOnce(new Error('ghcr down'));
    await expect(create()).rejects.toThrow(/ghcr down/);
    await expectNothingStarted();
  });
});

describe('hibernate, wake and delete', () => {
  it('hibernate from running stops the machine, closes the ONE interval at the stop instant and releases the slot', async () => {
    const dto = await create();
    virtualNow += 90_000;
    const after = await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    expect(after.state).toBe('hibernated');
    expect(await slots()).toEqual([]);
    const [interval] = await intervals();
    expect(interval).toMatchObject({ endReason: 'hibernated', chargeOutcome: 'pending' });
    expect(interval!.billableSeconds).toBe(90);
    expect(fleet.liveVolumeIds()).toHaveLength(1);
    // The wrong-state call is refused.
    await expect(lifecycle.hibernate(KEY(), dto.id, fx.ctx)).rejects.toThrow(
      AgentInstanceStateConflictError,
    );
  });

  it('wake from hibernated starts the machine (a cold boot), takes a slot and opens exactly one new interval', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    const woken = await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(woken.state).toBe('running');
    expect(await slots()).toHaveLength(1);
    const all = await intervals();
    expect(all).toHaveLength(2);
    expect(all.filter((i) => i.endedAt === null)).toHaveLength(1);
    expect((await slots())[0]!.ownerRef).toBe(all[1]!.id);
    // No re-clone on a wake.
    expect(fleet.operations.filter((o) => o.startsWith('machine:exec'))).toEqual([]);
    await expect(lifecycle.wake(KEY(), dto.id, fx.ctx)).rejects.toThrow(
      AgentInstanceStateConflictError,
    );
  });

  it('a wake the credits refuse changes nothing', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    mayRun = false;
    await expect(lifecycle.wake(KEY(), dto.id, fx.ctx)).rejects.toThrow(
      AgentInstanceStartRefusedError,
    );
    expect((await instances())[0]!.state).toBe('hibernated');
    expect(await slots()).toEqual([]);
    expect(await intervals()).toHaveLength(1);
  });

  it('a start that fails leaves the instance failed, and a failed instance can be woken', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    fleet.failNextStart();
    const failed = await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toMatch(/could not start/);
    expect(await slots()).toEqual([]);
    const again = await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(again).toMatchObject({ state: 'running', failureReason: null });
  });

  it('TWO CONCURRENT WAKES start one machine and open one interval', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    const results = await Promise.allSettled([
      lifecycle.wake(KEY(), dto.id, fx.ctx),
      lifecycle.wake(KEY(), dto.id, fx.ctx),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AgentInstanceStateConflictError);
    expect(fleet.operations.filter((o) => o.startsWith('machine:start'))).toHaveLength(1);
    expect((await intervals()).filter((i) => i.endedAt === null)).toHaveLength(1);
    expect(await slots()).toHaveLength(1);
  });

  it('delete destroys the machine then the volume, closes the open interval, releases the slot, and drops it from the list', async () => {
    const dto = await create();
    await lifecycle.delete(KEY(), dto.id, fx.ctx);
    const ops = fleet.operations;
    expect(ops.indexOf(`machine:destroy:${(await instances())[0]!.machineId}`)).toBeLessThan(
      ops.findIndex((o) => o.startsWith('volume:destroy')),
    );
    expect(fleet.liveMachineIds()).toEqual([]);
    expect(fleet.liveVolumeIds()).toEqual([]);
    expect(await slots()).toEqual([]);
    expect((await intervals())[0]).toMatchObject({ endReason: 'deleted' });
    expect((await instances())[0]!.deletedAt).not.toBeNull();
    expect((await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx.ctx)).total).toBe(0);
    // The name is free again.
    await expect(create()).resolves.toMatchObject({ state: 'running' });
  });

  it('a destroy that fails leaves the instance deleting for the sweep to retry', async () => {
    const dto = await create();
    fleet.failNextDestroy();
    await lifecycle.delete(KEY(), dto.id, fx.ctx);
    expect((await instances())[0]).toMatchObject({ state: 'deleting', deletedAt: null });
    expect(await lifecycle.settleDelete(dto.id)).toBe('deleted');
    expect(await lifecycle.settleDelete(dto.id)).toBe('noop');
  });
});

describe('owner isolation (§8)', () => {
  it('another member cannot list, wake, hibernate or delete my instance — even on the same project', async () => {
    const dto = await create();
    const other = await member('member');
    expect((await lifecycle.list(KEY(), { take: 10, skip: 0 }, other)).instances).toEqual([]);
    await expect(lifecycle.hibernate(KEY(), dto.id, other)).rejects.toThrow(
      AgentInstanceNotFoundError,
    );
    await expect(lifecycle.wake(KEY(), dto.id, other)).rejects.toThrow(AgentInstanceNotFoundError);
    await expect(lifecycle.delete(KEY(), dto.id, other)).rejects.toThrow(
      AgentInstanceNotFoundError,
    );
    expect((await instances())[0]!.state).toBe('running');
    // …and a member may hold their own, several per project.
    await lifecycle.create(KEY(), { name: 'mine-1', profileId: 'codex' }, other);
    await lifecycle.create(KEY(), { name: 'mine-2', profileId: 'goose' }, other);
    expect((await lifecycle.list(KEY(), { take: 10, skip: 0 }, other)).total).toBe(2);
  });
});

describe('list', () => {
  it('pages the caller’s own instances with a total, and reports machine time and credits this month', async () => {
    const a = await create('a');
    virtualNow += 150_000;
    await lifecycle.hibernate(KEY(), a.id, fx.ctx);
    await create('b');
    const page1 = await lifecycle.list(KEY(), { take: 1, skip: 0 }, fx.ctx);
    const page2 = await lifecycle.list(KEY(), { take: 1, skip: 1 }, fx.ctx);
    expect(page1.total).toBe(2);
    expect([...page1.instances, ...page2.instances].map((i) => i.name).sort()).toEqual(['a', 'b']);
    const rowA = [...page1.instances, ...page2.instances].find((i) => i.name === 'a')!;
    expect(rowA).toMatchObject({
      profileName: 'Claude Code',
      machineSecondsThisMonth: 150,
      creditsThisMonth: 3,
    });
  });

  it('touchActivity bumps the idle signal', async () => {
    const dto = await create();
    virtualNow += 60_000;
    await lifecycle.touchActivity(dto.id);
    expect((await instances())[0]!.lastActivityAt.getTime()).toBe(virtualNow);
  });
});
