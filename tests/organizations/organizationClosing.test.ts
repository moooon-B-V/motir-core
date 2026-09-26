import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// A CLOSING organization is read-only (Story MOTIR-6306 · MOTIR-6396;
// `docs/decisions/organization-deletion.md` §3), against a REAL Postgres: the flag
// is read through RLS-gated rows in each path's own context, so only the database
// can say the read actually sees the org. One seam is stubbed, the conventional
// one for org-membership writes: the post-commit seat-sync enqueue.
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { db } = await import('@/lib/db');
const { truncateAuthTables } = await import('../helpers/db');
const { makeWorkItemFixture } = await import('../fixtures/workItemFixtures');
const { createTestUser } = await import('../fixtures/userFixtures');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { commentsService } = await import('@/lib/services/commentsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { twoFactorPolicyService } = await import('@/lib/services/twoFactorPolicyService');
const { billingService } = await import('@/lib/services/billingService');
const { gitlabConnectionService } = await import('@/lib/services/gitlabConnectionService');
const { automationRulesService } = await import('@/lib/services/automationRulesService');
const { automationEngineService } = await import('@/lib/services/automationEngineService');
const { dataExportService } = await import('@/lib/services/dataExportService');
const { runClaimNextReady } = await import('@/lib/mcp/tools/claimNextReady');
const { OrganizationClosingError } = await import('@/lib/organizations/errors');
const { ProjectAccessDeniedError } = await import('@/lib/projects/errors');
const { CommentForbiddenError } = await import('@/lib/comments/errors');

type Fixture = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const fx = await makeWorkItemFixture();
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } })
  ).organizationId;
  const wsAdmin = await createTestUser();
  await workspacesService.addMember({
    userId: wsAdmin.id,
    workspaceId: fx.workspaceId,
    role: 'admin',
  });
  const member = await createTestUser();
  await workspacesService.addMember({
    userId: member.id,
    workspaceId: fx.workspaceId,
    role: 'member',
  });
  const orgAdmin = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: orgAdmin.id,
    role: 'admin',
    actorUserId: fx.ownerId,
  });
  const outsider = await createTestUser();
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: 'Ready',
      assigneeId: null,
      descriptionMd: null,
    },
    fx.ctx,
  );
  const ctxOf = (userId: string) => ({ userId, workspaceId: fx.workspaceId });
  return {
    fx,
    organizationId,
    item,
    owner: fx.owner,
    orgAdmin,
    wsAdmin,
    member,
    outsider,
    actors: {
      Owner: fx.ctx,
      'Org Admin': ctxOf(orgAdmin.id),
      'Workspace Admin (Manager)': ctxOf(wsAdmin.id),
      Member: ctxOf(member.id),
      'API token': { ...ctxOf(member.id), tokenProjectId: fx.projectId },
    },
  };
}

async function setClosing(organizationId: string, closing: boolean) {
  await adminDb.organization.update({
    where: { id: organizationId },
    data: { closingSince: closing ? new Date() : null },
  });
}

let s: Fixture;

beforeEach(async () => {
  await truncateAuthTables();
  s = await setup();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('every actor in a closing org can read and cannot write', () => {
  it('refuses an edit, a comment and a status move to each actor, and still lets each read', async () => {
    await setClosing(s.organizationId, true);
    for (const [who, ctx] of Object.entries(s.actors)) {
      await expect(
        workItemsService.updateWorkItem(s.item.id, { title: 'Nope' }, ctx),
        `${who} edit`,
      ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
      await expect(
        commentsService.addComment(s.item.id, { bodyMd: 'Nope' }, ctx),
        `${who} comment`,
      ).rejects.toBeInstanceOf(CommentForbiddenError);
      await expect(
        workItemsService.updateStatus(s.item.id, 'in_progress', ctx),
        `${who} transition`,
      ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
      expect((await workItemsService.getWorkItem(s.item.id, ctx)).title, `${who} read`).toBe(
        'Ready',
      );
    }
  });

  it('writes again on the next request once the deletion is cancelled — nothing to restore', async () => {
    await setClosing(s.organizationId, true);
    await expect(
      workItemsService.updateWorkItem(s.item.id, { title: 'Nope' }, s.fx.ctx),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    await setClosing(s.organizationId, false);
    for (const ctx of Object.values(s.actors)) {
      await workItemsService.updateWorkItem(s.item.id, { title: 'Back' }, ctx);
    }
    await commentsService.addComment(s.item.id, { bodyMd: 'Back' }, s.actors.Member);
    expect((await workItemsService.getWorkItem(s.item.id, s.fx.ctx)).title).toBe('Back');
  });

  it('keeps the personal-data export open', async () => {
    await setClosing(s.organizationId, true);
    await expect(dataExportService.requestDataExport(s.member.id)).resolves.toBeTruthy();
  });
});

describe('the org-tier writes refuse with ORGANIZATION_CLOSING', () => {
  const refusals: Array<[string, () => Promise<unknown>]> = [
    [
      'rename',
      () =>
        organizationsService.renameOrganization({
          organizationId: s.organizationId,
          actorUserId: s.owner.id,
          name: 'Renamed',
        }),
    ],
    [
      'the 2FA policy',
      () =>
        twoFactorPolicyService.setOrganizationPolicy({
          organizationId: s.organizationId,
          actorUserId: s.owner.id,
          requiresTwoFactor: true,
        }),
    ],
    [
      'the workspace 2FA policy',
      () =>
        twoFactorPolicyService.setWorkspacePolicy({
          workspaceId: s.fx.workspaceId,
          actorUserId: s.owner.id,
          requiresTwoFactor: true,
        }),
    ],
    [
      'a member invite',
      () =>
        organizationsService.addMember({
          organizationId: s.organizationId,
          userId: s.outsider.id,
          role: 'member',
          actorUserId: s.owner.id,
        }),
    ],
    [
      'a role change',
      () =>
        organizationsService.changeMemberRole({
          organizationId: s.organizationId,
          userId: s.member.id,
          role: 'admin',
          actorUserId: s.owner.id,
        }),
    ],
    [
      'a member removal',
      () =>
        organizationsService.removeMember({
          organizationId: s.organizationId,
          userId: s.member.id,
          actorUserId: s.owner.id,
        }),
    ],
    [
      'a workspace create',
      () =>
        workspacesService.createWorkspace({
          name: 'Second',
          ownerUserId: s.owner.id,
          organizationId: s.organizationId,
        }),
    ],
    [
      'a workspace removal',
      () =>
        workspacesService.removeWorkspaceAsOrgAdmin({
          workspaceId: s.fx.workspaceId,
          actorUserId: s.owner.id,
        }),
    ],
    [
      'the billing portal',
      () => {
        vi.stubEnv('MOTIR_CLOUD', 'true');
        return billingService.openPortal({
          organizationId: s.organizationId,
          actorUserId: s.owner.id,
        });
      },
    ],
    [
      'a checkout',
      () => {
        vi.stubEnv('MOTIR_CLOUD', 'true');
        return billingService.startCheckout({
          organizationId: s.organizationId,
          actorUserId: s.owner.id,
          priceLookupKey: 'credit_topup',
        });
      },
    ],
    [
      'a Git disconnect',
      () =>
        gitlabConnectionService.disconnect({ userId: s.owner.id, workspaceId: s.fx.workspaceId }),
    ],
  ];

  for (const [what, write] of refusals) {
    it(`refuses ${what}`, async () => {
      await setClosing(s.organizationId, true);
      const err = await write().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OrganizationClosingError);
      expect((err as InstanceType<typeof OrganizationClosingError>).code).toBe(
        'ORGANIZATION_CLOSING',
      );
    });
  }

  it('changes nothing it refused, and admits the same writes once cancelled', async () => {
    await setClosing(s.organizationId, true);
    await organizationsService
      .renameOrganization({ organizationId: s.organizationId, actorUserId: s.owner.id, name: 'X' })
      .catch(() => undefined);
    const org = await adminDb.organization.findUniqueOrThrow({ where: { id: s.organizationId } });
    expect(org.name).not.toBe('X');

    await setClosing(s.organizationId, false);
    await organizationsService.renameOrganization({
      organizationId: s.organizationId,
      actorUserId: s.owner.id,
      name: 'X',
    });
    await organizationsService.changeMemberRole({
      organizationId: s.organizationId,
      userId: s.member.id,
      role: 'admin',
      actorUserId: s.owner.id,
    });
  });

  it('still tells a non-member 404, not the org’s state', async () => {
    await setClosing(s.organizationId, true);
    const err = await organizationsService
      .renameOrganization({
        organizationId: s.organizationId,
        actorUserId: s.outsider.id,
        name: 'X',
      })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(OrganizationClosingError);
  });
});

describe('the automated actors stand still, and resume without a restart', () => {
  it('records an org_closing run instead of firing a rule, then fires after cancel', async () => {
    const rule = await automationRulesService.create(
      s.fx.projectIdentifier,
      {
        name: 'start it',
        triggerType: 'created',
        triggerConfig: {},
        conditionFilterParam: null,
        actions: [{ type: 'transition', toStatusId: 'in_progress' }],
      },
      s.fx.ctx,
    );
    await setClosing(s.organizationId, true);
    const event = {
      trigger: 'created' as const,
      workspaceId: s.fx.workspaceId,
      projectId: s.fx.projectId,
      workItemId: s.item.id,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const paused = await automationEngineService.runForEvent({ ...event, eventId: 'evt-closing' });
    expect(paused).toMatchObject({ matched: 1, succeeded: 0, failed: 0, orgClosing: 1 });
    const rows = await adminDb.automationRuleExecution.findMany({ where: { ruleId: rule.id } });
    expect(rows.map((r) => r.status)).toEqual(['org_closing']);
    expect(rows[0]!.error).toMatch(/^ORGANIZATION_CLOSING: /);
    const after = await adminDb.automationRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(after).toMatchObject({ consecutiveFailureCount: 0, enabled: true });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: s.item.id } })).status).toBe(
      'todo',
    );

    await setClosing(s.organizationId, false);
    const resumed = await automationEngineService.runForEvent({ ...event, eventId: 'evt-open' });
    expect(resumed).toMatchObject({ matched: 1, succeeded: 1 });
    warn.mockRestore();
  });

  it('claims no card while closing — and says not to retry — then claims after cancel', async () => {
    await setClosing(s.organizationId, true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await workItemsService.claimNextReady(s.fx.projectId, null, s.fx.ctx)).toBeNull();
    const tool = await runClaimNextReady({ projectKey: s.fx.projectIdentifier }, s.fx.ctx);
    const text = tool.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).toMatch(/scheduled for deletion/);
    expect(text).toMatch(/Do NOT retry/);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: s.item.id } })).status).toBe(
      'todo',
    );

    await setClosing(s.organizationId, false);
    const claimed = await workItemsService.claimNextReady(s.fx.projectId, null, s.fx.ctx);
    expect(claimed?.id).toBe(s.item.id);
    warn.mockRestore();
  });

  it('freezes the seat count instead of pushing a quantity to billing', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    await adminDb.organization.update({
      where: { id: s.organizationId },
      data: { closingSince: new Date(), scaledTrackerSubscription: { status: 'active' } },
    });
    expect(await billingService.syncScaledTrackerSeatQuantity(s.organizationId)).toEqual({
      applied: false,
      outcome: 'unchanged',
    });
  });
});
