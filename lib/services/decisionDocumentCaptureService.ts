import type { DecisionDocOutcome } from '@/generated/prisma/client';
import {
  asksTheDecisionQuestion,
  classifyDecisionDocuments,
} from '@/lib/approvalGates/decisionDocument';
import { getGitProvider } from '@/lib/git';
import { listPullRequestFiles, type PullRequestFiles } from '@/lib/github/pullRequestFiles';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

// CAPTURE THE DECISION DOCUMENT AT THE HEAD (Story MOTIR-4907 · Subtask MOTIR-5674;
// ADR `docs/decisions/approval-gates.md` §8's FIFTH AMENDMENT, clause 7).
//
// ⚠️ WHY A CAPTURE AT ALL. `gateSetFor` reads every input on its caller's
// transaction and makes no network call, and it has to stay that way — a gate
// transaction that waited on GitHub would hold a card's row lock across a round
// trip. But which `docs/decisions/*.md` file a head carries is known only to the
// host. So the fact is read when the head is OBSERVED and written onto the
// pull-request mirror, and every later reader reads the mirror.
//
// ⚠️ NOT A DOCUMENT STORE. What is written is the file's IDENTITY — its path and
// git blob sha — never its text. Motir keeps no copy of any decision document
// (the requester decision the amendment records).
//
// THREE MOMENTS WRITE IT, and the third is the one that is easy to miss:
//
//   · `opened` / `reopened` — the pull request appears;
//   · `synchronize` — a new head, which may carry a different document;
//   · a LINK (`link_pull_request`, or the picker). A run links its pull request
//     seconds after opening it, so the `opened` delivery routinely arrives BEFORE
//     the link — when no decision card is delivered by it yet and there is
//     nothing to capture for. Without this arm the first push would be the first
//     capture, and a decision whose pull request is never pushed to again would
//     never be asked.
//
// ⚠️ BEST-EFFORT AND OUTSIDE EVERY TRANSACTION. The host read happens between two
// short transactions, never inside one. A failed read writes `unreadable` — which
// raises a gate that cannot be approved and holds the merge (clause 3) — and a
// failure of the capture ITSELF is swallowed: it runs after a webhook's status
// sync or a link has committed, and by `notes.html` #39 a side effect running
// after a durable write may never fail it.

/** What one capture did. `not_a_decision` and `gone` write nothing. */
export type DecisionDocCaptureResult =
  | { outcome: DecisionDocOutcome }
  | { outcome: 'not_a_decision' | 'gone' | 'failed' };

/** The provider this build can list a pull request's files on. */
const LISTABLE_PROVIDER = 'github';

/**
 * Capture what this pull request's HEAD carries under `docs/decisions/`, IF it
 * delivers a `decision` + `coding_agent` card. Every other pull request is left
 * untouched — a code card's pull request never gains these columns, and never
 * costs a host call.
 */
export async function captureDecisionDocument(
  pullRequestId: string,
): Promise<DecisionDocCaptureResult> {
  try {
    const target = await withSystemContext(async (tx) => {
      const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
      if (!pr) return null;
      // `work_item` has no system arm — bind the pull request's tenant before
      // reading the cards it delivers (MOTIR-2880).
      await bindWorkspaceContext(tx, pr.repo.workspaceId);
      const deliveries = await workItemDeliveryRepository.listByPullRequest(pr.id, tx);
      const items = await workItemRepository.findByIds(
        deliveries.map((row) => row.workItemId),
        tx,
      );
      return { pr, isDecision: items.some(asksTheDecisionQuestion) };
    });
    if (!target) return { outcome: 'gone' };
    if (!target.isDecision) return { outcome: 'not_a_decision' };

    const { pr } = target;
    const capture = classifyDecisionDocuments(await readHeadFiles(pr));

    await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, pr.repo.workspaceId);
      await githubPullRequestRepository.recordDecisionDocCapture(pr.id, capture, tx);
    });
    return { outcome: capture.outcome };
  } catch (err) {
    console.error(
      `[decisionDocumentCapture] could not capture the decision document for pull request ` +
        `${pullRequestId}; the delivery that triggered it stands:`,
      err,
    );
    return { outcome: 'failed' };
  }
}

/**
 * Read the head's file list, or `null` when it cannot be read — which the
 * classifier turns into `unreadable`, never into `none`.
 *
 * ⚠️ A NON-GITHUB PROVIDER IS `unreadable`, deliberately and on the record
 * (MOTIR-5674). The file-list leaf is GitHub's (`lib/github/pullRequestFiles.ts`)
 * and no GitLab merge-request equivalent exists in this build. Writing `none`
 * would tell a person *"this pull request has no decision"* about a merge request
 * Motir never looked at, and a gate that raised nothing would let it merge
 * unread. `unreadable` holds the merge and says why, which is the honest answer
 * until a GitLab read exists.
 */
async function readHeadFiles(pr: {
  provider: string;
  number: number;
  repo: { owner: string; name: string; installation: { installationId: string } };
}): Promise<PullRequestFiles | null> {
  if (pr.provider !== LISTABLE_PROVIDER) return null;
  try {
    const { token } = await getGitProvider(LISTABLE_PROVIDER).mintInstallationToken(
      pr.repo.installation.installationId,
    );
    return await listPullRequestFiles(token, pr.repo.owner, pr.repo.name, pr.number);
  } catch (err) {
    console.warn(
      `[decisionDocumentCapture] ${pr.repo.owner}/${pr.repo.name}#${pr.number}: the file ` +
        `list could not be read, so the decision document is recorded as unreadable`,
      { error: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }
}
