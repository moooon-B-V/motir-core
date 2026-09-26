import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestPerson } from './testPerson';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// THE DECISION-CONFIRM GATE E2E SEED (Story MOTIR-5871 · Subtask MOTIR-5964), for the
// acceptance receipt `acceptance-decision-confirm-gate.spec.ts` records.
//
// WHAT GOES THROUGH A SERVICE, AND WHAT IS LEFT TO THE SPEC. The people, the workspace,
// the project, the epic, its approved story and the decisions are created through their
// services — and that is ALSO what raises every gate: a `decision` · `human` work item
// whose body parses asks to be confirmed on create (MOTIR-5956), so no gate is written
// here. The ONE row written directly is the first decision's markdown attachment, the
// written record its Confirm stamps: an upload is not what this receipt is about. The
// spec drives every DECISION through the UI.

export const DECISION_GATE_PASSWORD = 'decision-gate-e2e-pass-5871';

export interface SeededDecision {
  id: string;
  identifier: string;
  title: string;
}

export interface DecisionConfirmGateSeed {
  ownerEmail: string;
  viewerEmail: string;
  password: string;
  workspaceId: string;
  projectId: string;
  ownerId: string;
  epic: SeededDecision;
  /** The approved story every decision supersedes. */
  story: SeededDecision;
  /** Confirmed, with a markdown attachment as its written record. */
  recorded: SeededDecision;
  recordFilename: string;
  /** Overturned, with a note. */
  overturned: SeededDecision;
  /** Confirmed, with no written record. */
  bare: SeededDecision;
  /** A body with no `## Resulting direction` — no gate. */
  defect: SeededDecision;
  /** Still awaiting the owner when a member who may not decide opens it. */
  watched: SeededDecision;
}

/** A canonical decision body, as the planner's re-plan carve-out writes it. */
export function decisionBody(input: {
  decision: string;
  change: 'workflow' | 'more requirement' | 'less requirement';
  before: string;
  supersedes: string[];
  direction: string | null;
}): string {
  return [
    '## Decision',
    input.decision,
    '',
    '## What changed',
    `**Change:** ${input.change}`,
    input.before,
    '',
    '## Supersedes',
    ...input.supersedes.map((key) => `- ${key}`),
    ...(input.direction ? ['', '## Resulting direction', input.direction] : []),
  ].join('\n');
}

export async function seedDecisionConfirmGate(slug: string): Promise<DecisionConfirmGateSeed> {
  const ownerEmail = `decision-owner-${slug}@example.com`;
  const viewerEmail = `decision-viewer-${slug}@example.com`;
  const owner = await createTestPerson({
    email: ownerEmail,
    password: DECISION_GATE_PASSWORD,
    name: 'Yue Owner',
  });
  const viewer = await createTestPerson({
    email: viewerEmail,
    password: DECISION_GATE_PASSWORD,
    name: 'Vic Viewer',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Decision gate E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Exports',
    identifier: 'DECS',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  // A member who may browse and edit the project, and is neither the assignee, the
  // reporter nor an admin — so a decision routed to the owner is NOT theirs to confirm.
  await workspacesService.addMember({ userId: viewer.id, workspaceId: workspace.id });
  const ctx = { userId: owner.id, workspaceId: workspace.id };
  await addToProjectAs({
    key: project.identifier,
    actorUserId: owner.id,
    ctx,
    targetUserId: viewer.id,
    role: 'member',
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: viewer.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  const epic = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'epic', title: 'Report exports' },
    ctx,
  );
  // The already-approved work a re-plan changed.
  const story = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'story',
      parentId: epic.id,
      title: 'Keep every export in a Postgres table',
    },
    ctx,
  );

  const decision = async (title: string, descriptionMd: string): Promise<SeededDecision> => {
    const item = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'task',
        parentId: epic.id,
        title,
        type: 'decision',
        executor: 'human',
        assigneeId: owner.id,
        descriptionMd,
      },
      ctx,
    );
    return { id: item.id, identifier: item.identifier, title };
  };

  const recorded = await decision(
    'Exports move to managed object storage',
    decisionBody({
      decision: 'Exported reports are written to managed object storage, not to Postgres.',
      change: 'workflow',
      before: 'The approved plan wrote every export into a Postgres table.',
      supersedes: [story.identifier],
      direction:
        'Every export is written to the bucket; Postgres keeps only the export’s metadata and its signed link.',
    }),
  );
  const recordFilename = 'exports-storage-decision.md';
  await adminDb.attachment.create({
    data: {
      workspaceId: workspace.id,
      uploaderUserId: owner.id,
      workItemId: recorded.id,
      source: 'panel',
      blobPathname: `attachments/${slug}/${recordFilename}`,
      mimeType: 'text/markdown',
      sizeBytes: 2048,
      originalFilename: recordFilename,
    },
  });

  return {
    ownerEmail,
    viewerEmail,
    password: DECISION_GATE_PASSWORD,
    workspaceId: workspace.id,
    projectId: project.id,
    ownerId: owner.id,
    epic: { id: epic.id, identifier: epic.identifier, title: 'Report exports' },
    story: { id: story.id, identifier: story.identifier, title: story.title },
    recorded,
    recordFilename,
    overturned: await decision(
      'Drop the in-app export history',
      decisionBody({
        decision: 'The export history page is dropped; a customer re-runs an export instead.',
        change: 'less requirement',
        before: 'The approved plan kept a browsable history of every export.',
        supersedes: [story.identifier],
        direction: 'Exports are fire-and-forget; nothing lists past exports.',
      }),
    ),
    bare: await decision(
      'Exports are CSV only',
      decisionBody({
        decision: 'Exports are produced as CSV; PDF is not offered.',
        change: 'less requirement',
        before: 'The approved plan offered both CSV and PDF.',
        supersedes: [story.identifier],
        direction: 'One format, CSV, for every export.',
      }),
    ),
    defect: await decision(
      'Exports expire after thirty days',
      decisionBody({
        decision: 'An export’s signed link expires thirty days after it is made.',
        change: 'more requirement',
        before: 'The approved plan kept links forever.',
        supersedes: [story.identifier],
        direction: null,
      }),
    ),
    watched: await decision(
      'Exports are generated overnight',
      decisionBody({
        decision: 'Exports are generated in a nightly batch, not on request.',
        change: 'workflow',
        before: 'The approved plan generated each export the moment it was asked for.',
        supersedes: [story.identifier],
        direction: 'A requested export arrives by the next morning.',
      }),
    ),
  };
}
