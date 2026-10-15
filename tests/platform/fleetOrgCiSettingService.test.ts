import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  FleetOrgCiGithubWriteError,
  FleetOrgCiNotReadyError,
  FleetOrgCiTargetUnknownError,
  MissingAuditReasonError,
  NotPlatformStaffError,
} from '@/lib/platform/errors';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { ORG_VARIABLE_VISIBILITY } from '@/lib/github/actionsVariables';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { platformFleetOrgCiRepository } from '@/lib/repositories/platformFleetOrgCiRepository';
import type { FleetReadiness } from '@/lib/services/fleetReadinessService';
import type { PlatformRole } from '@/generated/prisma/client';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE FLEET ORG CI SETTING (Story MOTIR-8699 · MOTIR-8714) against a real
// Postgres: the setting row, the meta-org project and its repositories, and the
// hash-chained audit trail are real. GitHub is a fake at `fetch` (the variable,
// the repositories' visibility, the installation token), the provisioning-App
// lookup and the readiness verdict are faked at their seams.

const ORG = 'acme-connected';
const PROVISIONING_ORG = 'motir-projects';
const INSTALLATION = '880011';
const VARIABLE_PATH = `/orgs/${ORG}/actions/variables/MOTIR_RUNNER`;

vi.mock('@/lib/github/repoProvisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/repoProvisioning')>()),
  findProvisioningInstallationId: vi.fn(async (org: string) =>
    org.toLowerCase() === ORG ? INSTALLATION : null,
  ),
}));

let currentPrincipal: PlatformPrincipal;
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return {
    ...actual,
    requirePlatformStaff: async (minimum: PlatformRole = 'support') => {
      if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
        const { NotPlatformStaffError: Refused } = await import('@/lib/platform/errors');
        throw new Refused();
      }
      return currentPrincipal;
    },
  };
});

const { fleetOrgCiSettingService: service } =
  await import('@/lib/services/fleetOrgCiSettingService');
const { fleetReadinessService } = await import('@/lib/services/fleetReadinessService');

interface World {
  variable: { value: string; visibility: string } | null;
  /** Fail the next write of this method with this status (`null` = unreachable). */
  failWrite: { method: string; status: number | null } | null;
  failRead: number | null;
  calls: string[];
}

let world: World;
let fx: WorkItemFixture;
let superadmin: PlatformPrincipal;

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      if (/\/app\/installations\/\d+\/access_tokens$/.test(u.pathname)) {
        return json(200, {
          token: 'ghs_setting_secret',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
      if (repo) return json(200, { private: repo[2] !== 'site' });
      if (u.pathname.startsWith(`/orgs/${ORG}/actions/variables`)) {
        world.calls.push(method);
        if (method === 'GET') {
          if (world.failRead !== null) return json(world.failRead, { message: 'nope' });
          return world.variable
            ? json(200, { name: 'MOTIR_RUNNER', ...world.variable })
            : json(404, { message: 'Not Found' });
        }
        if (world.failWrite && world.failWrite.method === method) {
          if (world.failWrite.status === null) throw new TypeError('fetch failed');
          return json(world.failWrite.status, { message: 'Resource not accessible' });
        }
        const body = init?.body ? (JSON.parse(init.body) as Record<string, string>) : {};
        if (method === 'POST') {
          if (world.variable) return json(409, { message: 'exists' });
          world.variable = { value: body['value']!, visibility: body['visibility']! };
          return json(201, {});
        }
        if (method === 'PATCH' && u.pathname === VARIABLE_PATH) {
          if (!world.variable) return json(404, { message: 'Not Found' });
          world.variable = { value: body['value']!, visibility: body['visibility']! };
          return new Response(null, { status: 204 });
        }
        if (method === 'DELETE' && u.pathname === VARIABLE_PATH) {
          if (!world.variable) return json(404, { message: 'Not Found' });
          world.variable = null;
          return new Response(null, { status: 204 });
        }
      }
      return json(500, { message: `unexpected fetch ${method} ${u.href}` });
    }),
  );
}

function readiness(ready: boolean): FleetReadiness {
  return {
    ready,
    org: ORG,
    checkedAt: new Date().toISOString(),
    conditions: [
      {
        key: 'kill_switch',
        state: 'met',
        reasonCode: 'kill_switch_off',
        message: 'off',
        params: {},
      },
      ready
        ? {
            key: 'runner_group',
            state: 'met',
            reasonCode: 'runner_group_synced',
            message: 'ok',
            params: {},
          }
        : {
            key: 'runner_group',
            state: 'unmet',
            reasonCode: 'no_runner_group',
            message: 'No runner group exists for this project in acme-connected.',
            params: {},
          },
      ...(ready
        ? []
        : [
            {
              key: 'app_repositories' as const,
              state: 'unknown' as const,
              reasonCode: 'read_failed',
              message: 'GitHub could not be reached.',
              params: {},
            },
          ]),
    ],
  } as FleetReadiness;
}

let seq = 0;
async function connectRepo(owner: string, name: string): Promise<void> {
  seq += 1;
  const installationId = `inst-${owner}-${fx.workspaceId}`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId: fx.workspaceId,
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
      organizationId: fx.workspace.organizationId,
      repoId: String(820_000 + seq),
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
      role: (['web', 'api', 'mobile', 'shared'] as const)[seq % 4]!,
      name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'connected',
      position: `a${String(seq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
}

async function principal(role: PlatformRole): Promise<PlatformPrincipal> {
  const user = await createTestUser();
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role };
}

function pair() {
  return { projectId: fx.projectId, org: ORG };
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({
    where: { action: { startsWith: 'fleet.org_ci.' } },
    orderBy: { seq: 'asc' },
  });
}

async function storedRow() {
  return adminDb.platformFleetOrgCi.findUnique({
    where: { projectId_org: { projectId: fx.projectId, org: ORG } },
  });
}

function writes(): string[] {
  return world.calls.filter((m) => m !== 'GET');
}

beforeEach(async () => {
  await truncateAuthTables();
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', PROVISIONING_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  world = { variable: null, failWrite: null, failRead: null, calls: [] };
  installGitHub();
  fx = await makeWorkItemFixture({ name: 'Motir', identifier: 'MOTIR' });
  await adminDb.organization.update({
    where: { id: fx.workspace.organizationId },
    data: { isMeta: true },
  });
  await connectRepo(ORG, 'api');
  await connectRepo(ORG, 'site');
  await connectRepo(PROVISIONING_ORG, 'motir-web');
  superadmin = await principal('superadmin');
  currentPrincipal = superadmin;
  vi.spyOn(fleetReadinessService, 'readinessFor').mockResolvedValue(readiness(true));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('who may read and flip', () => {
  it.each(['support', 'operator'] as const)(
    'a %s is refused on read and write, before any GitHub call',
    async (role) => {
      currentPrincipal = await principal(role);
      await expect(service.getState(currentPrincipal, pair())).rejects.toBeInstanceOf(
        NotPlatformStaffError,
      );
      await expect(
        service.setEnabled(currentPrincipal, pair(), true, 'move CI'),
      ).rejects.toBeInstanceOf(NotPlatformStaffError);
      await expect(service.listTargets(currentPrincipal)).rejects.toBeInstanceOf(
        NotPlatformStaffError,
      );
      expect(world.calls).toEqual([]);
      expect(await auditRows()).toHaveLength(0);
    },
  );
});

describe('listTargets', () => {
  it('offers the connected org with a private repository, never the provisioning org', async () => {
    const targets = await service.listTargets(superadmin);
    expect(targets).toEqual([
      {
        projectId: fx.projectId,
        projectKey: 'MOTIR',
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        org: ORG,
        installationId: INSTALLATION,
      },
    ]);
  });

  it('offers nothing for a project outside the meta organisation', async () => {
    await adminDb.organization.update({
      where: { id: fx.workspace.organizationId },
      data: { isMeta: false },
    });
    expect(await service.listTargets(superadmin)).toEqual([]);
  });
});

describe('setEnabled — ON', () => {
  it('a blank reason is refused before any transaction', async () => {
    await expect(service.setEnabled(superadmin, pair(), true, '   ')).rejects.toBeInstanceOf(
      MissingAuditReasonError,
    );
    expect(writes()).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
    expect(await storedRow()).toBeNull();
  });

  it('not ready ⇒ refused naming every condition not met, no variable call, nothing stored', async () => {
    vi.mocked(fleetReadinessService.readinessFor).mockResolvedValue(readiness(false));
    const err = await service
      .setEnabled(superadmin, pair(), true, 'move CI')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetOrgCiNotReadyError);
    expect((err as FleetOrgCiNotReadyError).conditions).toEqual([
      {
        key: 'runner_group',
        state: 'unmet',
        reasonCode: 'no_runner_group',
        message: 'No runner group exists for this project in acme-connected.',
      },
      {
        key: 'app_repositories',
        state: 'unknown',
        reasonCode: 'read_failed',
        message: 'GitHub could not be reached.',
      },
    ]);
    expect(world.calls).toEqual([]);
    expect(await storedRow()).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('ready ⇒ writes MOTIR_RUNNER on the org, stores ON, one enable row with from/to/reason', async () => {
    const result = await service.setEnabled(superadmin, pair(), true, 'move CI onto the fleet');
    expect(result.outcome).toBe('changed');
    expect(result.state).toMatchObject({
      enabled: true,
      lastReason: 'move CI onto the fleet',
      updatedBy: { userId: superadmin.userId, email: superadmin.email },
    });
    expect(world.variable).toEqual({
      value: MOTIR_RUNNER_LABEL,
      visibility: ORG_VARIABLE_VISIBILITY,
    });
    expect(writes()).toEqual(['POST']);
    expect((await storedRow())?.enabled).toBe(true);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'fleet.org_ci.enable',
      targetKind: 'platform',
      targetId: `${fx.projectId}:${ORG}`,
      targetLabel: `MOTIR · ${ORG}`,
      organizationId: fx.workspace.organizationId,
      reason: 'move CI onto the fleet',
      actorUserId: superadmin.userId,
      metadata: {
        projectId: fx.projectId,
        projectKey: 'MOTIR',
        org: ORG,
        from: false,
        to: true,
        variableOutcome: 'created',
      },
    });
  });

  it('never leaks the installation token into an error, a row or a log', async () => {
    world.failWrite = { method: 'POST', status: 403 };
    const err = await service.setEnabled(superadmin, pair(), true, 'x').catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain('ghs_');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('ghs_');
  });
});

describe('setEnabled — OFF', () => {
  beforeEach(async () => {
    await service.setEnabled(superadmin, pair(), true, 'on first');
    world.calls = [];
  });

  it('deletes the variable, never reads readiness (even one that would throw), one disable row', async () => {
    const readinessSpy = vi
      .mocked(fleetReadinessService.readinessFor)
      .mockRejectedValue(new Error('readiness must not be read on OFF'));
    readinessSpy.mockClear();
    const result = await service.setEnabled(superadmin, pair(), false, 'fleet broke');
    expect(result.outcome).toBe('changed');
    expect(readinessSpy).not.toHaveBeenCalled();
    expect(world.variable).toBeNull();
    expect(writes()).toEqual(['DELETE']);
    expect((await storedRow())?.enabled).toBe(false);
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(['fleet.org_ci.enable', 'fleet.org_ci.disable']);
    expect(rows[1]!.metadata).toMatchObject({ from: true, to: false, variableOutcome: 'deleted' });
  });

  it("an 'absent' variable still completes the flip", async () => {
    world.variable = null;
    const result = await service.setEnabled(superadmin, pair(), false, 'fleet broke');
    expect(result.outcome).toBe('changed');
    expect((await storedRow())?.enabled).toBe(false);
    expect((await auditRows())[1]!.metadata).toMatchObject({ variableOutcome: 'absent' });
  });
});

describe('a flip to the state already held', () => {
  it('repeat OFF ⇒ unchanged, zero writes, zero rows', async () => {
    const result = await service.setEnabled(superadmin, pair(), false, 'again');
    expect(result).toEqual({
      outcome: 'unchanged',
      state: { enabled: false, updatedBy: null, updatedAt: null, lastReason: null },
    });
    expect(world.calls).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });

  it('repeat ON ⇒ unchanged, zero writes, one row only (the first flip)', async () => {
    await service.setEnabled(superadmin, pair(), true, 'on');
    world.calls = [];
    const result = await service.setEnabled(superadmin, pair(), true, 'on again');
    expect(result.outcome).toBe('unchanged');
    expect(result.state.enabled).toBe(true);
    expect(world.calls).toEqual([]);
    expect(await auditRows()).toHaveLength(1);
  });
});

describe('GitHub refuses', () => {
  it.each([
    ['a 403', 403],
    ['a transport failure', null],
  ] as const)(
    '%s on the write ⇒ FleetOrgCiGithubWriteError, row and chain unchanged',
    async (_l, status) => {
      world.failWrite = { method: 'POST', status };
      const chainBefore = await adminDb.platformAuditLog.count();
      const err = await service.setEnabled(superadmin, pair(), true, 'x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FleetOrgCiGithubWriteError);
      expect(err).toMatchObject({ org: ORG, status, operation: 'set' });
      expect(await storedRow()).toBeNull();
      expect(await adminDb.platformAuditLog.count()).toBe(chainBefore);
      expect(world.variable).toBeNull();
    },
  );

  it('a failed read of the variable ⇒ refused before the transaction', async () => {
    world.failRead = 502;
    const err = await service.setEnabled(superadmin, pair(), true, 'x').catch((e: unknown) => e);
    expect(err).toMatchObject({ org: ORG, status: 502, operation: 'read' });
    expect(writes()).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });

  it('the commit failing after GitHub wrote ⇒ the variable is restored to what was read', async () => {
    world.variable = { value: 'ubuntu-latest', visibility: 'private' };
    vi.spyOn(platformFleetOrgCiRepository, 'upsert').mockRejectedValueOnce(
      new Error('commit failed'),
    );
    await expect(service.setEnabled(superadmin, pair(), true, 'x')).rejects.toThrow(
      'commit failed',
    );
    expect(writes()).toEqual(['PATCH', 'PATCH']);
    expect(world.variable).toEqual({ value: 'ubuntu-latest', visibility: 'private' });
    expect(await storedRow()).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('a failed restore logs the disagreement with the pair and re-throws the original', async () => {
    vi.spyOn(platformFleetOrgCiRepository, 'upsert').mockRejectedValueOnce(
      new Error('commit failed'),
    );
    world.failWrite = null;
    const original = installGitHubFailingDelete();
    await expect(service.setEnabled(superadmin, pair(), true, 'x')).rejects.toThrow(
      'commit failed',
    );
    original();
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      expect.stringContaining('GitHub and the stored state now disagree'),
      expect.objectContaining({
        projectId: fx.projectId,
        org: ORG,
        from: false,
        to: true,
        actorUserId: superadmin.userId,
      }),
    );
  });
});

/** After the POST lands, every DELETE fails — the compensation cannot run. */
function installGitHubFailingDelete(): () => void {
  const real = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'DELETE') return json(500, { message: 'boom' });
      return real(url, init as RequestInit);
    }),
  );
  return () => vi.stubGlobal('fetch', real);
}

describe('pairs the console does not offer', () => {
  it.each([
    ['the provisioning org', PROVISIONING_ORG],
    ['an unknown org', 'someone-else'],
  ])('%s ⇒ FleetOrgCiTargetUnknownError, no GitHub variable call', async (_l, org) => {
    await expect(
      service.setEnabled(superadmin, { projectId: fx.projectId, org }, true, 'x'),
    ).rejects.toBeInstanceOf(FleetOrgCiTargetUnknownError);
    expect(world.calls).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('getState', () => {
  it('answers the stored state, the readiness verdict and the variable read back', async () => {
    await service.setEnabled(superadmin, pair(), true, 'move CI');
    const state = await service.getState(superadmin, pair());
    expect(state).toMatchObject({
      enabled: true,
      lastReason: 'move CI',
      updatedBy: { userId: superadmin.userId },
      readiness: { ready: true },
      variable: { state: 'present', value: MOTIR_RUNNER_LABEL },
    });
  });

  it('shows drift: stored ON while GitHub holds no variable, and an unreadable variable', async () => {
    await service.setEnabled(superadmin, pair(), true, 'move CI');
    world.variable = null;
    expect((await service.getState(superadmin, pair())).variable).toEqual({ state: 'absent' });
    world.failRead = 503;
    expect((await service.getState(superadmin, pair())).variable).toEqual({
      state: 'unknown',
      status: 503,
    });
  });
});

describe('concurrency (real database)', () => {
  it('two racing ON flips ⇒ one changed, one unchanged, one audit row', async () => {
    const outcomes = await Promise.all([
      service.setEnabled(superadmin, pair(), true, 'first'),
      service.setEnabled(superadmin, pair(), true, 'second'),
    ]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['changed', 'unchanged']);
    expect(await auditRows()).toHaveLength(1);
    expect((await storedRow())?.enabled).toBe(true);
  });

  it('racing opposite flips ⇒ the stored state is the last committed flip, one row per flip', async () => {
    await service.setEnabled(superadmin, pair(), true, 'on');
    await Promise.all([
      service.setEnabled(superadmin, pair(), false, 'off'),
      service.setEnabled(superadmin, pair(), false, 'off again'),
      service.setEnabled(superadmin, pair(), true, 'on again'),
    ]);
    const rows = await auditRows();
    const last = rows[rows.length - 1]!;
    expect((await storedRow())?.enabled).toBe(last.action === 'fleet.org_ci.enable');
    // Every committed row is a real flip: actions alternate.
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.action).not.toBe(rows[i - 1]!.action);
  });
});

describe('the table', () => {
  it('refuses a second row for one pair, and cascades with its project', async () => {
    await service.setEnabled(superadmin, pair(), true, 'on');
    await expect(
      adminDb.platformFleetOrgCi.create({
        data: { projectId: fx.projectId, org: ORG, enabled: false },
      }),
    ).rejects.toThrow();
    await adminDb.project.delete({ where: { id: fx.projectId } });
    expect(await adminDb.platformFleetOrgCi.count()).toBe(0);
  });
});
