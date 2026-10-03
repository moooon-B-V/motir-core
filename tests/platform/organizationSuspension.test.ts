import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getSession } from '@/lib/auth';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlatformOrganizationNotFoundError,
  PlatformOrganizationSuspensionStateError,
} from '@/lib/platform/errors';
import { OrganizationSuspendedError } from '@/lib/organizations/errors';
import { platformOrgLifecycleService } from '@/lib/services/platformOrgLifecycleService';
import { platformBillingClassificationService } from '@/lib/services/platformBillingClassificationService';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { classifyApiV1Error } from '@/lib/api/v1/errors';
import { verifyMcpToken } from '@/lib/mcp/auth';
import { GET as v1Me } from '@/app/api/v1/me/route';
import { createTestUser } from '../fixtures/userFixtures';
import { withTokenFor } from '../fixtures/apiV1Fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { trackServerWork } from '../helpers/serverWork';

/**
 * ORGANIZATION SUSPENSION (Story 10.3 · MOTIR-748).
 *
 * Two halves, tested from the side each can fail on:
 *
 * 1. **The platform write** — superadmin only, reason required (refused before
 *    any audit row), a no-op refused under the row lock (rolling its audit row
 *    back), exactly one `org.suspend` / `org.reactivate` row per change.
 * 2. **The gate** — a suspended org's members are refused on every door with
 *    `ORGANIZATION_SUSPENDED` (the access gate, the cookie API door, `/api/v1`,
 *    MCP), a non-member still gets the no-leak null, a member of two orgs falls
 *    through to the other, and a reactivation restores every door.
 */

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The platform tier's `getSession` stand-in; the DEGREE is honoured by
    // re-running the real ladder comparison.
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

// The cookie door reads the session and the workspace cookie.
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'localhost:3000', 'x-forwarded-proto': 'http' }),
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => void cookieJar.set(name, value),
    delete: (name: string) => void cookieJar.delete(name),
  }),
}));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: vi.fn() };
});

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedOperator(role: 'support' | 'operator' | 'superadmin' = 'superadmin') {
  const user = await createTestUser({ email: `ops+suspend-${role}-${++seq}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

/** A member with their own org + workspace, signed in on the cookie door. */
async function seedMember(name = 'Acme') {
  const user = await createTestUser({ email: `member-suspend-${++seq}@example.com` });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: user.id });
  vi.mocked(getSession).mockResolvedValue({
    user: { id: user.id, email: user.email, name: user.name },
  } as never);
  return { user, workspace, organizationId: workspace.organizationId };
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  cookieJar.clear();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  currentPrincipal = await seedOperator();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('platformOrgLifecycleService — suspend / reactivate', () => {
  it('suspends: stamps when/why/who, writes ONE `org.suspend` row with the reason', async () => {
    const { organizationId } = await seedMember();

    const result = await platformOrgLifecycleService.suspend(
      currentPrincipal!,
      organizationId,
      'Unpaid since August (INV-2291)',
    );

    expect(result.organization.suspended).toBe(true);
    expect(result.organization.suspension).toMatchObject({
      reason: 'Unpaid since August (INV-2291)',
      suspendedByUserId: currentPrincipal!.userId,
    });
    // No hosted repos and no in-flight intents: the fleet stop ran and found nothing.
    expect(result.fleetStop).toEqual({ runsCancelled: 0, containersStopped: 0, failures: 0 });

    const org = await adminDb.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(org.suspendedAt).not.toBeNull();
    expect(org.suspendedByUserId).toBe(currentPrincipal!.userId);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'org.suspend',
      targetKind: 'organization',
      targetId: organizationId,
      organizationId,
      reason: 'Unpaid since August (INV-2291)',
      actorUserId: currentPrincipal!.userId,
    });
  });

  it('reactivates: clears all three columns, writes ONE `org.reactivate` row', async () => {
    const { organizationId } = await seedMember();
    await platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'Abuse report');

    const dto = await platformOrgLifecycleService.reactivate(
      currentPrincipal!,
      organizationId,
      'Paid in full',
    );

    expect(dto.suspended).toBe(false);
    expect(dto.suspension).toBeNull();
    const org = await adminDb.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect([org.suspendedAt, org.suspendedReason, org.suspendedByUserId]).toEqual([
      null,
      null,
      null,
    ]);
    expect((await auditRows()).map((r) => r.action)).toEqual(['org.suspend', 'org.reactivate']);
  });

  it('refuses a blank reason BEFORE any row is written', async () => {
    const { organizationId } = await seedMember();
    await expect(
      platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, '   '),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    await expect(
      platformOrgLifecycleService.reactivate(currentPrincipal!, organizationId, ''),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    expect(await auditRows()).toHaveLength(0);
    const org = await adminDb.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(org.suspendedAt).toBeNull();
  });

  it('refuses a no-op in either direction and rolls its audit row back', async () => {
    const { organizationId } = await seedMember();
    await expect(
      platformOrgLifecycleService.reactivate(currentPrincipal!, organizationId, 'not suspended'),
    ).rejects.toBeInstanceOf(PlatformOrganizationSuspensionStateError);
    await platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'first');
    await expect(
      platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'second'),
    ).rejects.toBeInstanceOf(PlatformOrganizationSuspensionStateError);
    expect((await auditRows()).map((r) => r.action)).toEqual(['org.suspend']);
  });

  it('two operators racing produce ONE change and ONE row (the FOR UPDATE re-read)', async () => {
    const { organizationId } = await seedMember();
    const outcomes = await Promise.allSettled([
      platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'race a'),
      platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'race b'),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(PlatformOrganizationSuspensionStateError);
    expect(await auditRows()).toHaveLength(1);
  });

  it('a missing organization leaves no audit row', async () => {
    await expect(
      platformOrgLifecycleService.suspend(currentPrincipal!, 'cmnot-a-real-org', 'reason'),
    ).rejects.toBeInstanceOf(PlatformOrganizationNotFoundError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('is `superadmin` only — an operator is refused before anything is written', async () => {
    const { organizationId } = await seedMember();
    currentPrincipal = await seedOperator('operator');
    await expect(
      platformOrgLifecycleService.suspend(currentPrincipal, organizationId, 'reason'),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('staff keep their access: the console still reads a suspended org, and shows the pill', async () => {
    const { organizationId } = await seedMember();
    await platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'Abuse report');

    const page = await platformBillingClassificationService.getOrganizationPage(
      currentPrincipal!,
      organizationId,
    );
    expect(page.organization.suspended).toBe(true);
    expect(page.actions.map((a) => a.action)).toEqual(['org.suspend']);
  });
});

describe('the gate — a suspended organization refuses its members on every door', () => {
  it('the access gate throws ORGANIZATION_SUSPENDED for a member, and null stays null for a non-member', async () => {
    const { user, workspace, organizationId } = await seedMember('Northwind');
    const stranger = await createTestUser({ email: `stranger-${++seq}@example.com` });
    await platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'Unpaid');

    const refusal = await organizationsService
      .resolveWorkspaceAccess(user.id, workspace.id)
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(OrganizationSuspendedError);
    expect(refusal).toMatchObject({
      code: 'ORGANIZATION_SUSPENDED',
      organizationId,
      organizationName: expect.any(String),
    });
    // The no-leak rule is untouched: a non-member learns nothing.
    expect(await organizationsService.resolveWorkspaceAccess(stranger.id, workspace.id)).toBeNull();
  });

  it('the cookie API door answers 403 ORGANIZATION_SUSPENDED (never a 500, never a 404)', async () => {
    const { organizationId } = await seedMember('Northwind');
    await platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'Unpaid');

    const gate = await requireCompliantWorkspaceContext();
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.response.status).toBe(403);
    expect(await gate.response.json()).toMatchObject({
      code: 'ORGANIZATION_SUSPENDED',
      organizationId,
      noticeAt: `/organization-suspended?org=${organizationId}`,
    });
  });

  it('does not self-heal a fresh workspace around the suspension', async () => {
    const { user, organizationId } = await seedMember('Northwind');
    await platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'Unpaid');
    await expect(workspacesService.resolveActiveWorkspace(user.id, null)).rejects.toBeInstanceOf(
      OrganizationSuspendedError,
    );
    expect(await adminDb.workspaceMembership.count({ where: { userId: user.id } })).toBe(1);
  });

  it('a SIBLING organization’s member is unaffected on every door (MOTIR-753)', async () => {
    const sibling = await seedMember('Sibling Co');
    const siblingToken = await withTokenFor(sibling.user, sibling.workspace);
    const { organizationId } = await seedMember('Northwind');
    await platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'Unpaid');
    expect(sibling.organizationId).not.toBe(organizationId);

    expect(
      await organizationsService.resolveWorkspaceAccess(sibling.user.id, sibling.workspace.id),
    ).not.toBeNull();
    expect(await workspacesService.resolveActiveWorkspace(sibling.user.id, null)).toBe(
      sibling.workspace.id,
    );
    expect((await apiTokensService.verify(siblingToken.token)).workspaceId).toBe(
      sibling.workspace.id,
    );
  });

  it('a member of TWO orgs falls through to the one that is not suspended', async () => {
    const { user, organizationId } = await seedMember('Suspended Co');
    const { workspace: other } = await workspacesService.createWorkspace({
      name: 'Still Fine',
      ownerUserId: user.id,
    });
    expect(other.organizationId).not.toBe(organizationId);
    await platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'Unpaid');

    expect(await workspacesService.resolveActiveWorkspace(user.id, null)).toBe(other.id);
  });

  it('`/api/v1` refuses a suspended org’s PAT with 403 ORGANIZATION_SUSPENDED', async () => {
    const { user, workspace, organizationId } = await seedMember('Northwind');
    const caller = await withTokenFor(user, workspace);
    await platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'Unpaid');

    await expect(apiTokensService.verify(caller.token)).rejects.toBeInstanceOf(
      OrganizationSuspendedError,
    );
    const res = await v1Me(new Request('http://localhost/api/v1/me', { headers: caller.headers }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ORGANIZATION_SUSPENDED' });
    expect(classifyApiV1Error(new OrganizationSuspendedError('o', 'O'))?.status).toBe(403);
  });

  it('MCP: the verifier raises the typed refusal and the route answers 403, not 401', async () => {
    const { user, workspace, organizationId } = await seedMember('Northwind');
    const caller = await withTokenFor(user, workspace);
    await platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'Unpaid');

    await expect(
      verifyMcpToken(new Request('http://localhost/api/mcp'), caller.token),
    ).rejects.toBeInstanceOf(OrganizationSuspendedError);

    const { POST } = await import('@/app/api/mcp/route');
    const res = await trackServerWork(
      POST(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: {
            ...caller.headers,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }) as never,
      ),
      'POST /api/mcp',
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ORGANIZATION_SUSPENDED', organizationId });
  });

  it('reactivating restores every door on the next request', async () => {
    const { user, workspace, organizationId } = await seedMember('Northwind');
    const caller = await withTokenFor(user, workspace);
    await platformOrgLifecycleService.suspend(currentPrincipal!, organizationId, 'Unpaid');
    await platformOrgLifecycleService.reactivate(currentPrincipal!, organizationId, 'Paid');

    expect(await organizationsService.resolveWorkspaceAccess(user.id, workspace.id)).not.toBeNull();
    expect((await apiTokensService.verify(caller.token)).workspaceId).toBe(workspace.id);
    const gate = await requireCompliantWorkspaceContext();
    expect(gate.ok).toBe(true);
  });
});
