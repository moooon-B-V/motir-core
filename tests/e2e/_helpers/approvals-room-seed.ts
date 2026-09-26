import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { CUSTOM_ROLE_TIER } from '@/lib/permissions/builtinRoles';
import { createTestPerson } from './testPerson';
import {
  APPROVALS_TAB_PASSWORD,
  seedApprovalsTab,
  STORY_TITLE_EXPORT,
  type ApprovalsTabSeed,
} from './approvals-tab-seed';
import { setProjectRoleDefinitionFor } from '../../helpers/workspaceRoleFixtures';

// Seed for the Approval records room's acceptance spec (Story MOTIR-5299 · Subtask
// MOTIR-5304).
//
// ⚠️ IT COMPOSES `approvals-tab-seed.ts` RATHER THAN EXTENDING IT. The tab's spec
// (`acceptance-approvals-tab.spec.ts`) must stay green and unedited, and that seed's
// population is part of what its assertions count. This helper takes the tab's
// world as it is — the owner, the REVIEWER (project `member`, routed the design the
// spec publishes), the READER (project `member`, routed nothing), the VIEWER and the
// `CLI_TOKEN_GRANT` bearer — and adds only what the room's claim needs:
//
//   · a DECIDED record belonging to the READER — somebody other than the reviewer.
//     It is written directly, like the tab seed's filler gates: the claim here is
//     about who may SEE a decision, not about how a decision is made, and the
//     decision the spec DOES make is made for real, through the overlay;
//   · an ADMIN — the built-in project `admin` set, which holds `approval:view_any`
//     through `ROLE_GATED_PERMISSIONS`, and a plain workspace `member` so the full
//     view cannot be arriving through the owner/admin rail;
//   · a CUSTOM-ROLE reader whose role holds ONLY `project:browse` and
//     `approval:view_any` — the product-level proof that the room follows the
//     permission, not a role name. Authoring a custom role through the UI is
//     `plan-decision-permission.spec.ts`'s business; here the role row is written
//     directly, because what is under test is what its holder SEES.
//
// SWITCHING USER: every persona signs in through `signIn` (`shell-session.ts`), which
// starts by dropping the session cookie, so one `page` walks reader after reader
// with nothing but a fresh sign-in between them.

export interface ApprovalsRoomSeed extends ApprovalsTabSeed {
  adminEmail: string;
  customEmail: string;
  readerName: string;
  reviewerName: string;
  /** The READER's decided record — present in the database, absent for the reviewer. */
  readerDecisionTitle: string;
}

const READER_DECISION_TITLE = 'Settle the empty state for a quiet queue';

export async function seedApprovalsRoom(slug: string): Promise<ApprovalsRoomSeed> {
  const tab = await seedApprovalsTab(slug);
  const ownerCtx = await (async () => {
    const owner = await adminDb.workspaceMembership.findFirstOrThrow({
      where: { workspaceId: tab.workspaceId, role: 'owner' },
      select: { userId: true },
    });
    return { userId: owner.userId, workspaceId: tab.workspaceId };
  })();

  async function person(label: string, name: string): Promise<string> {
    const user = await createTestPerson({
      email: `ar-${label}-${slug}@example.com`,
      password: APPROVALS_TAB_PASSWORD,
      name,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: tab.workspaceId });
    await adminDb.projectMembership.deleteMany({
      where: { userId: user.id, projectId: tab.projectId },
    });
    await adminDb.projectMembership.create({
      data: {
        userId: user.id,
        projectId: tab.projectId,
        workspaceId: tab.workspaceId,
        role: 'member',
      },
    });
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: user.id, workspaceId: tab.workspaceId } },
      data: { activeProjectId: tab.projectId },
    });
    return user.id;
  }

  // The built-in project ADMIN.
  const adminId = await person('admin', 'Ada Admin');
  await adminDb.projectMembership.update({
    where: { userId_projectId: { userId: adminId, projectId: tab.projectId } },
    data: { role: 'admin' },
  });

  // The CUSTOM-ROLE reader: browse + the key, and nothing else.
  const customId = await person('custom', 'Cora Custom');
  const role = await adminDb.workspaceRoleDefinition.create({
    data: {
      workspaceId: tab.workspaceId,
      name: 'Approvals lead',
      permissions: ['project:browse', 'approval:view_any'],
    },
  });
  await adminDb.$transaction((tx) =>
    setProjectRoleDefinitionFor(
      customId,
      tab.projectId,
      { roleDefinitionId: role.id, role: CUSTOM_ROLE_TIER },
      tx,
    ),
  );

  // The READER's decided record.
  const reader = await adminDb.user.findUniqueOrThrow({
    where: { email: tab.readerEmail },
    select: { id: true, name: true, email: true },
  });
  const reviewer = await adminDb.user.findUniqueOrThrow({
    where: { id: tab.reviewerId },
    select: { name: true },
  });
  const story = await adminDb.workItem.findFirstOrThrow({
    where: { projectId: tab.projectId, title: STORY_TITLE_EXPORT },
  });
  const item = await workItemsService.createWorkItem(
    {
      projectId: tab.projectId,
      kind: 'subtask',
      title: READER_DECISION_TITLE,
      parentId: story.id,
      type: 'design',
      assigneeId: reader.id,
    },
    ownerCtx,
  );
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: tab.workspaceId,
      projectId: tab.projectId,
      workItemId: item.id,
      kind: 'design_result',
      subjectId: `reader-evidence-${item.id}`,
      routedToId: reader.id,
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    },
  });
  await adminDb.approvalGate.update({
    where: { id: gate.id },
    data: {
      state: 'approved',
      decidedById: reader.id,
      decidedAt: new Date(Date.now() - 86_400_000),
      decidedByLabel: `${reader.name} <${reader.email}>`,
      subjectVersion: 'c0ffee15beef',
    },
  });

  return {
    ...tab,
    adminEmail: `ar-admin-${slug}@example.com`,
    customEmail: `ar-custom-${slug}@example.com`,
    readerName: reader.name,
    reviewerName: reviewer.name,
    readerDecisionTitle: READER_DECISION_TITLE,
  };
}
