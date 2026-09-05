import type { GithubInstallation, GithubRepo, Prisma } from '@/generated/prisma/client';
import {
  LINK_CHECK_NAME,
  readPullRequestHeadSha,
  writeCheckRun,
  type CheckRunWriteOutcome,
} from '@/lib/github/checkRuns';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

// THE UNLINKED-PULL-REQUEST CHECK (Story MOTIR-3672 · MOTIR-3675) — the
// enforcement that makes the explicit link real.
//
// MOTIR-3674 retired the title/branch parse, so a pull request nobody linked
// associates with no card at all. That trades a WRONG link for a MISSING one,
// which is quieter and therefore worse: a card whose pull request merged and
// which nobody moved looks exactly like a card whose work never started. This is
// what makes the absence loud, on the pull request, while somebody can still act
// on it.
//
// The mechanism, the exemptions and the loudness were all decided in
// `docs/decisions/unlinked-pull-request-check.md` and are QUOTED here rather than
// re-derived — this module builds what that ADR chose and nothing else:
//
//   * WHAT WRITES IT — Motir, a check run on the delivery it already receives
//     (option A). Option B, a workflow job per repository, was rejected because it
//     reaches only repositories that add the job, which is exactly the population
//     the parse was kept for.
//   * HOW LOUD — `conclusion: failure`, a genuine red. Whether that BLOCKS is the
//     repository's own branch-protection setting and never Motir's, which is what
//     lets the check be honest without wedging anyone.
//   * THE HATCH — link the pull request (one call, and the check goes green on
//     that write, not on the next push), or the `no-work-item` label for a pull
//     request that genuinely delivers no card. Anyone who can push may use it.
//
// ⚠️ IT IS BEST-EFFORT, ALWAYS. Every caller is either a webhook delivery or an
// MCP write; neither may fail because a check could not be written. The App may
// not hold `checks: write` on this installation yet (the permission is an
// ADDITION and an installation keeps its old set until an admin approves), the
// host may be unreachable, the repository may have been disconnected mid-flight.
// All of those return an outcome; none throws.

/** Why the check did or did not end up on a pull request. Every arm is a normal
 *  answer — this function has no error case. */
export type LinkCheckOutcome =
  | { decision: 'unlinked'; write: CheckRunWriteOutcome }
  | { decision: 'linked'; write: CheckRunWriteOutcome }
  | { decision: 'exempt'; reason: LinkCheckExemption }
  | { decision: 'skipped'; reason: 'unknown_repo' | 'no_head_sha' };

/** The exemptions the ADR states as RULES rather than as a list of today's bots. */
export type LinkCheckExemption = 'bot_author' | 'repo_not_planned' | 'draft' | 'labelled';

/** The label that says *this pull request delivers no card, deliberately*. A
 *  LABEL rather than a title token, because this story is retiring the title as a
 *  carrier of machine-read meaning and reintroducing one here would be the same
 *  mistake wearing a different name. */
export const NO_WORK_ITEM_LABEL = 'no-work-item';

/** What the caller knows about the pull request. A webhook delivery has all of
 *  it; `link_pull_request` has the coordinates and looks the rest up. */
export interface LinkCheckSubject {
  repoRow: GithubRepo & { installation: GithubInstallation };
  number: number;
  /** The commit the check attaches to. Null when the caller does not have one —
   *  a link written before any delivery arrived — and it is then read back from
   *  the host. */
  headSha: string | null;
  /** GitHub's `pull_request.user.type`. `"Bot"` is the exemption; null when the
   *  caller has no payload to read it from, which is never a bot. */
  authorType?: string | null;
  draft?: boolean;
  labels?: string[];
  /** The head ref and title, used ONLY to write a helpful hint into the failure
   *  text (see `hintKey`). Never to resolve anything. */
  headRef?: string | null;
  title?: string | null;
}

/**
 * The one legitimate surviving use of reading a key out of a branch or a title.
 *
 * ⚠️ This is NOT the parse coming back, and the difference is the whole point:
 * the parse RESOLVED an association from text and acted on it. This produces a
 * sentence for a person to read — *"this looks like MOTIR-42; if that is right,
 * link it"* — and nothing in the product consumes the answer. A wrong guess costs
 * a reader one glance; a wrong link closed the wrong card.
 *
 * Deliberately unvalidated against the database for the same reason: it is a
 * hint, and a hint that took a query would be an association.
 */
function hintKey(subject: LinkCheckSubject): string | null {
  const text = `${subject.headRef ?? ''} ${subject.title ?? ''}`;
  const match = /\b([A-Za-z][A-Za-z0-9]*)-(\d+)\b/.exec(text);
  return match ? `${match[1]!.toUpperCase()}-${match[2]}` : null;
}

/** The failure body. The card's *"the message is the feature"*: somebody meets
 *  this having never read a runbook, so it says what is wrong, the exact call
 *  that fixes it, and the way out if the pull request really delivers nothing. */
function failureSummary(subject: LinkCheckSubject): string {
  const hint = hintKey(subject);
  const lines = [
    'This pull request is not linked to a Motir work item, so merging it will not',
    'move any card. Motir does not guess from the branch name or the title — an',
    'explicit link is the only association a pull request has.',
    '',
    '**To fix it**, call the `link_pull_request` MCP tool with the work item key and',
    'this pull request:',
    '',
    '```',
    `link_pull_request(key: "${hint ?? 'MOTIR-123'}", repository: "${subject.repoRow.owner}/${subject.repoRow.name}", number: ${subject.number}, headRef: "…", baseRef: "…")`,
    '```',
    '',
    'or use **+ Link pull request** on the work item page. The check turns green on',
    'that write — you do not need to push again.',
    '',
    `**If this pull request genuinely delivers no work item**, add the \`${NO_WORK_ITEM_LABEL}\` label`,
    'and the check will clear. Anyone who can push to this repository may do that.',
  ];
  if (hint) {
    lines.splice(
      3,
      0,
      '',
      `Its branch or title mentions \`${hint}\` — if that is the card it delivers, that is`,
      'the key to use. Motir has not checked whether that key exists; it is a hint, not',
      'a link.',
    );
  }
  return lines.join('\n');
}

function successSummary(): string {
  return [
    'This pull request is linked to a Motir work item, so its merge will move the',
    'card it delivers.',
  ].join('\n');
}

/**
 * Decide and write the link check for one pull request. Never throws.
 *
 * The exemptions are evaluated BEFORE the link is looked up, deliberately: a
 * repository nobody plans work in must not have a database read performed on its
 * behalf, let alone a check written onto it.
 */
export async function evaluateLinkCheck(subject: LinkCheckSubject): Promise<LinkCheckOutcome> {
  // 1. A BOT-authored pull request is out of scope. Stated as a property of the
  //    author, not as a list of bot names: Dependabot and renovate today, and
  //    whatever anybody installs tomorrow, without this rule changing.
  if (subject.authorType === 'Bot') return { decision: 'exempt', reason: 'bot_author' };

  // 2. A DRAFT is a work-in-progress by declaration. The check appears when it is
  //    marked ready for review.
  if (subject.draft === true) return { decision: 'exempt', reason: 'draft' };

  // 3. The declared escape hatch.
  if ((subject.labels ?? []).some((l) => l.toLowerCase() === NO_WORK_ITEM_LABEL))
    return { decision: 'exempt', reason: 'labelled' };

  // ⚠️ BIND THE TENANT — the system flag alone reads NOTHING here (MOTIR-2880's
  // shape, one service over). `project_repository` and `work_item_delivery` are
  // both `FORCE ROW LEVEL SECURITY` with a single arm — `workspace_id =
  // current_setting('app.workspace_id')` — and NO `system_admin` arm at all. So
  // under `motir_app` an unbound read returns zero rows and NO error, which here
  // would read as "this repository is not planned" for every repository in the
  // product and silently disable the whole check. The repo row carries the
  // tenancy (MOTIR-1931) and the caller already resolved it, so the bind goes at
  // the top of the block; it is additive, so `github_pull_request`'s own system
  // arm is unaffected.
  const state = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, subject.repoRow.workspaceId);

    // 4. A repository CONNECTED to Motir is not necessarily a repository Motir
    //    plans work in — a repo selected on the installation so the code can be
    //    read is not one whose pull requests owe a card. `ProjectRepo` is the
    //    existing expression of "this repository holds planned work", so no new
    //    concept is introduced by the rule.
    //    ⚠️ EXISTENTIAL, not a lookup (MOTIR-4648). This check has never wanted a
    //    particular project — it asks whether ANY project plans work in this
    //    repository, and returns a boolean. `findByGithubRepoId` happened to
    //    answer that while `github_repo_id` was unique; with the index dropped the
    //    honest read is the SET, and "is it non-empty?".
    //
    //    (The card described this site as "scoped by the project the card belongs
    //    to". That does not fit the call: the check runs on a pull request, BEFORE
    //    any card is known — deciding whether one is owed at all — so there is no
    //    project to scope by. Amended on the record rather than followed into a
    //    scope this function cannot obtain.)
    const plannedIn = await projectRepoRepository.listByGithubRepoId(subject.repoRow.id, tx);
    if (plannedIn.length === 0) return { planned: false as const };

    // 5. UNLINKED means: no `work_item_delivery` row names this pull request. The
    //    same question the completion gate asks, asked of the same table.
    const pr = await githubPullRequestRepository.findByRepoAndNumber(
      subject.repoRow.id,
      subject.number,
      tx,
    );
    if (!pr) return { planned: true as const, linked: false };
    const deliveries = await workItemDeliveryRepository.listByPullRequest(pr.id, tx);
    return { planned: true as const, linked: deliveries.length > 0 };
  });
  if (!state.planned) return { decision: 'exempt', reason: 'repo_not_planned' };
  const linked = state.linked;

  const headSha =
    subject.headSha ??
    (await readPullRequestHeadSha(
      subject.repoRow.installation.installationId,
      subject.repoRow.owner,
      subject.repoRow.name,
      subject.number,
    ));
  if (!headSha) return { decision: 'skipped', reason: 'no_head_sha' };

  const write = await writeCheckRun({
    installationId: subject.repoRow.installation.installationId,
    owner: subject.repoRow.owner,
    name: subject.repoRow.name,
    headSha,
    conclusion: linked ? 'success' : 'failure',
    title: linked ? 'Linked to a work item' : 'No work item linked',
    summary: linked ? successSummary() : failureSummary(subject),
  });

  return linked ? { decision: 'linked', write } : { decision: 'unlinked', write };
}

/**
 * The LINK-SIDE entry point: re-evaluate the check for one pull request Motir
 * has already mirrored, addressed by its internal row id.
 *
 * This is what makes the hatch a hatch. Without it the instruction would be
 * *"link it, then push something"*, and a check that stays red after the problem
 * is fixed teaches the next person to merge past it — which is worse than no
 * check at all (the card's AC 2, and the reason it is the criterion that decides
 * whether people trust this).
 *
 * Best-effort and post-commit: it runs after the link has been written and
 * committed, and its failure can never turn a recorded link into an error.
 */
export async function refreshLinkCheckForPullRequest(githubPullRequestId: string): Promise<void> {
  const subject = await withSystemContext(async (tx: Prisma.TransactionClient) => {
    const pr = await githubPullRequestRepository.findByIdWithInstallation(githubPullRequestId, tx);
    if (!pr) return null;
    return { repoRow: pr.repo, number: pr.number, headRef: pr.headRef, title: pr.title };
  });
  if (!subject) return;

  await evaluateLinkCheck({
    repoRow: subject.repoRow,
    number: subject.number,
    headSha: null,
    headRef: subject.headRef,
    title: subject.title,
  });
}

export { LINK_CHECK_NAME };
