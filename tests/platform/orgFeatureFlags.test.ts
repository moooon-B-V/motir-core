import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlatformFeatureFlagStateError,
  PlatformOrganizationNotFoundError,
  PlatformUnknownFeatureFlagError,
} from '@/lib/platform/errors';
import { OrgFeatureDisabledError } from '@/lib/featureFlags/errors';
import { orgFeatureDisabledResponse } from '@/lib/featureFlags/errorResponse';
import { ORG_FEATURE_FLAG_KEYS } from '@/lib/featureFlags/registry';
import { featureFlagService } from '@/lib/services/featureFlagService';
import { platformOrgLifecycleService } from '@/lib/services/platformOrgLifecycleService';
import { workspacesService } from '@/lib/services/workspacesService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { submitJob } from '@/lib/ai/motirAiClient';
import { classifyApiV1Error } from '@/lib/api/v1/errors';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * PER-ORGANIZATION KILL-SWITCHES (Story 10.3 · MOTIR-750).
 *
 * - The registry is closed and every default is ON: a fresh org needs no rows.
 * - The flip is `superadmin`, reason-required, unknown-key-refused, no-op-refused,
 *   and writes exactly one `org.kill_switch_*` row with `{ key, enabled }`.
 * - The evaluation is "override, else default", per org — another org is
 *   untouched — and a suspended org reads every switch off.
 * - The enforcement points refuse with the typed `ORG_FEATURE_DISABLED`: the
 *   planning submit (before any network call) and the hosted-run start; the
 *   `web_search` switch rides the job envelope as `tenant.webSearch: false`.
 */

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedOperator(role: 'support' | 'operator' | 'superadmin' = 'superadmin') {
  const user = await createTestUser({ email: `ops+flags-${role}-${++seq}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

async function seedOrg(name = 'Acme') {
  const user = await createTestUser({ email: `member-flags-${++seq}@example.com` });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: user.id });
  return { user, workspace, organizationId: workspace.organizationId };
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  vi.clearAllMocks();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  currentPrincipal = await seedOperator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the registry and the evaluation', () => {
  it('is a closed set, every switch ON by default — a fresh org needs no rows', async () => {
    expect([...ORG_FEATURE_FLAG_KEYS]).toEqual(['ai_planning', 'hosted_runs', 'web_search']);
    const { organizationId } = await seedOrg();
    for (const key of ORG_FEATURE_FLAG_KEYS) {
      expect(await featureFlagService.isEnabled(organizationId, key)).toBe(true);
    }
    expect(await adminDb.orgFeatureFlag.count()).toBe(0);
  });

  it('a switch OFF disables the feature for THAT org only', async () => {
    const a = await seedOrg('Org A');
    const b = await seedOrg('Org B');
    await featureFlagService.setFlag(
      currentPrincipal!,
      a.organizationId,
      'ai_planning',
      false,
      'Abuse',
    );

    expect(await featureFlagService.isEnabled(a.organizationId, 'ai_planning')).toBe(false);
    expect(await featureFlagService.isEnabled(a.organizationId, 'hosted_runs')).toBe(true);
    expect(await featureFlagService.isEnabled(b.organizationId, 'ai_planning')).toBe(true);
    await expect(
      featureFlagService.assertEnabled(a.organizationId, 'ai_planning'),
    ).rejects.toMatchObject({
      code: 'ORG_FEATURE_DISABLED',
      key: 'ai_planning',
      refusal: 'switched_off',
    });
    await expect(
      featureFlagService.assertEnabled(b.organizationId, 'ai_planning'),
    ).resolves.toBeUndefined();
    await expect(
      featureFlagService.assertEnabledForWorkspace(a.workspace.id, 'ai_planning'),
    ).rejects.toBeInstanceOf(OrgFeatureDisabledError);
  });

  it('an unknown stored key is ignored on read — evaluation stays override-else-default (MOTIR-753)', async () => {
    const { organizationId } = await seedOrg();
    // A row the write path would refuse (a retired or never-registered key),
    // inserted underneath the service — e.g. left behind by a removed switch.
    await adminDb.orgFeatureFlag.create({
      data: { organizationId, key: 'beta_canvas', enabled: false, reason: 'stale' },
    });
    await adminDb.orgFeatureFlag.create({
      data: { organizationId, key: 'hosted_runs', enabled: false, reason: 'Spend' },
    });

    expect(await featureFlagService.isEnabled(organizationId, 'ai_planning')).toBe(true);
    expect(await featureFlagService.isEnabled(organizationId, 'hosted_runs')).toBe(false);
    const read = await featureFlagService.listForOrganization(currentPrincipal!, organizationId);
    expect(read.flags.map((f) => f.key)).toEqual([...ORG_FEATURE_FLAG_KEYS]);
  });

  it('a suspended org reads every switch off, and its overrides survive reactivation', async () => {
    const { organizationId } = await seedOrg();
    await featureFlagService.setFlag(
      currentPrincipal!,
      organizationId,
      'web_search',
      false,
      'Cost',
    );
    await platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'Unpaid');

    await expect(
      featureFlagService.assertEnabled(organizationId, 'hosted_runs'),
    ).rejects.toMatchObject({
      refusal: 'organization_suspended',
    });

    await platformOrgLifecycleService.reactivate(currentPrincipal!, organizationId, 'Paid');
    expect(await featureFlagService.isEnabled(organizationId, 'hosted_runs')).toBe(true);
    expect(await featureFlagService.isEnabled(organizationId, 'web_search')).toBe(false);
  });
});

describe('featureFlagService.setFlag — the audited flip', () => {
  it('writes the override and ONE `org.kill_switch_off` row with { key, enabled }; back ON writes `_on`', async () => {
    const { organizationId } = await seedOrg();

    const off = await featureFlagService.setFlag(
      currentPrincipal!,
      organizationId,
      'hosted_runs',
      false,
      'Runaway container spend',
    );
    expect(off).toMatchObject({
      key: 'hosted_runs',
      enabled: false,
      defaultEnabled: true,
      overridden: true,
      reason: 'Runaway container spend',
      updatedBy: { userId: currentPrincipal!.userId },
    });
    const on = await featureFlagService.setFlag(
      currentPrincipal!,
      organizationId,
      'hosted_runs',
      true,
      'Fixed',
    );
    expect(on.enabled).toBe(true);

    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.metadata])).toEqual([
      ['org.kill_switch_off', { key: 'hosted_runs', enabled: false }],
      ['org.kill_switch_on', { key: 'hosted_runs', enabled: true }],
    ]);
    expect(rows[0]).toMatchObject({
      targetKind: 'organization',
      targetId: organizationId,
      organizationId,
      reason: 'Runaway container spend',
    });
  });

  it('refuses an unknown key and a blank reason before any row is written', async () => {
    const { organizationId } = await seedOrg();
    await expect(
      featureFlagService.setFlag(currentPrincipal!, organizationId, 'beta_canvas', false, 'x'),
    ).rejects.toBeInstanceOf(PlatformUnknownFeatureFlagError);
    await expect(
      featureFlagService.setFlag(currentPrincipal!, organizationId, 'ai_planning', false, '  '),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    expect(await auditRows()).toHaveLength(0);
    expect(await adminDb.orgFeatureFlag.count()).toBe(0);
  });

  it('refuses a no-op (turning ON a default-ON switch) and rolls its audit row back', async () => {
    const { organizationId } = await seedOrg();
    await expect(
      featureFlagService.setFlag(currentPrincipal!, organizationId, 'ai_planning', true, 'noop'),
    ).rejects.toBeInstanceOf(PlatformFeatureFlagStateError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('two operators racing the FIRST flip produce one change and one row (the org-row lock)', async () => {
    const { organizationId } = await seedOrg();
    const outcomes = await Promise.allSettled([
      featureFlagService.setFlag(currentPrincipal!, organizationId, 'ai_planning', false, 'a'),
      featureFlagService.setFlag(currentPrincipal!, organizationId, 'ai_planning', false, 'b'),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(
      (outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason,
    ).toBeInstanceOf(PlatformFeatureFlagStateError);
    expect(await auditRows()).toHaveLength(1);
  });

  it('an unknown org leaves no row; an operator below superadmin cannot flip', async () => {
    await expect(
      featureFlagService.setFlag(currentPrincipal!, 'cmnot-an-org', 'ai_planning', false, 'x'),
    ).rejects.toBeInstanceOf(PlatformOrganizationNotFoundError);
    const { organizationId } = await seedOrg();
    currentPrincipal = await seedOperator('operator');
    await expect(
      featureFlagService.setFlag(currentPrincipal, organizationId, 'ai_planning', false, 'x'),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('the console read lists every registry key, override or default, as one audited read', async () => {
    const { organizationId } = await seedOrg();
    await featureFlagService.setFlag(
      currentPrincipal!,
      organizationId,
      'web_search',
      false,
      'Cost',
    );
    currentPrincipal = await seedOperator('support');

    const read = await featureFlagService.listForOrganization(currentPrincipal, organizationId);
    expect(read.organizationSuspended).toBe(false);
    expect(read.flags.map((f) => [f.key, f.enabled, f.overridden])).toEqual([
      ['ai_planning', true, false],
      ['hosted_runs', true, false],
      ['web_search', false, true],
    ]);
    const last = (await auditRows()).at(-1);
    expect(last).toMatchObject({ action: 'estate.read', reason: null });
  });
});

describe('enforcement — the typed refusal at each entry point', () => {
  function stubMotirAi() {
    process.env.MOTIR_AI_URL = 'http://motir-ai.test';
    process.env.MOTIR_AI_SERVICE_TOKEN = 'svc-token';
    const fetchMock = vi.fn(async () => Response.json({ jobId: 'job_1' }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function tenantOf(org: Awaited<ReturnType<typeof seedOrg>>) {
    return {
      organizationId: org.organizationId,
      isMeta: false,
      workspaceId: org.workspace.id,
      projectId: 'proj_1',
      projectKey: 'ACME',
    };
  }

  it('ai_planning OFF: submitJob refuses BEFORE any call to motir-ai; another org still submits', async () => {
    const fetchMock = stubMotirAi();
    const a = await seedOrg('Org A');
    const b = await seedOrg('Org B');
    await featureFlagService.setFlag(
      currentPrincipal!,
      a.organizationId,
      'ai_planning',
      false,
      'Abuse',
    );

    await expect(submitJob('noop', tenantOf(a), {}, { userId: a.user.id })).rejects.toBeInstanceOf(
      OrgFeatureDisabledError,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(submitJob('noop', tenantOf(b), {}, { userId: b.user.id })).resolves.toEqual({
      jobId: 'job_1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('web_search OFF rides the envelope as tenant.webSearch=false; absent otherwise', async () => {
    const fetchMock = stubMotirAi();
    const org = await seedOrg();
    await submitJob('noop', tenantOf(org), {}, { userId: org.user.id });
    await featureFlagService.setFlag(
      currentPrincipal!,
      org.organizationId,
      'web_search',
      false,
      'Cost',
    );
    await submitJob('noop', tenantOf(org), {}, { userId: org.user.id });

    const tenants = fetchMock.mock.calls.map((call) => {
      const init = (call as unknown[])[1] as RequestInit;
      return (JSON.parse(String(init.body)) as { tenant: Record<string, unknown> }).tenant;
    });
    expect(tenants[0]).not.toHaveProperty('webSearch');
    expect(tenants[1]).toMatchObject({ webSearch: false });
  });

  it('hosted_runs OFF: a hosted-run start is refused with the typed error', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'HOST' });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Run me' });
    await featureFlagService.setFlag(
      currentPrincipal!,
      fx.workspace.organizationId,
      'hosted_runs',
      false,
      'Spend',
    );
    await expect(
      hostedRunService.start({ workItemKey: `HOST-${item.key}`, idempotencyKey: 'k-1' }, fx.ctx),
    ).rejects.toMatchObject({ code: 'ORG_FEATURE_DISABLED', key: 'hosted_runs' });
  });

  it('the refusal answers 403 ORG_FEATURE_DISABLED on the cookie routes and on /api/v1', async () => {
    const err = new OrgFeatureDisabledError('org_1', 'ai_planning');
    const res = orgFeatureDisabledResponse(err)!;
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'ORG_FEATURE_DISABLED',
      key: 'ai_planning',
      refusal: 'switched_off',
    });
    expect(orgFeatureDisabledResponse(new Error('x'))).toBeNull();
    expect(classifyApiV1Error(err)?.status).toBe(403);
  });
});
