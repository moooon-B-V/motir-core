import { adminDb } from '@/tests/helpers/adminDb';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { workItemsService } from '@/lib/services/workItemsService';
import { seedApprovalsTab, type ApprovalsTabSeed } from './approvals-tab-seed';

// THE OVERLAY-VIDEO SEED (Bug MOTIR-6042), for `approval-overlay-video-fits.spec.ts`.
//
// It COMPOSES `approvals-tab-seed.ts` (the reviewer, the project) and adds the two
// shapes in which the approval overlay draws an acceptance recording:
//
//   · THE ACCEPTANCE PORT — a story with a recording and its `acceptance_result`
//     gate, nothing else asked: the overlay's `acceptance_result` arm puts the
//     player straight into the frame's port.
//   · THE STORY RUN — the same, PLUS an awaiting `pull_request_approval` gate over
//     the story's own pull request: the overlay reads the Development block, and the
//     recording LEADS it (`AcceptanceDevelopmentSlot`) with the pull request beneath.
//
// Rows, not the publish path: the claim is about the BOX the recording is drawn in,
// which the gate's kind and the evidence's attachment decide. The attachment is an
// empty `data:` URL exactly as `acceptance-gate-seed.ts`'s receipt is — the `<video>`
// needs a source to lay out, and this spec never plays one.

export const PORT_STORY_TITLE = 'Show the recording inside the viewport';
export const RUN_STORY_TITLE = 'Lead the story run with its recording';

export interface OverlayVideoSeed extends ApprovalsTabSeed {
  portKey: string;
  runKey: string;
}

export async function seedOverlayVideo(slug: string): Promise<OverlayVideoSeed> {
  const base = await seedApprovalsTab(slug);
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: base.workspaceId },
    select: { organizationId: true },
  });
  const owner = await adminDb.workspaceMembership.findFirstOrThrow({
    where: { workspaceId: base.workspaceId, role: 'owner' },
    select: { userId: true },
  });
  const ctx = { userId: owner.userId, workspaceId: base.workspaceId };

  async function storyWithRecording(title: string) {
    const story = await workItemsService.createWorkItem(
      { projectId: base.projectId, kind: 'story', title, assigneeId: base.reviewerId },
      ctx,
    );
    const attachment = await adminDb.attachment.create({
      data: {
        workspaceId: base.workspaceId,
        uploaderUserId: owner.userId,
        workItemId: story.id,
        source: 'acceptance_video',
        blobPathname: 'data:video/webm;base64,',
        mimeType: 'video/webm',
        sizeBytes: 1024,
        originalFilename: 'acceptance.webm',
      },
    });
    const evidence = await adminDb.acceptanceEvidence.create({
      data: {
        workspaceId: base.workspaceId,
        workItemId: story.id,
        attachmentId: attachment.id,
        chapters: [
          { label: 'Open the approval', tSeconds: 0 },
          { label: 'Watch the recording', tSeconds: 9 },
          { label: 'Decide on it', tSeconds: 21 },
        ],
        status: 'pending',
        commitSha: '6042aa11bb22',
        producedByKey: story.identifier,
        isCurrent: true,
      },
    });
    await adminDb.approvalGate.create({
      data: {
        workspaceId: base.workspaceId,
        projectId: base.projectId,
        workItemId: story.id,
        kind: 'acceptance_result',
        subjectId: evidence.id,
        routedToId: base.reviewerId,
      },
    });
    return story;
  }

  const portStory = await storyWithRecording(PORT_STORY_TITLE);
  const runStory = await storyWithRecording(RUN_STORY_TITLE);

  // The story run's own pull request, and the merge question over it.
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-overlay-video-${slug}`,
      workspaceId: base.workspaceId,
      organizationId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: base.workspaceId,
      organizationId,
      repoId: `6042-${slug}`,
      owner: 'acme',
      name: 'recordings-web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  await linkProjectRepo({
    workspaceId: base.workspaceId,
    projectId: base.projectId,
    githubRepoId: repo.id,
    name: 'recordings-web',
    role: 'web',
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      provider: 'github',
      repoId: repo.id,
      number: 60421,
      state: 'open',
      merged: false,
      headRef: `parent/${runStory.identifier}`,
      baseRef: 'main',
      title: RUN_STORY_TITLE,
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: base.workspaceId,
      workItemId: runStory.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
  await adminDb.approvalGate.create({
    data: {
      workspaceId: base.workspaceId,
      projectId: base.projectId,
      workItemId: runStory.id,
      kind: 'pull_request_approval',
      subjectId: runStory.id,
      routedToId: base.reviewerId,
    },
  });

  return { ...base, portKey: portStory.identifier, runKey: runStory.identifier };
}
