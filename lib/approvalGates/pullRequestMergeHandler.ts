import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import type { GateSettingsDoor } from '@/lib/approvalGates/settingsDoor';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { liveRowsAtLatestSha } from '@/lib/github/prCiState';
import {
  githubPullRequestRepository,
  type GithubPullRequestWithInstallation,
} from '@/lib/repositories/githubPullRequestRepository';

// THE `pull_request_merge` HANDLER — the registry's SECOND member (Story MOTIR-4882 ·
// MOTIR-4793; ADR docs/decisions/approval-gates.md §1's handler table, §4 and its
// second amendment, decisions 1 and 10).
//
// It supplies what ADR §1's table asks of a kind — resolve the subject, version it,
// route it, name its permission floor, say what each verb DOES — plus the settings
// door the kind's frame carries. Everything generic about deciding a gate stays in
// `approvalGatesService.decide`.
//
// ⚠️ IT DOES NOTHING OUTSIDE THE DATABASE, AND THAT IS THE WHOLE DESIGN. The decide
// door runs in one transaction with no post-commit hook, so a verb that called a Git
// host would either hold a transaction open across a network call or record a
// decision over a merge that did not happen. The MERGE is the merge entry point's
// (MOTIR-5517): it checks the gate is decidable, calls
// `GitProvider.mergeChangeRequest` OUTSIDE any transaction, and only on `merged` or
// `enqueued` calls `decide` — which lands here. So `approve` records and writes no
// status: `done` has one writer, the merge webhook (§4's amendment).

/**
 * The door a merge frame carries (MOTIR-5513): the project setting that decides
 * whether merges ask a person at all, at `PrMergeModeCard`'s `#merge-mode` anchor.
 */
export const MERGE_MODE_SETTINGS_DOOR: GateSettingsDoor = {
  href: '/settings/project/approvals#merge-mode',
  labelKey: 'mergeMode',
};

export const pullRequestMergeGateHandler: GateHandler<GithubPullRequestWithInstallation> = {
  /**
   * The subject is the `github_pull_request` row the gate was raised for
   * (decision 1: `subjectId` is that row's id), with its repository and check rows.
   * Read BY ID — a gate asks about one pull request, never "the card's current one".
   */
  async resolveSubject({
    gate,
    tx,
  }: GateEffectArgs): Promise<GithubPullRequestWithInstallation | null> {
    return githubPullRequestRepository.findByIdWithInstallation(gate.subjectId, tx);
  },

  /**
   * `owner/name#number@headSha` (decision 1) — WHICH commits were approved.
   *
   * ⚠️ THE HEAD IS THE LATEST CHECK RUN'S COMMIT, because `github_pull_request`
   * stores no head sha of its own. That is not a proxy chosen for convenience: a
   * merge gate is raised on the all-green verdict, and that verdict is formed over
   * exactly `liveRowsAtLatestSha(checkRuns)` — so this names the head the question
   * was asked about. Null when the pull request no longer resolves or no check has
   * reported: an approval with an unknown head is weaker evidence than one with a
   * sha, and a refusal here would throw the decision away to protect its footnote.
   */
  async subjectVersion(args: GateEffectArgs): Promise<string | null> {
    const pr = await this.resolveSubject(args);
    if (!pr) return null;
    const head = liveRowsAtLatestSha(pr.checkRuns)[0]?.commitSha;
    return head ? `${pr.repo.owner}/${pr.repo.name}#${pr.number}@${head}` : null;
  },

  /** ADR §2: `assigneeId ?? reporterId` — the routing rule every kind shares. */
  routeTo({ item }: GateRoutingArgs): string | null {
    return routingTargetId(item);
  },

  /**
   * The FLOOR (decision 10; §1's table): `work_item:merge_pull_request`, a key of
   * its own rather than `work_item:edit`, because pressing it lands code on a
   * repository's default branch through Motir's App — an act on the HOST, not on the
   * card. The door asserts it before §2's relationship rule.
   */
  permission: 'work_item:merge_pull_request',

  /** §1's table: *"none — the webhook moves the card (§4)"*. */
  statusIntent: null,

  /** The kind's settings door — handed out only to a `workflow:manage` holder. */
  settingsDoor: MERGE_MODE_SETTINGS_DOOR,

  /**
   * APPROVE — record the decision (the door does that) and write NO status. The merge
   * already happened, or was enqueued, before `decide` was called; the card moves on
   * the webhook exactly as it does for a person merging by hand. Its gate's
   * `outcomeRef` is therefore `null`, and the merge's own outcome lives on the pull
   * request's `merge_outcome_ref` (MOTIR-5520).
   */
  async approve(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'merge_writes_done' };
  },

  /** REQUEST CHANGES — record the decision and move nothing. */
  async requestChanges(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
  },
};
