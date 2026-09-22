import { adminDb } from '@/tests/helpers/adminDb';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { seedApprovalsTab, type ApprovalsTabSeed } from './approvals-tab-seed';
import { choiceBody } from './choice-gate-seed';
import { decisionBody } from './decision-confirm-gate-seed';

// THE PLAIN-WORDS SEED (Story MOTIR-5996 · Subtask MOTIR-6003), for the receipt
// `acceptance-plain-words-approvals.spec.ts` records.
//
// It COMPOSES `approvals-tab-seed.ts` (the reviewer, the project, the design card
// whose result the spec publishes for real) and adds the rest of a reviewer's
// thirty-approval morning, one kind at a time:
//
//   · ONE design result — NOT seeded. The spec publishes it over `/api/mcp`, so the
//     row a viewer watches open is a gate the product raised.
//   · ONE acceptance video — an `acceptance_evidence` row and its gate, written
//     directly. Publishing a real clip needs an upload and a story with an E2E card;
//     the claim here is the SENTENCE the row reads, which the kind decides.
//   · ONE approve-to-merge — a card delivering two open pull requests in two
//     repositories, and its gate over the set. The pull requests are rows, not a
//     webhook's work: what the spec asserts is that the row says "is finished" and
//     keeps `owner/name · #n` in its hover title, not how the set went green.
//   · FOURTEEN choices and THIRTEEN decisions to confirm — real `choice` and
//     `decision` work items, whose gates `createWorkItem` raises itself from a
//     complete body. They make the queue thirty, and every one of them resolves, so
//     the video shows a list of real questions rather than a wall of "Gone".
//   · ONE work item the reviewer may NOT see — a gate routed to them in a PRIVATE
//     project they are not a member of. The list never shows it; a pasted `?peek=`
//     for its key opens the quick view's not-available panel.
//
// ⚠️ Titles are deliberately NOT substrings of one another: `getByRole` matches an
// accessible name by substring, so an overlap dies on strict mode instead of on
// anything this story is about.

export const ACCEPTANCE_TITLE = 'Send the billing export every night';
export const FINISHED_TITLE = 'Retry a failed webhook delivery';
export const HIDDEN_TITLE = 'Rotate the vault signing keys';

/** The two repositories the finished card delivers into, and their numbers — in the
 *  set's canonical order (`owner/name` ascending), which is the order a row lists them. */
export const FINISHED_PRS = [
  { name: 'hooks-api', number: 71 },
  { name: 'hooks-web', number: 72 },
] as const;
export const REPO_OWNER = 'acme';

export const CHOICE_COUNT = 14;
export const DECISION_COUNT = 13;

export interface PlainWordsSeed extends ApprovalsTabSeed {
  acceptanceKey: string;
  finishedKey: string;
  /** The oldest choice — the Approvals room's first row, which lists oldest first. */
  firstChoiceKey: string;
  firstChoiceTitle: string;
  /** The key of the work item the reviewer cannot see. */
  hiddenKey: string;
}

export async function seedPlainWordsApprovals(slug: string): Promise<PlainWordsSeed> {
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

  const story = await adminDb.workItem.findFirstOrThrow({
    where: { projectId: base.projectId, kind: 'story' },
    select: { id: true, identifier: true },
  });

  async function routedGate(args: {
    projectId: string;
    workItemId: string;
    kind: 'acceptance_result' | 'pull_request_approval' | 'design_result';
    subjectId: string;
    offsetSeconds: number;
  }): Promise<void> {
    await adminDb.approvalGate.create({
      data: {
        workspaceId: base.workspaceId,
        projectId: args.projectId,
        workItemId: args.workItemId,
        kind: args.kind,
        subjectId: args.subjectId,
        routedToId: base.reviewerId,
        // Behind the published design, so it stays the list's first row.
        createdAt: new Date(Date.now() + args.offsetSeconds * 1000),
      },
    });
  }

  // ── The acceptance video ────────────────────────────────────────────────────
  const acceptanceStory = await workItemsService.createWorkItem(
    {
      projectId: base.projectId,
      kind: 'story',
      title: ACCEPTANCE_TITLE,
      assigneeId: base.reviewerId,
    },
    ctx,
  );
  const evidence = await adminDb.acceptanceEvidence.create({
    data: {
      workspaceId: base.workspaceId,
      workItemId: acceptanceStory.id,
      chapters: [
        { label: 'The export is scheduled', tSeconds: 0 },
        { label: 'It runs at night', tSeconds: 12 },
        { label: 'The file arrives', tSeconds: 25 },
      ],
      commitSha: '4c1e9a0b7d2f',
      producedByKey: acceptanceStory.identifier,
    },
  });
  await routedGate({
    projectId: base.projectId,
    workItemId: acceptanceStory.id,
    kind: 'acceptance_result',
    subjectId: evidence.id,
    offsetSeconds: 1,
  });

  // ── The approve-to-merge set ────────────────────────────────────────────────
  const finished = await workItemsService.createWorkItem(
    {
      projectId: base.projectId,
      kind: 'subtask',
      parentId: story.id,
      title: FINISHED_TITLE,
      type: 'code',
      assigneeId: base.reviewerId,
    },
    ctx,
  );
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-plain-${slug}`,
      workspaceId: base.workspaceId,
      organizationId,
      accountLogin: REPO_OWNER,
      accountType: 'Organization',
      provider: 'github',
    },
  });
  for (const [i, pr] of FINISHED_PRS.entries()) {
    const repo = await adminDb.githubRepo.create({
      data: {
        installationId: installation.id,
        workspaceId: base.workspaceId,
        organizationId,
        repoId: `5996${i}`,
        owner: REPO_OWNER,
        name: pr.name,
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    await linkProjectRepo({
      workspaceId: base.workspaceId,
      projectId: base.projectId,
      githubRepoId: repo.id,
      name: pr.name,
      role: pr.name === 'hooks-web' ? 'web' : 'api',
    });
    const row = await adminDb.githubPullRequest.create({
      data: {
        provider: 'github',
        repoId: repo.id,
        number: pr.number,
        state: 'open',
        merged: false,
        headRef: `parent/${finished.identifier}`,
        baseRef: 'main',
        title: FINISHED_TITLE,
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: base.workspaceId,
        workItemId: finished.id,
        githubPullRequestId: row.id,
        repoId: repo.id,
      },
    });
  }
  // The kind's subject IS the card: its delivery set is what the row summarises.
  await routedGate({
    projectId: base.projectId,
    workItemId: finished.id,
    kind: 'pull_request_approval',
    subjectId: finished.id,
    offsetSeconds: 2,
  });

  // ── The choices and the decisions — gates the product raises itself ────────
  const QUESTIONS = [
    'where exported reports live',
    'how a customer receives an export',
    'the export file format',
    'how long exports are kept',
    'the export naming scheme',
    'who may download an export',
    'the export time zone',
    'the retry policy for a failed export',
    'what an empty export contains',
    'the export column order',
    'how an export is announced',
    'the export size limit',
    'how a cancelled export is shown',
    'what a partial export keeps',
  ];
  const choices: Array<{ identifier: string; title: string }> = [];
  for (let i = 0; i < CHOICE_COUNT; i += 1) {
    const topic = QUESTIONS[i]!;
    const choice = await workItemsService.createWorkItem(
      {
        projectId: base.projectId,
        kind: 'task',
        title: `Choose ${topic}`,
        type: 'choice',
        executor: 'human',
        assigneeId: base.reviewerId,
        descriptionMd: choiceBody({
          question: `What should we do about ${topic}?`,
          situation: 'two workflows',
          evidence: 'Both ways are reasonable, and they lead to different work.',
          options: [
            {
              label: 'Keep it simple',
              bestFor: 'one path for everyone',
              why: 'Nothing to configure.',
            },
            {
              label: 'Make it configurable',
              bestFor: 'each customer to pick',
              why: 'More to build, more to explain.',
            },
          ],
          gates: 'The report exports story.',
        }),
      },
      ctx,
    );
    choices.push({ identifier: choice.identifier, title: choice.title });
  }
  for (let i = 0; i < DECISION_COUNT; i += 1) {
    const topic = QUESTIONS[i]!;
    await workItemsService.createWorkItem(
      {
        projectId: base.projectId,
        kind: 'task',
        title: `Settle ${topic}`,
        type: 'decision',
        executor: 'human',
        assigneeId: base.reviewerId,
        descriptionMd: decisionBody({
          decision: `We settled ${topic}.`,
          change: 'workflow',
          before: `The approved plan left ${topic} open.`,
          supersedes: [story.identifier],
          direction: `Build ${topic} the settled way.`,
        }),
      },
      ctx,
    );
  }

  // ── The work item the reviewer cannot see ───────────────────────────────────
  const vault = await projectsService.createProject({
    name: 'Vault',
    identifier: 'VAULT',
    workspaceId: base.workspaceId,
    actorUserId: owner.userId,
  });
  const hidden = await workItemsService.createWorkItem(
    { projectId: vault.id, kind: 'task', title: HIDDEN_TITLE, type: 'design' },
    ctx,
  );
  await projectMembersService.setAccessLevel({
    key: vault.identifier,
    actorUserId: owner.userId,
    ctx,
    level: 'private',
  });
  // `addMember` enrolled the reviewer in every project that existed then; this one
  // is newer, but the delete makes "not a member" true whichever order ran.
  await adminDb.projectMembership.deleteMany({
    where: { userId: base.reviewerId, projectId: vault.id },
  });
  await adminDb.workItem.update({
    where: { id: hidden.id },
    data: { assigneeId: base.reviewerId },
  });
  await routedGate({
    projectId: vault.id,
    workItemId: hidden.id,
    kind: 'design_result',
    subjectId: `hidden-evidence-${hidden.id}`,
    offsetSeconds: 3,
  });

  return {
    ...base,
    acceptanceKey: acceptanceStory.identifier,
    finishedKey: finished.identifier,
    firstChoiceKey: choices[0]!.identifier,
    firstChoiceTitle: choices[0]!.title,
    hiddenKey: hidden.identifier,
  };
}
