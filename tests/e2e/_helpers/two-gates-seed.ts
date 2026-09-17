import { adminDb } from '@/tests/helpers/adminDb';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestPerson } from './testPerson';
import { seedGithubInstallation } from './github-seed';
import { E2E_PROVISIONING_ORG } from './github-const';

// THE SEED FOR *ONE PRESS, TWO QUESTIONS* (Bug MOTIR-5652 · Subtask MOTIR-5669),
// for the acceptance receipt `acceptance-two-gates-one-approval.spec.ts` records.
//
// WHAT GOES THROUGH A SERVICE, AND WHAT IS LEFT TO THE SPEC:
//   * the people, workspace, project, membership and cards — their services;
//   * the GitHub installation and the repository — `seedGithubInstallation`, the
//     shipped `persistInstallation`, as every GitHub E2E seeds it;
//   * the design results, the pull requests, their links, their green checks and
//     every gate — NOT seeded. The spec publishes through the REAL MCP tool and
//     drives the REAL webhook and link doors, so the gates the walk decides are
//     the ones the product raised. That is the whole claim of this level: they
//     were not raised before.
//
// ⚠️ THE REPOSITORY BELONGS TO THE PROVISIONING ORG, and that is load-bearing —
// `approve-and-merge-seed.ts` records why: a merge mints its token with the App
// the repository's owner selects, and this lane configures only the provisioning
// App. A repository owned by the default E2E account would fail before it reached
// the merge seam.
//
// ⚠️ THE REVIEWER IS A PLAIN MEMBER, assignee of every card. The gate routes to
// `assigneeId ?? reporterId`, so this is what puts each question in front of them
// rather than in front of the owner — and what makes the *no verbs* arm of the
// frame mean something.

export const TWO_GATES_PASSWORD = 'two-gates-e2e-pass-1';

/** The one repository every card delivers into, on the shared E2E installation. */
export const DESIGN_REPO = {
  providerRepoId: '88015001',
  owner: E2E_PROVISIONING_ORG,
  name: 'twogates-web',
  defaultBranch: 'main',
  archived: false,
} as const;

export const TITLES = {
  onePress: 'Draw the approval frame',
  ejected: 'Draw the ejected state',
  withdrawn: 'Draw the empty queue',
  pulledBack: 'Draw the settings room',
  empty: 'Draw nothing yet',
} as const;

export interface SeededCard {
  id: string;
  identifier: string;
  title: string;
}

export interface TwoGatesSeed {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  reviewerEmail: string;
  password: string;
  /** A token holding EXACTLY `CLI_TOKEN_GRANT` — a dispatched run's own grant. */
  token: string;
  /** Publish → link → green → ONE press. */
  onePress: SeededCard;
  /** Approved, then ejected from the merge queue. */
  ejected: SeededCard;
  /** Its design result is WITHDRAWN. */
  withdrawn: SeededCard;
  /** Pulled back out of review. */
  pulledBack: SeededCard;
  /** Nothing published, nothing delivered — no question at all. */
  empty: SeededCard;
}

export async function seedTwoGates(slug: string): Promise<TwoGatesSeed> {
  const ownerEmail = `tg-owner-${slug}@example.com`;
  const reviewerEmail = `tg-reviewer-${slug}@example.com`;
  const owner = await createTestPerson({
    email: ownerEmail,
    password: TWO_GATES_PASSWORD,
    name: 'Olive Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Two Gates E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Two Gates',
    identifier: 'TWOG',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const reviewer = await createTestPerson({
    email: reviewerEmail,
    password: TWO_GATES_PASSWORD,
    name: 'Robin Vale',
  });
  await workspacesService.addMember({ userId: reviewer.id, workspaceId: workspace.id });
  await adminDb.projectMembership.create({
    data: { userId: reviewer.id, projectId: project.id, workspaceId: workspace.id, role: 'member' },
  });
  for (const userId of [owner.id, reviewer.id]) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  await seedGithubInstallation(workspace.id, [DESIGN_REPO]);

  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: 'The approval surfaces' },
    ctx,
  );

  /**
   * A design LEAF with something waiting on it — a design result publishes only
   * while an open work item is `blocked_by` the card (AMENDMENT 4 Q2), so the
   * dependent is what lets the publish through at all.
   */
  async function designCard(title: string, claim: boolean): Promise<SeededCard> {
    const card = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'subtask',
        title,
        parentId: story.id,
        type: 'design',
        assigneeId: reviewer.id,
      },
      ctx,
    );
    const dependent = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'subtask',
        title: `Build to ${title.toLowerCase()}`,
        parentId: story.id,
        type: 'code',
      },
      ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: dependent.id, toId: card.id, kind: 'is_blocked_by' },
      ctx,
    );
    // `todo → done` is not a legal edge, so a card that will be decided has to be
    // claimed first — the same reason `design-approval-seed.ts` records.
    if (claim) await workItemsService.updateStatus(card.id, 'in_progress', ctx);
    return { id: card.id, identifier: card.identifier, title };
  }

  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'two-gates-e2e',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT],
  });

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    reviewerEmail,
    password: TWO_GATES_PASSWORD,
    token: minted.token,
    onePress: await designCard(TITLES.onePress, true),
    ejected: await designCard(TITLES.ejected, true),
    withdrawn: await designCard(TITLES.withdrawn, true),
    pulledBack: await designCard(TITLES.pulledBack, true),
    empty: await designCard(TITLES.empty, true),
  };
}
