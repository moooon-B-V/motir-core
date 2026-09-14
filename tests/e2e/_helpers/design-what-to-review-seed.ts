import { adminDb } from '@/tests/helpers/adminDb';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { createTestPerson } from './testPerson';

// WHAT TO REVIEW — the seed for Story MOTIR-5488's acceptance walk (MOTIR-5500).
//
// ⚠️ THE PUBLISHES ARE NOT SEEDED. Every current-format result in the walk is put
// on its card by the REAL `publish_design_result` tool over `/api/mcp`, with a
// token holding exactly `CLI_TOKEN_GRANT` — the door a dispatched run comes
// through. What this file plants is only what a publish needs, plus the two
// things a publish can no longer produce:
//
//   · an EARLIER-FORMAT result (inline note + screenshots), written as rows,
//     because AMENDMENT 4 refuses both on the way in — which is the point;
//   · the pull requests of the design card that has them, written as delivery
//     rows the way the installation webhook and a run's `link_pull_request`
//     leave them (`how-to-test-seed.ts` is the precedent).
//
// Every `blocked_by` edge goes through `workItemsService.linkWorkItems`, the real
// link write, so readiness and the publish gate read the edge the product wrote.

export const WHAT_TO_REVIEW_PASSWORD = 'what-to-review-e2e-pass-3';

// ⚠️ Deliberately NOT substrings of one another: `getByRole` matches an accessible
// name by SUBSTRING, and an overlap dies on strict mode rather than on anything real.
export const TITLES = {
  story: 'Review a design by looking at it',
  design: 'Draw the readiness chip for a blocked row',
  dependent: 'Wire the chip into the board columns',
  lonely: 'Tidy the spacing of the sprint header',
  older: 'Sketch the legacy import dialog',
  withPrs: 'Redraw the repository picker',
  withPrsDependent: 'Build the repository picker',
  empty: 'Outline the calendar week strip',
} as const;

export const HOW_TO_TEST_BODY = [
  '## Precondition',
  '',
  'Sign in as the reviewer.',
  '',
  '## Click-path',
  '',
  '1. Open the repository picker from a card.',
].join('\n');

export interface WhatToReviewSeed {
  password: string;
  reviewerEmail: string;
  token: string;
  designKey: string;
  dependentKey: string;
  lonelyKey: string;
  olderKey: string;
  withPrsKey: string;
  emptyKey: string;
  prTitles: [string, string];
}

export async function seedWhatToReview(slug: string): Promise<WhatToReviewSeed> {
  const owner = await createTestPerson({
    email: `wtr-owner-${slug}@example.com`,
    password: WHAT_TO_REVIEW_PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'What To Review E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Review',
    identifier: 'WTR',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspace.id },
    select: { organizationId: true },
  });

  const pin = (userId: string) =>
    adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });

  // A plain project MEMBER who is the design card's ASSIGNEE — the gate routes to
  // them and they may decide it, without the workspace-manager arm doing the work
  // (`design-approval-seed.ts` explains why the owner would prove nothing).
  const reviewerEmail = `wtr-reviewer-${slug}@example.com`;
  const reviewer = await createTestPerson({
    email: reviewerEmail,
    password: WHAT_TO_REVIEW_PASSWORD,
    name: 'Robin Vale',
  });
  await workspacesService.addMember({ userId: reviewer.id, workspaceId: workspace.id });
  await adminDb.projectMembership.create({
    data: { userId: reviewer.id, projectId: project.id, workspaceId: workspace.id, role: 'member' },
  });
  await pin(reviewer.id);
  await pin(owner.id);

  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: TITLES.story },
    ctx,
  );
  const subtask = (title: string, type: 'design' | 'code', assigneeId?: string) =>
    workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'subtask',
        title,
        parentId: story.id,
        type,
        ...(assigneeId ? { assigneeId } : {}),
      },
      ctx,
    );
  const blockedBy = (fromId: string, toId: string) =>
    workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, ctx);

  // 1–4 · the card the happy path publishes onto, and the work waiting on it.
  const design = await subtask(TITLES.design, 'design', reviewer.id);
  const dependent = await subtask(TITLES.dependent, 'code', reviewer.id);
  await blockedBy(dependent.id, design.id);
  // `in_progress → done` is a legal edge and `todo → done` is not.
  await workItemsService.updateStatus(design.id, 'in_progress', ctx);

  // 6 · a design nothing is `blocked_by`.
  const lonely = await subtask(TITLES.lonely, 'design');

  // 7 · an earlier-format result — the rows a pre-AMENDMENT-4 publish left.
  const older = await subtask(TITLES.older, 'design');
  const evidence = await adminDb.designEvidence.create({
    data: {
      workspaceId: workspace.id,
      workItemId: older.id,
      noteMd: '## Import dialog\n\nThe note as it used to be stored, inline.\n',
      commitSha: 'b01d5e7',
      producedByKey: older.identifier,
      isCurrent: true,
    },
  });
  const olderAssets = [
    { kind: 'mock' as const, name: 'import.mock.html', type: 'text/html' },
    { kind: 'image' as const, name: 'import.png', type: 'image/png' },
    { kind: 'image' as const, name: 'import.dark.png', type: 'image/png' },
    { kind: 'note_file' as const, name: 'design-notes.md', type: 'text/markdown' },
  ];
  for (const [position, asset] of olderAssets.entries()) {
    const attachment = await adminDb.attachment.create({
      data: {
        workspaceId: workspace.id,
        uploaderUserId: owner.id,
        workItemId: older.id,
        source: 'design_asset',
        blobPathname: `design/${workspace.id}/${older.id}/${asset.name}`,
        mimeType: asset.type,
        sizeBytes: 2048,
        originalFilename: asset.name,
      },
    });
    await adminDb.designAsset.create({
      data: {
        workspaceId: workspace.id,
        designEvidenceId: evidence.id,
        kind: asset.kind,
        attachmentId: attachment.id,
        sourcePath: `design/imports/${asset.name}`,
        position,
      },
    });
  }

  // 8 · a design card with TWO open pull requests in two repositories, and work
  // waiting on it.
  const withPrs = await subtask(TITLES.withPrs, 'design', reviewer.id);
  const withPrsDependent = await subtask(TITLES.withPrsDependent, 'code');
  await blockedBy(withPrsDependent.id, withPrs.id);
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-wtr-${slug}`,
      workspaceId: workspace.id,
      organizationId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const prTitles: [string, string] = [
    'Repository picker — web half',
    'Repository picker — api half',
  ];
  const repos: Array<{ id: string }> = [];
  for (const [i, name] of ['web', 'api'].entries()) {
    const repo = await adminDb.githubRepo.create({
      data: {
        installationId: installation.id,
        workspaceId: workspace.id,
        organizationId,
        repoId: `5500${i}`,
        owner: 'acme',
        name,
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    await linkProjectRepo({
      workspaceId: workspace.id,
      projectId: project.id,
      githubRepoId: repo.id,
      name,
      role: name === 'web' ? 'web' : 'api',
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        provider: 'github',
        repoId: repo.id,
        number: 71 + i,
        state: 'open',
        merged: false,
        headRef: `design/${withPrs.identifier}`,
        baseRef: 'main',
        title: prTitles[i]!,
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: workspace.id,
        workItemId: withPrs.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });
    repos.push(repo);
  }
  await testInstructionsService.publish(
    {
      workItemId: withPrs.id,
      bodyMd: HOW_TO_TEST_BODY,
      previewPath: `/items/${withPrs.identifier}`,
      repos: repos.map((repo, i) => ({ repoId: repo.id, commitSha: `${i + 1}a`.repeat(20) })),
    },
    ctx,
  );

  // The empty state.
  const empty = await subtask(TITLES.empty, 'design');

  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'what-to-review-e2e',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT],
  });

  return {
    password: WHAT_TO_REVIEW_PASSWORD,
    reviewerEmail,
    token: minted.token,
    designKey: design.identifier,
    dependentKey: dependent.identifier,
    lonelyKey: lonely.identifier,
    olderKey: older.identifier,
    withPrsKey: withPrs.identifier,
    emptyKey: empty.identifier,
    prTitles,
  };
}
