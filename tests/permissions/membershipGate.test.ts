import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { triageService } from '@/lib/services/triageService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';
import { workspacesService } from '@/lib/services/workspacesService';
import { InviteTargetAlreadyMemberError, NotAMemberError } from '@/lib/workspaces/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { AssigneeNotInWorkspaceError, ReporterNotInWorkspaceError } from '@/lib/workItems/errors';
import { readMembership, readOwnMembership } from '@/lib/workspaces/membershipGate';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { captureEmailEvents } from '../helpers/jobs';

// The twelve membership gates, proved ADMITTING (MOTIR-2527).
//
// Every gate here reads `workspace_membership` to answer "is this user a member of
// this workspace?". Each used to read through the `db` singleton, which binds no
// per-transaction GUCs — so under the non-bypass `motir_app` role
// `membership_visible_active_or_own` compared both of its arms against NULL, the row
// was invisible, and the lookup returned `null`. Every gate reports that as NOT a
// member. Measured: 1048 failures under the app role, all of them this
// (`docs/rls-runtime-role-inventory.md`, Finding 1).
//
// ⚠️ THE ADMIT ASSERTIONS ARE THE POINT, AND THEY ARE THE ONES THAT USED TO FAIL.
// A gate that refuses EVERYONE passes every denial test ever written, so a suite of
// denial tests would have stayed green through the entire defect. So each gate below
// is asserted in both directions, and the admit direction comes first.
//
// The fixture is written through `adminDb` (the owner), never through the services —
// it seeds two tenants, which is precisely what the policies forbid, and the services
// write through `@/lib/db`, the connection under test (`tests/helpers/adminDb.ts`).
//
// Since MOTIR-2734 there is one mode: `@/lib/db` is always the non-bypass role, so
// these are always the proof rather than sometimes the regression guard.

interface Tenant {
  ownerId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

let home: Tenant;
/** A real user who belongs to NO workspace — the genuine non-member. */
let outsiderId: string;
/** A real user who belongs to ANOTHER tenant — a non-member with a membership row elsewhere. */
let neighbour: Tenant;

beforeEach(async () => {
  await truncateAuthTables();
  home = await seedTenant('home', 'HOME');
  neighbour = await seedTenant('nbr', 'NBR');
  const outsider = await adminDb.user.create({
    data: { email: 'outsider@example.com', name: 'Outsider' },
  });
  outsiderId = outsider.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the harness is actually exercising the role it claims', () => {
  it('reports whether RLS is live, so a green run is never ambiguous', async () => {
    const [who] = await db.$queryRawUnsafe<{ current_user: string; active: boolean }[]>(
      `SELECT current_user, row_security_active('public.workspace_membership') AS active`,
    );
    // There is only one mode now (MOTIR-2734), so this is a flat assertion:
    // `row_security_active` can never be false while the file below reports
    // success — a BYPASSRLS connection would pass every case here vacuously.
    expect(who?.active).toBe(true);
  });
});

describe('projectsService.assertMembership — the hottest gate (1048 of 1048 failures)', () => {
  it('ADMITS a member', async () => {
    await expect(
      projectsService.assertMembership(home.ownerId, home.workspaceId),
    ).resolves.toBeUndefined();
  });

  it('still refuses a genuine non-member', async () => {
    await expect(projectsService.assertMembership(outsiderId, home.workspaceId)).rejects.toThrow(
      NotAMemberError,
    );
  });

  it('still refuses a member of ANOTHER workspace', async () => {
    // The case a `userId`-only binding would wrongly admit: this user HAS a
    // membership row, just not in this workspace.
    await expect(
      projectsService.assertMembership(neighbour.ownerId, home.workspaceId),
    ).rejects.toThrow(NotAMemberError);
  });
});

describe('workspacesService — findMembership / getWorkspaceSummary / addMember', () => {
  it('ADMITS a member on findMembership', async () => {
    const membership = await workspacesService.findMembership(home.ownerId, home.workspaceId);
    expect(membership).not.toBeNull();
    expect(membership?.role).toBe('owner');
  });

  it('returns null for a non-member on findMembership', async () => {
    await expect(
      workspacesService.findMembership(outsiderId, home.workspaceId),
    ).resolves.toBeNull();
  });

  it('ADMITS a member on getWorkspaceSummary — and returns the WORKSPACE, not just the gate', async () => {
    // Two rows have to be visible for this to be non-null: the membership AND the
    // workspace itself (`workspace_active` reads the same GUCs). Binding only the
    // gate would trade a false "not a member" for a false "no such workspace",
    // which this method also renders as `null`.
    const summary = await workspacesService.getWorkspaceSummary(home.workspaceId, home.ownerId);
    expect(summary).not.toBeNull();
    expect(summary?.id).toBe(home.workspaceId);
  });

  it('returns null on getWorkspaceSummary for a non-member', async () => {
    await expect(
      workspacesService.getWorkspaceSummary(home.workspaceId, outsiderId),
    ).resolves.toBeNull();
  });

  it('addMember WRITES the membership row under the role', async () => {
    // The inventory's ONE true RLS denial:
    //   new row violates row-level security policy for table "workspace_membership"
    // `membership_insert_active_or_bootstrap` gates the INSERT on
    // `app.workspace_id`, and the bare `db.$transaction` this used to run in bound
    // nothing.
    const created = await workspacesService.addMember({
      userId: outsiderId,
      workspaceId: home.workspaceId,
    });
    expect(created.workspaceId).toBe(home.workspaceId);
    // Read back as the OWNER, so this is a statement about the row EXISTING rather
    // than about what the app can see.
    const row = await adminDb.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: outsiderId, workspaceId: home.workspaceId } },
    });
    expect(row?.role).toBe('member');
  });

  it('addMember carries the UPWARD org auto-join across the second tenant-root table', async () => {
    // The org INSERT is gated by `org_membership_insert_active_or_bootstrap` on
    // `app.organization_id` — a GUC the workspace context does not carry, and which
    // is unknowable until the workspace row is read inside the transaction. The
    // subject here is in NO org, so the auto-join must actually INSERT rather than
    // short-circuit on an existing row.
    await workspacesService.addMember({ userId: outsiderId, workspaceId: home.workspaceId });
    const orgRow = await adminDb.organizationMembership.findFirst({
      where: { userId: outsiderId, organizationId: home.organizationId },
    });
    expect(orgRow).not.toBeNull();
    expect(orgRow?.role).toBe('member');
  });

  it('removeMember DELETES a real member rather than silently no-opping', async () => {
    // The read guarding this delete used to run on the `db` singleton INSIDE an
    // already-bound transaction, so it failed SILENTLY: a null reads as "not a
    // member", which is the idempotent no-op — Leave/Remove returned success having
    // deleted nothing.
    await workspacesService.addMember({ userId: outsiderId, workspaceId: home.workspaceId });
    const removed = await workspacesService.removeMember({
      userId: outsiderId,
      workspaceId: home.workspaceId,
    });
    expect(removed).not.toBeNull();
    const row = await adminDb.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: outsiderId, workspaceId: home.workspaceId } },
    });
    expect(row).toBeNull();
  });
});

describe('projectAccessService — resolveInputs + filterBrowsable', () => {
  it('ADMITS a member: the workspace role resolves, so the gate grants browse + edit', async () => {
    const caps = await projectAccessService.getCapabilities(home.projectId, {
      userId: home.ownerId,
      workspaceId: home.workspaceId,
    });
    expect(caps).toEqual({ canBrowse: true, canEdit: true });
  });

  it('still denies a non-member on a non-public project', async () => {
    const caps = await projectAccessService.getCapabilities(home.projectId, {
      userId: outsiderId,
      workspaceId: home.workspaceId,
    });
    expect(caps).toEqual({ canBrowse: false, canEdit: false });
  });

  it('filterBrowsable KEEPS the project for a member', async () => {
    const kept = await projectAccessService.filterBrowsable(
      [{ id: home.projectId, accessLevel: 'limited' as const }],
      { userId: home.ownerId, workspaceId: home.workspaceId },
    );
    expect(kept).toHaveLength(1);
  });

  it('filterBrowsable drops everything for a non-member', async () => {
    const kept = await projectAccessService.filterBrowsable(
      [{ id: home.projectId, accessLevel: 'limited' as const }],
      { userId: outsiderId, workspaceId: home.workspaceId },
    );
    expect(kept).toHaveLength(0);
  });
});

describe('readOwnMembership — the user-only binding, for a gate with no active workspace', () => {
  // The one reader bound with `withUserContext` rather than `withWorkspaceContext`. Its
  // caller is `projectAccessService.resolvePublicInputs`, whose actor may be a CROSS-ORG
  // viewer of a PUBLIC project — binding that project's workspace on their behalf would
  // presume the very membership being read. Only the policy's "or your own" arm is
  // needed, because the row sought is always the subject's own; and it is strictly
  // tighter, since nothing but this user's memberships is visible inside the
  // transaction.
  //
  // Exercised HERE rather than through `getPublicCapabilities` because that method opens
  // with the same unbound `project` read as the two services above, so under the flag it
  // never reaches this reader — and an admit assertion that cannot reach the gate is
  // exactly the vacuity this file exists to avoid.
  it('ADMITS the subject their own membership with no workspace bound', async () => {
    const membership = await readOwnMembership(home.ownerId, home.workspaceId);
    expect(membership).not.toBeNull();
    expect(membership?.role).toBe('owner');
  });

  it('returns null for a user with no membership in that workspace', async () => {
    await expect(readOwnMembership(outsiderId, home.workspaceId)).resolves.toBeNull();
  });

  it('does NOT admit another workspace member — the arm is "your own", not "any"', async () => {
    // The neighbour HAS a membership row; binding only `app.user_id` must still not
    // return it for a workspace they are not in.
    await expect(readOwnMembership(neighbour.ownerId, home.workspaceId)).resolves.toBeNull();
  });

  it('uses the caller transaction when given one, without opening its own', async () => {
    const membership = await withWorkspaceContext(
      { userId: home.ownerId, workspaceId: home.workspaceId },
      (tx) => readOwnMembership(home.ownerId, home.workspaceId, tx),
    );
    expect(membership?.workspaceId).toBe(home.workspaceId);
  });

  it('readMembership likewise honours a caller transaction', async () => {
    const membership = await withWorkspaceContext(
      { userId: home.ownerId, workspaceId: home.workspaceId },
      (tx) => readMembership(home.ownerId, home.workspaceId, tx),
    );
    expect(membership?.role).toBe('owner');
  });
});

describe('workspaceInvitesService.sendInvite — inviter gate + the already-a-member guard', () => {
  it('ADMITS a member as inviter', async () => {
    const captured = captureEmailEvents();
    try {
      await expect(
        workspaceInvitesService.sendInvite({
          inviterUserId: home.ownerId,
          inviterName: 'Home Owner',
          workspaceId: home.workspaceId,
          targetEmail: 'newcomer@example.com',
        }),
      ).resolves.toEqual({ ok: true });
    } finally {
      captured.restore();
    }
  });

  it('still refuses a non-member as inviter', async () => {
    await expect(
      workspaceInvitesService.sendInvite({
        inviterUserId: outsiderId,
        inviterName: 'Outsider',
        workspaceId: home.workspaceId,
        targetEmail: 'newcomer@example.com',
      }),
    ).rejects.toThrow(NotAMemberError);
  });

  it('SEES the target already being a member — the arm that failed OPEN', async () => {
    // This gate's unbound read did not deny anyone; it stopped FIRING. A null read
    // as "not a member yet", so the guard passed and an invite went to someone
    // already in the workspace. The denial direction is the proof here.
    const captured = captureEmailEvents();
    try {
      await expect(
        workspaceInvitesService.sendInvite({
          inviterUserId: home.ownerId,
          inviterName: 'Home Owner',
          workspaceId: home.workspaceId,
          targetEmail: 'home-owner@example.com',
        }),
      ).rejects.toThrow(InviteTargetAlreadyMemberError);
    } finally {
      captured.restore();
    }
  });
});

// ⚠️ THE TWO SERVICES WHOSE GATE COULD NOT BE REACHED UNDER THE FLAG — now reached
// (MOTIR-2569). This block used to carry four `it.runIf(gateReachable)` guards and two
// `gateReachable ? … : …` expectations, and this comment used to explain why.
//
// `workItemsService.createWorkItem` and `triageService.getTriageItemDetail` each opened
// with an UNRELATED `db`-singleton read — `projectRepository.findById` and
// `workItemRepository.findById` — and `project` / `work_item` carry their own
// workspace-keyed RLS policies. So under `TEST_DB_APP_ROLE=1` those reads returned null
// and the method threw `ProjectNotFoundError` / `WorkItemNotFoundError` BEFORE the
// membership gate was ever consulted. Both now read through
// `lib/workspaces/tenantRead.ts`, the sibling of `membershipGate.ts` one layer down.
//
// It is also WHY the MOTIR-2514 inventory saw only ONE error: the membership gate was
// the FIRST unbound read on every path, and it masked every read behind it. Keep that
// in view — the next layer down will look the same way, and the honest completion
// signal is a NAMED error class reaching zero, never the total failure count falling.
//
// ⚠️ EVERY ASSERTION IN THIS FILE NOW HOLDS IDENTICALLY IN BOTH MODES, and that is the
// property to protect. A mode-split expectation here would once again let an UNREACHED
// gate pass for an admitting one — the exact vacuity `gateReachable` was invented to
// make visible, and the reason deleting it was MOTIR-2569's acceptance criterion rather
// than a tidy-up. Do not reintroduce one: if a gate stops being reachable under the
// flag, that is a regression to fix in `lib/`, not a branch to add here.

describe('workItemsService — the reporter and assignee gates', () => {
  it('ADMITS a member as reporter', async () => {
    const outcome = await createAndCatch(
      { userId: home.ownerId, workspaceId: home.workspaceId },
      home.projectId,
    );
    expect(outcome).toBe('past-gates');
  });

  it('ADMITS a member as assignee', async () => {
    const outcome = await createAndCatch(
      { userId: home.ownerId, workspaceId: home.workspaceId },
      home.projectId,
      home.ownerId,
    );
    expect(outcome).toBe('past-gates');
  });

  it('still refuses a non-member as reporter', async () => {
    await expect(
      createAndCatch({ userId: outsiderId, workspaceId: home.workspaceId }, home.projectId),
    ).resolves.toBe('reporter-refused');
  });

  it('still refuses a non-member as assignee', async () => {
    await expect(
      createAndCatch(
        { userId: home.ownerId, workspaceId: home.workspaceId },
        home.projectId,
        outsiderId,
      ),
    ).resolves.toBe('assignee-refused');
  });

  // The cross-tenant arm MOTIR-2569 made explicit in `createWorkItem`. Before it, a
  // project in ANOTHER workspace got as far as the reporter gate and came back
  // `ReporterNotInWorkspaceError` — which tells the caller that a project they cannot
  // see EXISTS, in a workspace they are not in. It is now indistinguishable from a
  // project that never existed (finding #26), in both modes.
  it('refuses a project in ANOTHER workspace as never-existed, not as a membership failure', async () => {
    await expect(
      createAndCatch({ userId: home.ownerId, workspaceId: home.workspaceId }, neighbour.projectId),
    ).resolves.toBe('blocked-before-gate');
  });
});

describe('triageService — the submitter CLASSIFICATION gate', () => {
  it('classifies a member submitter as `member`, not `public`', async () => {
    // The gate that does not deny at all: it decides which of two labels a
    // submitter gets. An unbound read does not refuse the request — it silently
    // re-labels every member submitter as an outside public one, and nothing
    // anywhere reports an error.
    const item = await seedTriageItem(home, home.ownerId);
    const detail = await triageService.getTriageItemDetail(item.id, {
      userId: home.ownerId,
      workspaceId: home.workspaceId,
    });
    expect(detail.submitter.kind).toBe('member');
    expect(detail.submitter.userId).toBe(home.ownerId);
  });

  it('still classifies a non-member submitter as `public`', async () => {
    const item = await seedTriageItem(home, outsiderId);
    const detail = await triageService.getTriageItemDetail(item.id, {
      userId: home.ownerId,
      workspaceId: home.workspaceId,
    });
    expect(detail.submitter.kind).toBe('public');
  });
});

/**
 * Run `createWorkItem` and classify the outcome by WHAT DECIDED IT — the gates alone,
 * never how far the create got afterwards.
 *
 * The three outcomes are distinct on purpose. `past-gates` means both membership gates
 * admitted (whatever a later step then did — the fixture project here has no workflow
 * statuses, so a create that reaches the transaction fails on `NoInitialStatusError`,
 * and that is still a pass for this file's question). `blocked-before-gate` means the
 * method never reached a gate at all, which is what the unbound `project` read does
 * under the flag — and collapsing it into `past-gates` would let an unreached gate look
 * like an admitting one, the exact vacuity this file is written against.
 */
type GateOutcome = 'past-gates' | 'blocked-before-gate' | 'reporter-refused' | 'assignee-refused';

async function createAndCatch(
  ctx: { userId: string; workspaceId: string },
  projectId: string,
  assigneeId?: string,
): Promise<GateOutcome> {
  try {
    await workItemsService.createWorkItem(
      { projectId, kind: 'task', title: 'Gate probe', ...(assigneeId ? { assigneeId } : {}) },
      ctx,
    );
    return 'past-gates';
  } catch (err) {
    if (err instanceof ReporterNotInWorkspaceError) return 'reporter-refused';
    if (err instanceof AssigneeNotInWorkspaceError) return 'assignee-refused';
    if (err instanceof ProjectNotFoundError) return 'blocked-before-gate';
    return 'past-gates';
  }
}

/** A work item sitting IN triage, attributed to `submittedByUserId`, written as the owner. */
async function seedTriageItem(tenant: Tenant, submittedByUserId: string) {
  return adminDb.workItem.create({
    data: {
      workspaceId: tenant.workspaceId,
      projectId: tenant.projectId,
      kind: 'bug',
      identifier: `${tenant.projectId.slice(0, 4).toUpperCase()}-1`,
      key: 1,
      title: 'A submitted report',
      reporterId: tenant.ownerId,
      submittedByUserId,
      triagedAt: new Date(),
      position: 'a0',
      backlogRank: 'a0',
    },
  });
}

/** The full tenant root chain the app builds at signup, plus one project. */
async function seedTenant(tag: string, identifier: string): Promise<Tenant> {
  const owner = await adminDb.user.create({
    data: { email: `${tag}-owner@example.com`, name: `${tag} owner` },
  });
  const organization = await adminDb.organization.create({
    data: { name: `Org ${tag}`, slug: `org-${tag}` },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId: organization.id, userId: owner.id, role: 'owner' },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `Workspace ${tag}`, slug: `ws-${tag}`, organizationId: organization.id },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
  });
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: `Project ${tag}`,
      slug: `project-${tag}`,
      identifier,
    },
  });
  return {
    ownerId: owner.id,
    workspaceId: workspace.id,
    organizationId: organization.id,
    projectId: project.id,
  };
}
