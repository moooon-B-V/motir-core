import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { createTestPerson } from './testPerson';

// THE APPROVALS-TAB seed (Story MOTIR-4879 · Subtask MOTIR-5149), modelled on
// `design-approval-seed.ts` — which plants the same shape one surface over, and
// whose reasoning this file inherits rather than re-derives.
//
// What the TAB needs that the item page's spec did not:
//
//   · THREE actors, not two. The tab routes by `assigneeId ?? reporterId`, so a
//     person's queue is defined by what is routed TO them. The reviewer has a
//     gate; the READER has none (the empty state); the VIEWER has one routed to
//     them that they may not decide.
//   · A `viewer` for the see-but-not-decide row. `canDecide` is *assignee OR
//     reporter OR workspace manager*, applied ON TOP of the kind's permission
//     FLOOR (`work_item:edit`). A project `viewer` who is the ASSIGNEE is
//     therefore routed a gate they cannot press — the only shape that produces
//     the frame's state `B` on this surface, and one a member or an owner
//     cannot stand in for.
//
// ⚠️ THE ONE GATE UNDER TEST IS NOT SEEDED — the spec publishes it for real
// through `publish_design_result` over `/api/mcp`, exactly as
// `design-approval-seed.ts` requires and for the same reason: the `awaiting`
// gate is created BY `designEvidenceService` at publish (it calls the kind's own
// `routeTo` and writes the row), so a seeded gate would be an assertion against
// a row the product did not make.
//
// ⚠️ THE PAGER'S FILLER GATES **ARE** SEEDED DIRECTLY, AND THAT IS A STATED
// TRADE RATHER THAN AN OVERSIGHT. A second page needs `HOME_PAGE_SIZE + 1`
// gates, and publishing twenty-six design results over HTTP would spend minutes
// of a lane that already runs 10–20× slower than the main one, to assert
// something the FIRST gate has already proved about the publish path. So
// {@link plantFillerGates} writes rows whose only job is to create a BOUNDARY —
// they are never opened, never decided, and never asserted on individually. The
// claim they support is "this tab renders the shipped pager and page two holds
// different rows", which is about composition and not about how a gate is born.
// Anything asserting a gate's own CONTENT uses the published one.

export const APPROVALS_TAB_PASSWORD = 'approvals-tab-e2e-pass-9';

export interface ApprovalsTabSeed {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  /** The design subtask the spec publishes from — its gate routes to the reviewer. */
  designKey: string;
  designTitle: string;
  designId: string;
  /** The design card routed to the VIEWER, who may see it and not decide it. */
  viewerDesignId: string;
  viewerDesignTitle: string;
  /** Routed the published gate, and may decide it (project `member` + assignee). */
  reviewerEmail: string;
  /** Routed NOTHING — the empty state. */
  readerEmail: string;
  /** Routed a gate they may NOT decide (project `viewer` + assignee). */
  viewerEmail: string;
  reviewerId: string;
  password: string;
  token: string;
}

// ⚠️ Deliberately NOT substrings of one another: `getByRole` matches an
// accessible name by SUBSTRING, so an overlap dies on a strict-mode violation —
// not on anything the spec is about.
const STORY_TITLE = 'Put every waiting decision in one place';
const DESIGN_TITLE = 'Draw the queue row for a published design';
const VIEWER_DESIGN_TITLE = 'Sketch the narrow reflow of a waiting row';

export async function seedApprovalsTab(slug: string): Promise<ApprovalsTabSeed> {
  const owner = await createTestPerson({
    email: `at-owner-${slug}@example.com`,
    password: APPROVALS_TAB_PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Approvals Tab E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Approvals Queue',
    identifier: 'QUEUE',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });

  async function pin(userId: string): Promise<void> {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  // ⚠️ ALL THREE ARE PLAIN WORKSPACE MEMBERS. `canDecide`'s third arm is read
  // off the WORKSPACE role, so seeding any of them as owner or admin would make
  // them able to decide everything and the see-but-not-decide assertion would
  // pass without the permission floor existing at all.
  async function member(label: string, name: string, role: 'member' | 'viewer'): Promise<string> {
    const user = await createTestPerson({
      email: `at-${label}-${slug}@example.com`,
      password: APPROVALS_TAB_PASSWORD,
      name,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    // ⚠️ REPLACE, NEVER `create` — and this cost the first run of this spec.
    // `workspacesService.addMember` ENROLS the new member in the workspace's
    // projects, so a membership already exists by the time we get here. A bare
    // `create` leaves that auto-created `member` row in place beside the one it
    // adds, the resolver reads the wider of the two, and the `viewer` actor is
    // silently a `member` — which makes the see-but-not-decide assertion pass
    // against a reader who could decide after all.
    await adminDb.projectMembership.deleteMany({
      where: { userId: user.id, projectId: project.id },
    });
    await adminDb.projectMembership.create({
      data: { userId: user.id, projectId: project.id, workspaceId: workspace.id, role },
    });
    await pin(user.id);
    return user.id;
  }

  const reviewerId = await member('reviewer', 'Robin Vale', 'member');
  const readerId = await member('reader', 'Sam Reader', 'member');
  const viewerId = await member('viewer', 'Vic Watcher', 'viewer');
  await pin(owner.id);
  // The reader's id is never used again — they are defined entirely by having
  // NOTHING routed to them, which is what makes the empty state meaningful.
  void readerId;

  const ctx = { userId: owner.id, workspaceId: workspace.id };

  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: STORY_TITLE },
    ctx,
  );
  const design = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'subtask',
      title: DESIGN_TITLE,
      parentId: story.id,
      type: 'design',
      assigneeId: reviewerId,
    },
    ctx,
  );
  const viewerDesign = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'subtask',
      title: VIEWER_DESIGN_TITLE,
      parentId: story.id,
      type: 'design',
      assigneeId: viewerId,
    },
    ctx,
  );

  // `in_progress → done` is a legal edge and `todo → done` is not, so a card
  // has to be claimed before an approval can move it — see
  // `design-approval-seed.ts`'s header for the full reasoning.
  await workItemsService.updateStatus(design.id, 'in_progress', ctx);
  await workItemsService.updateStatus(viewerDesign.id, 'in_progress', ctx);

  // The grant comes from the exported CONSTANT, never re-listed, so a green run
  // is evidence about the door a dispatched run actually publishes through.
  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'approvals-tab-e2e',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT],
  });

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    designKey: design.identifier,
    designTitle: DESIGN_TITLE,
    designId: design.id,
    viewerDesignId: viewerDesign.id,
    viewerDesignTitle: VIEWER_DESIGN_TITLE,
    reviewerEmail: `at-reviewer-${slug}@example.com`,
    readerEmail: `at-reader-${slug}@example.com`,
    viewerEmail: `at-viewer-${slug}@example.com`,
    reviewerId,
    password: APPROVALS_TAB_PASSWORD,
    token: minted.token,
  };
}

/**
 * Plant `count` extra AWAITING gates routed to one person — filler whose only
 * job is to push the queue past one page.
 *
 * See the header: these are written directly because the claim they support is
 * about the tab COMPOSING the shipped pager, not about how a gate is born. The
 * gate under test is published for real.
 */
export async function plantFillerGates(
  seed: ApprovalsTabSeed,
  parentStoryTitle: string,
  count: number,
): Promise<void> {
  const story = await adminDb.workItem.findFirstOrThrow({
    where: { projectId: seed.projectId, title: parentStoryTitle },
  });
  for (let i = 0; i < count; i += 1) {
    const item = await workItemsService.createWorkItem(
      {
        projectId: seed.projectId,
        kind: 'subtask',
        title: `Filler decision ${i + 1}`,
        parentId: story.id,
        type: 'design',
        assigneeId: seed.reviewerId,
      },
      { userId: seed.reviewerId, workspaceId: seed.workspaceId },
    );
    await adminDb.approvalGate.create({
      data: {
        workspaceId: seed.workspaceId,
        projectId: seed.projectId,
        workItemId: item.id,
        kind: 'design_result',
        subjectId: `filler-evidence-${item.id}`,
        routedToId: seed.reviewerId,
        // Ordered BEHIND the published gate, so page one's first row is still
        // the one the spec asserts content on.
        createdAt: new Date(Date.now() + (i + 1) * 1000),
      },
    });
  }
}

export const STORY_TITLE_EXPORT = STORY_TITLE;
