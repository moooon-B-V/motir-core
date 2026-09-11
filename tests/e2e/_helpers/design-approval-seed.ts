import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { createTestPerson } from './testPerson';

// THE DESIGN-APPROVAL seed (Story MOTIR-4778 · Subtask MOTIR-4797).
//
// Plants the one shape this story's whole claim rests on: a published design
// AWAITING a decision, a card that is BLOCKED BY the card carrying it, and two
// people who stand in different relations to the question.
//
// ⚠️ THE GATE IS NOT SEEDED. `designEvidenceService` creates the `awaiting`
// `design_result` gate as part of PUBLISHING (it calls the kind's own `routeTo`
// and writes the row), so a seed that inserted a gate directly would be
// asserting against a row the product did not make. The spec publishes through
// the real `publish_design_result` tool over `/api/mcp`, exactly as
// `design-result-publish.spec.ts` does and for the same reason — that path is
// reachable in this lane, and it is the only way the gate's `subjectId`,
// `routedToId` and the evidence row are guaranteed to agree.
//
// ⚠️ THE DESIGN CARD IS SEEDED `in_progress`, AND THAT IS LOAD-BEARING RATHER
// THAN COSMETIC. Approving a design gate with no open pull request writes the
// project's `done` through `workItemsService.applyStatusTransition`, which
// validates the edge — and `todo → done` is NOT in `DEFAULT_TRANSITIONS`
// (`lib/workflows/defaultWorkflow.ts`), while `in_progress → done` is. A card
// left at `todo` would make the approval record a decision and move nothing,
// and the spec would fail on the status assertion for a reason that has nothing
// to do with the gate. It is also the honest shape: an agent claims the card,
// publishes from it, and the reviewer arrives afterwards.

// ⚠️ THE TWO DIRECT WRITES GO THROUGH `adminDb`, NOT `@/lib/db`, AND THE GUARD
// THAT SAYS SO IS RATCHETED. `tests/rls/test-singleton-statement-guard.test.ts`
// counts direct singleton statements under `tests/e2e/**` against a ceiling that
// only ever falls — this file went red at 454 against 452 on its first push, for
// exactly these two lines. The reason behind the ratchet is not bookkeeping:
// under `TEST_DB_APP_ROLE=1` the singleton is the NON-BYPASS runtime role, so a
// seed write through it is REFUSED and a seed read returns `[]` — and neither
// raises. A spec seeded that way drives a browser against a database it believes
// it populated. `adminDb` is the owner half of the two-client model
// (`tests/helpers/adminDb.ts`), which is what fixtures are supposed to hold.
//
// Everything else here seeds through the SERVICES on purpose — they are the
// shipped write paths, and using them is what makes the fixture's tree a tree
// the product could actually have produced. These two rows have no service door.

export const DESIGN_APPROVAL_PASSWORD = 'design-approval-e2e-pass-7';

export interface DesignApprovalSeed {
  workspaceId: string;
  projectKey: string;
  /** The design subtask carrying the published result and its awaiting gate. */
  designKey: string;
  designTitle: string;
  /** The card `blocked_by` the design subtask — the one the story is FOR. */
  dependentKey: string;
  dependentTitle: string;
  /** The gate's routed-to actor: the design card's ASSIGNEE, who may decide. */
  reviewerEmail: string;
  /** A project member who is neither assignee, reporter, nor a workspace
   *  manager — so `canDecide` is false and the frame draws no verbs. */
  readerEmail: string;
  password: string;
  /** A token holding EXACTLY `CLI_TOKEN_GRANT` — a dispatched run's own grant. */
  token: string;
}

/** The note SECTIONS the design card publishes.
 *
 * ⚠️ THE HEADING SHARES NO WORDS WITH ANY CARD TITLE, and that is a rule rather
 * than a style choice: `getByRole` matches an accessible name by SUBSTRING, so
 * an overlap resolves to two headings and dies on a strict-mode violation —
 * not on anything the spec is about. (`design-publish-seed.ts` records the same
 * rule, having paid for it on its own first run.) */
export const NOTE_HEADING = 'Composition and spacing';
export const NOTE_BODY = 'The confirm step states what approving will do before it does it.';
export const NOTE_MD = [
  `## ${NOTE_HEADING}`,
  '',
  NOTE_BODY,
  '',
  'It composes `Button` for each verb and routes colour through `--el-*` only.',
].join('\n');

export const MOCK_SOURCE_PATH = 'design/work-items/approval-frame.mock.html';
export const IMAGE_SOURCE_PATH = 'design/work-items/approval-frame.png';
export const NOTE_SOURCE_PATH = 'design/work-items/design-notes.md';

/** A self-contained mock — inline CSS, no `<script>`, no remote URL (ADR §5). */
export const MOCK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Approval frame</title>
<style>body{margin:0;font:14px/1.5 system-ui,sans-serif}section{padding:20px}</style>
</head><body><section><h2>Approval frame</h2><p>Three bands: what is being decided, the subject, the verbs.</p></section></body></html>`;

/** A 1x1 PNG — a real image rather than a broken-image glyph in the recording. */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ⚠️ Deliberately NOT substrings of one another, nor of the note heading above:
// `getByRole` matches by SUBSTRING and an overlap dies on strict mode.
const STORY_TITLE = 'Let a reviewer settle a published design';
const DESIGN_TITLE = 'Draw the approval frame for a published design';
const DEPENDENT_TITLE = 'Wire the frame into the late section stack';

export async function seedDesignApproval(slug: string): Promise<DesignApprovalSeed> {
  const owner = await createTestPerson({
    email: `da-owner-${slug}@example.com`,
    password: DESIGN_APPROVAL_PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Design Approval E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Approval Gates',
    identifier: 'GATE',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });

  async function pin(userId: string): Promise<void> {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  // ⚠️ BOTH ARE PLAIN WORKSPACE MEMBERS, and that is what makes the two
  // assertions mean anything. `approvalGatesService` composes `canDecide` as
  // *assignee OR reporter OR workspace manager*, and the manager arm is read off
  // the WORKSPACE role (`projectAccessService.isWorkspaceManagerFor` →
  // `isWorkspaceManager(inputs.workspaceRole)`). Seeding the reviewer as the
  // workspace OWNER would make them able to decide everything, and the spec
  // would pass without the assignee arm existing at all.
  async function member(label: string, role: 'admin' | 'member' | 'viewer'): Promise<string> {
    const user = await createTestPerson({
      email: `da-${label}-${slug}@example.com`,
      password: DESIGN_APPROVAL_PASSWORD,
      name: label === 'reviewer' ? 'Robin Vale' : 'Sam Reader',
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await adminDb.projectMembership.create({
      data: { userId: user.id, projectId: project.id, workspaceId: workspace.id, role },
    });
    await pin(user.id);
    return user.id;
  }

  const reviewerId = await member('reviewer', 'member');
  // The reader's id is never used again — they are defined entirely by what
  // they are NOT (assignee, reporter, workspace manager), which is the point.
  await member('reader', 'member');
  await pin(owner.id);

  const ctx = { userId: owner.id, workspaceId: workspace.id };

  // A design result attaches to the LEAF that produced it (ADR §3), and a
  // subtask needs a parent — so the story is scaffolding, not a subject.
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
      // The gate routes to `assigneeId ?? reporterId`, so this is what puts the
      // question in front of the reviewer rather than in front of the owner.
      assigneeId: reviewerId,
    },
    ctx,
  );
  const dependent = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'subtask',
      title: DEPENDENT_TITLE,
      parentId: story.id,
      type: 'code',
      assigneeId: reviewerId,
    },
    ctx,
  );

  // The edge the whole story exists to move: the dependent card cannot start
  // until the design is settled. Same direction `relationshipToLink` produces
  // for the UI's `blocked_by` — `fromId` is the blocked card.
  await workItemsService.linkWorkItems(
    { fromId: dependent.id, toId: design.id, kind: 'is_blocked_by' },
    ctx,
  );

  // See the header: `in_progress → done` is a legal edge and `todo → done` is
  // not, so the design card has to be claimed before it can be approved.
  // `updateStatus`, never `applyStatusTransition` directly — the public entry
  // point is what wraps the funnel in `withWorkspaceContext`, and without those
  // GUCs every gate read inside it comes back empty under `motir_app`.
  await workItemsService.updateStatus(design.id, 'in_progress', ctx);

  // ⚠️ THE GRANT COMES FROM THE EXPORTED CONSTANT, never re-listed — so a green
  // run is evidence about the door a DISPATCHED run publishes through, and a
  // later narrowing of `CLI_TOKEN_GRANT` fails this journey rather than
  // silently un-shipping it.
  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'design-approval-e2e',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT],
  });

  return {
    workspaceId: workspace.id,
    projectKey: project.identifier,
    designKey: design.identifier,
    designTitle: DESIGN_TITLE,
    dependentKey: dependent.identifier,
    dependentTitle: DEPENDENT_TITLE,
    reviewerEmail: `da-reviewer-${slug}@example.com`,
    readerEmail: `da-reader-${slug}@example.com`,
    password: DESIGN_APPROVAL_PASSWORD,
    token: minted.token,
  };
}
