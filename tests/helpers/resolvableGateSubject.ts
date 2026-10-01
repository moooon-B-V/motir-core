import type { ApprovalGateKind, GithubRepo } from '@/generated/prisma/client';
import type { WorkItemFixture } from '../fixtures';
import { adminDb } from './adminDb';
import { connectRepairRepo, deliveredPr } from './repairFixtures';

// A GATE SUBJECT THAT RESOLVES, for a fixture that raises gates straight through the
// repository (Bug MOTIR-7146).
//
// A read that lists an `awaiting` gate whose subject no longer resolves WITHDRAWS it
// (superseded `subject_gone`), so a fixture that hands a gate a made-up `subjectId` —
// harmless for as long as a gone subject merely rendered a *Gone* row — now takes that
// gate out of the very list it was raised to be in. This writes the smallest real
// subject each kind's handler resolves:
//
//   · `design_result` / `acceptance_result` — an evidence row, NOT current, so a test
//     that publishes the card's own current evidence never collides with it;
//   · `pull_request_approval` / `agent_review` — one open pull request delivering the
//     card, in a repository connected once per workspace; the subject is the card;
//   · `decision_approval` — the same pull request, carrying ONE captured decision
//     document; the subject is the card;
//   · `decision_choice` / `decision_confirmation` — the card itself, re-typed as a
//     `human` choice or decision and given a body that parses as one;
//   · every other kind — the card itself (a plan's resolution is the test's own).

const CHOICE_BODY = [
  '## Question',
  'Where do exported reports live?',
  '## Why this is a choice',
  '**Situation:** two workflows',
  'The requirement names a download and a shared link.',
  '## Options',
  '### Managed object storage',
  '**Best if you want:** less to operate',
  'The provider runs it.',
  '### Our own Postgres',
  '**Best if you want:** more cost-effective',
  'No new vendor.',
  '## What this choice gates',
  'The export story.',
].join('\n');

const DECISION_BODY = [
  '## Decision',
  'Exports move to managed object storage.',
  '## What changed',
  '**Change:** less requirement',
  'Before and after.',
  '## Supersedes',
  'MOTIR-6 and MOTIR-7',
  '## Resulting direction',
  'Every export is written to the bucket.',
].join('\n');

const repos = new Map<string, GithubRepo>();

let branch = 0;

export async function resolvableGateSubject(
  fx: Pick<WorkItemFixture, 'workspaceId' | 'projectId'>,
  workItemId: string,
  kind: ApprovalGateKind,
): Promise<string> {
  if (kind === 'design_result') {
    return (
      await adminDb.designEvidence.create({
        data: { workspaceId: fx.workspaceId, workItemId, isCurrent: false },
      })
    ).id;
  }
  if (kind === 'acceptance_result') {
    return (
      await adminDb.acceptanceEvidence.create({
        data: { workspaceId: fx.workspaceId, workItemId, isCurrent: false },
      })
    ).id;
  }
  if (kind === 'pull_request_approval' || kind === 'agent_review' || kind === 'decision_approval') {
    const already = await adminDb.workItemDelivery.count({ where: { workItemId } });
    if (already === 0) {
      let repo = repos.get(fx.workspaceId);
      if (!repo || !(await adminDb.githubRepo.findUnique({ where: { id: repo.id } }))) {
        repo = await connectRepairRepo(fx as WorkItemFixture, `subject-repo-${repos.size + 1}`);
        repos.set(fx.workspaceId, repo);
      }
      branch += 1;
      await deliveredPr(fx as WorkItemFixture, workItemId, repo, {
        headRef: `subject/${branch}`,
      });
    }
    if (kind === 'decision_approval') {
      const deliveries = await adminDb.workItemDelivery.findMany({ where: { workItemId } });
      await adminDb.githubPullRequest.updateMany({
        where: { id: { in: deliveries.map((d) => d.githubPullRequestId) } },
        data: {
          decisionDocOutcome: 'one',
          decisionDocPath: 'docs/decisions/the-decision.md',
          decisionDocBlobSha: 'd'.repeat(40),
          decisionDocHeadSha: 'c'.repeat(40),
          decisionDocPaths: ['docs/decisions/the-decision.md'],
        },
      });
    }
    return workItemId;
  }
  if (kind === 'decision_choice' || kind === 'decision_confirmation') {
    await adminDb.workItem.update({
      where: { id: workItemId },
      data:
        kind === 'decision_choice'
          ? { type: 'choice', executor: 'human', descriptionMd: CHOICE_BODY }
          : { type: 'decision', executor: 'human', descriptionMd: DECISION_BODY },
    });
  }
  return workItemId;
}
