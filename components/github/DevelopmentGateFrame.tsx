'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CircleX, Loader2 } from 'lucide-react';
import {
  ApprovalGateControl,
  useRefusalCopy,
  type GateVerb,
} from '@/components/approvals/ApprovalGateControl';
import { useOptimisticStatusWriter } from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';
import type {
  approveAndMergeAction,
  decideApprovalGateAction,
  retryApproveAndMergeMemberAction,
} from '@/app/(authed)/items/[key]/approvalGateActions';
import { announceGateDecided } from '@/lib/approvals/decidedGates';
import { membersOf, type MemberVersion } from '@/lib/approvalGates/memberVersion';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import type {
  ApprovalGateDTO,
  ApproveAndMergeMemberOutcomeDTO,
  GateDecision,
  PullRequestApprovalMemberDTO,
} from '@/lib/dto/approvalGate';
import {
  MergeOutcomeProvider,
  persistedRowOutcome,
  rowKey,
  type PersistedRowOutcome,
  type RowMergeOutcome,
} from './MergeOutcomeSlot';
import { QueueExitLine } from './QueueExitLine';
import { decisionDocumentShown } from './DecisionDocumentSlot';
import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';

// THE DEVELOPMENT BLOCK'S FRAME ARM (Story MOTIR-4906 · Subtask MOTIR-5336),
// `design/github/design-notes.md` §20 · Panel 12c — AND ITS VERBS (Story MOTIR-4909 ·
// Subtask MOTIR-5484, Panels 12p–12w). When the card holds a `pull_request_approval` gate,
// in ANY state, the block IS the universal frame — composed exactly as
// `DesignResultSection` composes the design gate: band 2 (the port) is the pull-request rows
// plus How to test, unchanged; ONE frame for all the run target's pull requests, never one
// per row.
//
// ⚠️ NO CARD INSIDE A CARD (§20, Yue 2026-09-15). The Development section card is the
// container, so the frame renders `layout="flush"` and steps out of the card body's padding:
// its bands run edge to edge under the card head, and the port keeps its floor, ceiling and
// Expand.
//
// ⚠️ THE PRESS IS ONE SERVER CALL, AND ITS ORDER IS THE SERVICE'S. *Approve and merge* calls
// `pullRequestMergeService.approveAndMerge` (MOTIR-5483): the approval commits first, then
// each pull request merges, joins its merge queue, or is refused. The frame draws what that
// ONE response reports — the approval stands whatever the merges did — and a refused member
// offers *Retry merge* on its own row.
//
// ⚠️ A REFUSAL'S REASON LIVES ONLY IN THIS COMPONENT'S STATE. The press does not persist it,
// so after a reload the row reads *Not merged yet* with *Retry merge* and no reason — the
// server read (`members`) says only that the merge gate still awaits. Showing a reason the
// page no longer has would be inventing one.
//
// ⚠️ THE ACTIONS ARRIVE AS PROPS. The item page hands its server actions down; a surface that
// hands none (every test of the block, and any read-only host) draws the frame with no verbs,
// exactly as it did before this card.

export interface DevelopmentGateRead {
  gate: ApprovalGateDTO;
  canDecide: boolean;
  routedToLabel: string | null;
  /**
   * WHAT THIS READER IS BEING SHOWN (Story MOTIR-5232 · Subtask MOTIR-5235) — the stamp
   * the gate read handed over, sent back with the press. For a design gate it also covers
   * the pull requests beneath it, which the one press merges. Null when the gate is not
   * awaiting, which is also when there is nothing to press.
   */
  stamp: string | null;
  /**
   * What a reload still knows about each member once the gate is APPROVED — whether its merge
   * gate still awaits and whether the press queued it (MOTIR-5484). Empty before that.
   */
  members?: PullRequestApprovalMemberDTO[];
}

/**
 * THE DECISION PORT'S FACTS (Story MOTIR-4907 · Subtask MOTIR-5678; design §27) — what the
 * frame needs when the gate it asks is a `decision_approval`: the document the slot drew,
 * and the pull requests one press on it will merge. A decision gate's own version names a
 * FILE, not a set, so the pull requests cannot be read out of it the way a merge gate's are.
 */
export interface DecisionPortFacts {
  document: DecisionDocumentViewDTO | null;
  /** `owner/name · #n` of every open pull request delivering the card, in row order. */
  openPullRequests: string[];
}

/** `owner/name:path@blob` → its path and blob; null for an unresolvable version. */
function parseDecisionVersion(version: string | null): { path: string; blob: string } | null {
  if (!version) return null;
  const colon = version.indexOf(':');
  const at = version.lastIndexOf('@');
  if (colon <= 0 || at <= colon) return null;
  const path = version.slice(colon + 1, at);
  if (path.startsWith('unresolvable:')) return null;
  return { path, blob: version.slice(at + 1) };
}

/** The item page's server actions this frame presses. */
export interface DevelopmentGateActions {
  decide: typeof decideApprovalGateAction;
  approveAndMerge: typeof approveAndMergeAction;
  retryMember: typeof retryApproveAndMergeMemberAction;
}

/** The head a pull request is at NOW — what names the member a push moved (state `G`). */
export interface CurrentHead {
  repo: string;
  number: number;
  headSha: string;
}

/** What the press, or a retry, reported about one member — the response's outcome, minus
 *  the ids a row does not need. */
type PressOutcome =
  | { outcome: 'merged' | 'enqueued' | 'no_merge_gate' }
  | { outcome: 'refused'; refusal: GateRefusal; pullRequestId: string | null };

function pressOutcomeOf(member: ApproveAndMergeMemberOutcomeDTO): PressOutcome {
  return member.outcome === 'refused'
    ? { outcome: 'refused', refusal: member.refusal, pullRequestId: member.pullRequestId }
    : { outcome: member.outcome };
}

/** One refused member's line in the alert band: the pull request, then the refusal's own
 *  words from MOTIR-4882's union — never a string this surface writes. A refused *Queue
 *  again* says so in its title (E7). */
function RefusedMemberLine({
  name,
  refusal,
  requeue,
}: {
  name: string;
  refusal: GateRefusal;
  requeue: boolean;
}) {
  const t = useTranslations('approvalGate.pullRequestApproval');
  const { headline, nextAction } = useRefusalCopy(refusal);
  return (
    <span className="block">
      <b>{t(requeue ? 'requeue.refusedTitle' : 'refused.title', { pr: name })}</b> {headline}{' '}
      <span className="text-(--el-text-secondary)">{nextAction}</span>
    </span>
  );
}

export function DevelopmentGateFrame({
  read,
  itemIdentifier,
  runLabel,
  currentHeads = [],
  actions,
  layout = 'flush',
  onShowCurrentVersion,
  gateKey = 0,
  decision = null,
  children,
}: {
  read: DevelopmentGateRead;
  /** The card's `MOTIR-<n>` — named by the consequence line and the confirm step, and the
   *  page the actions revalidate. */
  itemIdentifier: string;
  /** Band 1's meta — the run that delivered the pull requests, when known. */
  runLabel: string | null;
  currentHeads?: CurrentHead[];
  actions?: DevelopmentGateActions;
  /**
   * WHICH BOX the frame sits in (Story MOTIR-5437 · Subtask MOTIR-5440;
   * `design/workbench/design-notes.md` § 24, *FILL, not FLUSH*).
   *
   * `flush` (the default) is the ITEM PAGE: the Development section card is the
   * container, so the frame drops its own chrome and steps out of the card body's
   * padding, and the port keeps its floor, its 34rem ceiling and Expand.
   * `fill` is the APPROVAL OVERLAY: the dialog is the container and the VIEWPORT is
   * the box, so the port drops that floor, that ceiling and Expand, and band 3 sits
   * on the bottom edge. Both are `ApprovalGateControl`'s own shipped layouts — the
   * only thing that differs is the box, and this input picks it. Every band, verb,
   * state, outcome and refusal below is identical in the two.
   */
  layout?: 'flush' | 'fill';
  /**
   * *Show the current version* — re-run the read this frame was rendered from
   * (MOTIR-5235). The approval overlay passes its own fetch. Omitted — the item page —
   * it is `router.refresh()`, because there the block is SERVER-rendered and that is
   * the read it came from (the page-state contract's case 2).
   */
  onShowCurrentVersion?: () => void;
  /** Bumped by a host whose re-read does not change `read.stamp`'s identity on its own. */
  gateKey?: number;
  /** The decision port's facts — read only when the gate asked is `decision_approval`. */
  decision?: DecisionPortFacts | null;
  children: ReactNode;
}) {
  const t = useTranslations('approvalGate.pullRequestApproval');
  const tGate = useTranslations('approvalGate');
  const tDesign = useTranslations('approvalGate.designResult');
  const tDecision = useTranslations('approvalGate.decision');
  const router = useRouter();
  // The in-browser path to the status rail (Bug MOTIR-5212) — a no-op outside the item page.
  const { applyOptimisticStatus, clearOptimisticStatus } = useOptimisticStatusWriter();

  // The gate as this frame knows it: the server's, until this reader decides — then the row
  // the response returned. A DIFFERENT gate from the server (a withdrawal and a fresh raise
  // arrived on a refresh) replaces it, because it is a different question.
  const [decided, setDecided] = useState<ApprovalGateDTO | null>(null);
  // The reader asked for the current version (MOTIR-5235): the frame that mounts from the
  // re-read focuses its port, and no ordinary render ever does.
  const [rereadAsked, setRereadAsked] = useState(false);
  const gate = decided && decided.id === read.gate.id ? decided : read.gate;
  const [pressing, setPressing] = useState(false);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, PressOutcome>>(new Map());
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  // Members whose latest press was *Queue again* rather than *Retry merge* (MOTIR-5635) —
  // what words their progress line and a refusal's title.
  const [requeued, setRequeued] = useState<ReadonlySet<string>>(new Set());
  // ⚠️ A ROW VERB ON THE RE-ASKED GATE TAKES THE FRAME'S CONFIRM (Story MOTIR-5799 ·
  // MOTIR-5806; § 28 panel 8a). The press IS a new approval, so it is asked for the same
  // way the frame's own Approve is — one band, one list of consequences, one pending and
  // one refusal — rather than acting the instant a row button is clicked. On the DECIDED
  // gate a row's *Retry merge* carries out a decision already made and still presses
  // straight through: there is nothing new to agree to.
  const [rowPress, setRowPress] = useState<{
    subjectVersion: string;
    pullRequestId: string;
    label: string;
    queueAgain: { failure: boolean } | null;
  } | null>(null);

  const members = membersOf(gate.subjectVersion);
  const count = members.length;
  const nameOf = (member: Pick<MemberVersion, 'repo' | 'number'>) =>
    `${member.repo} · #${member.number}`;
  const nameList = (names: string[]): string =>
    names.length < 2
      ? (names[0] ?? '')
      : t('list.pair', {
          a: names.slice(0, -1).join(t('list.separator')),
          b: names[names.length - 1]!,
        });

  async function retryMember(
    subjectVersion: string,
    pullRequestId: string,
    queueAgain: { failure: boolean } | null = null,
    /** The press came through the frame's confirm band, which reports the refusal itself
     *  (§ 28 panel 8a) — so the row is left as the reload reads it. */
    throughConfirm = false,
  ): Promise<GateRefusal | null> {
    if (!actions) return null;
    setRetrying((prev) => new Set(prev).add(subjectVersion));
    setRequeued((prev) => {
      const next = new Set(prev);
      if (queueAgain) next.add(subjectVersion);
      else next.delete(subjectVersion);
      return next;
    });
    // *Queue again* after a FAILURE returns the card to Approved through the decided gate's
    // own write (decision 5): the rail says so now, and a refusal takes it back. A neutral
    // removal never moved the card, so there is nothing to predict.
    if (queueAgain?.failure) applyOptimisticStatus('approved');
    try {
      const result = await actions.retryMember({
        approvalGateId: gate.id,
        pullRequestId,
        identifier: itemIdentifier,
        // On the RE-ASKED gate this press IS the approval (MOTIR-5802), so it carries the
        // stamp THIS read handed over — what is on screen, never refetched (MOTIR-5235).
        stamp: read.stamp ?? '',
      });
      if (queueAgain?.failure && !result.ok) clearOptimisticStatus();
      // ONLY THAT ROW: a retry reports one member, and the others keep what they showed.
      if (result.ok || !throughConfirm) {
        setOutcomes((prev) =>
          new Map(prev).set(
            subjectVersion,
            result.ok
              ? pressOutcomeOf(result.member)
              : { outcome: 'refused', refusal: result.refusal, pullRequestId },
          ),
        );
      }
      if (result.ok) router.refresh();
      return result.ok ? null : result.refusal;
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(subjectVersion);
        return next;
      });
    }
  }

  const factOf = (member: MemberVersion) =>
    read.members?.find((m) => m.subjectVersion === member.subjectVersion) ?? null;

  /**
   * What a row verb's press DOES. On the RE-ASKED gate it is a new approval, so it opens
   * the frame's confirm band and nothing happens until the reader proceeds (§ 28 panel
   * 8a); on the decided gate it carries out a decision already made and runs at once.
   */
  function pressRow(
    member: MemberVersion,
    pullRequestId: string,
    label: string,
    queueAgain: { failure: boolean } | null,
  ) {
    if (gate.state === 'awaiting') {
      setRowPress({ subjectVersion: member.subjectVersion, pullRequestId, label, queueAgain });
      return;
    }
    void retryMember(member.subjectVersion, pullRequestId, queueAgain);
  }

  function retryFor(member: MemberVersion, pullRequestId: string | null) {
    return {
      onRetry:
        read.canDecide && actions && pullRequestId
          ? () => pressRow(member, pullRequestId, t('outcome.retry'), null)
          : null,
      retrying: retrying.has(member.subjectVersion),
    };
  }

  function queueAgainFor(member: MemberVersion, fact: PullRequestApprovalMemberDTO) {
    const failure = fact.exit?.disposition === 'failure';
    return {
      onQueueAgain:
        read.canDecide && actions && fact.pullRequestId
          ? () => pressRow(member, fact.pullRequestId!, t('outcome.queueAgain'), { failure })
          : null,
      queueing: retrying.has(member.subjectVersion),
    };
  }

  // TOTAL over what a reload knows (MOTIR-5635): a new `PersistedRowOutcome` does not compile
  // until the frame draws it — with its verb, which the quick view's reading has not.
  const rowForState: Record<
    PersistedRowOutcome,
    (member: MemberVersion, fact: PullRequestApprovalMemberDTO) => RowMergeOutcome | null
  > = {
    queued: () => ({ kind: 'queued' }),
    leftQueue: (member, fact) => ({ kind: 'leftQueue', ...queueAgainFor(member, fact) }),
    removedFromQueue: (member, fact) => ({
      kind: 'removedFromQueue',
      ...queueAgainFor(member, fact),
    }),
    newCommits: () => ({ kind: 'newCommits' }),
    // MOTIR-5613: a retry is offered by the pull request under the card's own gate — there
    // is no second gate to press. The row's copy is MOTIR-5615's.
    notMergedYet: (member, fact) => ({
      kind: 'notMergedYet',
      ...retryFor(member, fact.pullRequestId),
    }),
    // THE HOST REFUSED (MOTIR-5833 · MOTIR-5834; § 28 panels 3 and 4). A setting somebody
    // can change offers *Retry merge*, which DECIDES the re-asked gate, and the record
    // band names the setting; a conflict offers nothing, because no approval can land
    // those commits.
    refusedSetting: (member, fact) => ({
      kind: 'refusedSetting',
      ...retryFor(member, fact.requeueable ? fact.pullRequestId : null),
    }),
    cannotLand: () => ({ kind: 'cannotLand' }),
  };

  function outcomeFor(member: MemberVersion): RowMergeOutcome | null {
    if (pressing) return { kind: 'merging' };
    const pressed = outcomes.get(member.subjectVersion);
    // A refused *Queue again* leaves the row as the reload reads it — still out of the
    // queue, still offering the press (E7); the refusal is named in the alert band.
    const requeueRefused = pressed?.outcome === 'refused' && requeued.has(member.subjectVersion);
    if (pressed && !requeueRefused) {
      switch (pressed.outcome) {
        case 'merged':
          return { kind: 'merged' };
        case 'enqueued':
          return { kind: 'queued' };
        case 'refused':
          return { kind: 'refused', ...retryFor(member, pressed.pullRequestId) };
        case 'no_merge_gate':
          // Nothing was pressed for it, so there is nothing to report and the row is unchanged.
          return null;
      }
    }
    // ⚠️ AN UN-LANDED OUTCOME OUTLIVES THE APPROVAL THAT SPENT IT (MOTIR-5802): the
    // approval that authorized the action is gone the moment it did not land, and a
    // RE-ASKED gate stands in its place — so the row draws its reason under `awaiting`
    // exactly as it did under `approved`. Anything later (a push, a withdrawal) is a
    // different subject, and its facts are not about these commits.
    if (gate.state !== 'approved' && gate.state !== 'awaiting') return null;
    const fact = factOf(member);
    if (!fact) return null;
    // The same reading the quick view applies (`persistedRowOutcome`, Bug MOTIR-5650).
    const kind = persistedRowOutcome(fact);
    return kind ? rowForState[kind](member, fact) : null;
  }

  const rowOutcomes = new Map<string, RowMergeOutcome>();
  for (const member of members) {
    const outcome = outcomeFor(member);
    if (outcome) rowOutcomes.set(rowKey(member.repo, member.number), outcome);
  }
  const membersIn = (kind: RowMergeOutcome['kind']) =>
    members.filter((member) => rowOutcomes.get(rowKey(member.repo, member.number))?.kind === kind);

  async function onDecide(decision: GateDecision): Promise<GateRefusal | null> {
    if (!actions) return null;
    if (decision === 'approve') {
      setPressing(true);
      let result: Awaited<ReturnType<DevelopmentGateActions['approveAndMerge']>>;
      try {
        // The stamp THIS read handed over — what is on screen, never refetched (MOTIR-5235).
        result = await actions.approveAndMerge({
          gateId: gate.id,
          identifier: itemIdentifier,
          stamp: read.stamp ?? '',
        });
      } finally {
        setPressing(false);
      }
      // A refusal of the APPROVAL applies nothing: no merge was attempted.
      if (!result.ok) return result.refusal;
      setDecided(result.gate);
      setOutcomes(new Map(result.members.map((m) => [m.subjectVersion, pressOutcomeOf(m)])));
      // The rail, in the browser, from the status the decision RECORDED writing (MOTIR-5212).
      applyOptimisticStatus(result.gate.outcomeRef);
      // ⚠️ AND EVERY OTHER SURFACE WATCHING THIS GATE (MOTIR-5570, MOTIR-5440). Pressed
      // from the approval OVERLAY, the To-approve row underneath is a client island this
      // component cannot reach and `router.refresh()` does not re-seed — so the row settles
      // in the SAME reconcile only because the decision is announced. `filesKept` is the
      // design kind's field and is null here: this gate keeps no files.
      announceGateDecided({ gate: result.gate, filesKept: null });
      router.refresh();
      return null;
    }
    const result = await actions.decide({
      gateId: gate.id,
      decision,
      identifier: itemIdentifier,
      stamp: read.stamp ?? '',
    });
    if (!result.ok) return result.refusal;
    setDecided(result.gate);
    applyOptimisticStatus(result.gate.outcomeRef);
    announceGateDecided({ gate: result.gate, filesKept: null });
    router.refresh();
    return null;
  }

  // ── Band 1 ────────────────────────────────────────────────────────────────────
  const moved = members.filter((member) => {
    const head = currentHeads.find(
      (h) => rowKey(h.repo, h.number) === rowKey(member.repo, member.number),
    );
    return head !== undefined && head.headSha !== member.headSha;
  });
  const decidedByThisReader = decided !== null && decided.id === read.gate.id;
  // THE RE-ASKED GATE (Story MOTIR-5799 · MOTIR-5806; § 4 FOURTH AMENDMENT, point 4): a
  // question still awaiting, standing over commits an earlier press did not land. The
  // member facts are what say so — an exit nobody put back, or a refusal the host gave —
  // and three bands read differently for it: the meta, the record band and the
  // consequence line.
  const reasked =
    gate.state === 'awaiting' &&
    (read.members ?? []).some((fact) => fact.exit !== null || fact.refusal !== null);
  const subjectMeta =
    count === 0
      ? runLabel
      : // ⚠️ A RE-ASKED GATE SAYS SO IN BAND 1 (MOTIR-5806; § 28 panel 1). *Delivered by
        // run N* is true of a first ask and misleading of this one: nothing was delivered
        // just now — a press did not land, and the question came back.
        reasked
        ? t('reasked.meta', { count })
        : gate.state === 'superseded'
          ? moved.length > 0
            ? t('meta.withdrawn', { count, pr: nameList(moved.map(nameOf)) })
            : t('meta.withdrawnSet', { count })
          : gate.state === 'approved'
            ? decidedByThisReader
              ? t('meta.approvedByYou', { count })
              : gate.decidedByLabel
                ? // The same fact, said where it happened (MOTIR-5599; design § 23).
                  gate.decisionSource === 'github'
                  ? t('github.meta.approved', { name: gate.decidedByLabel, count })
                  : t('meta.approved', { name: gate.decidedByLabel, count })
                : t('meta.count', { count })
            : gate.state === 'awaiting' && runLabel
              ? t('meta.delivered', { count, run: runLabel })
              : t('meta.count', { count });

  // ── THE DECISION PORT (MOTIR-5678; design §27) ──────────────────────────────────
  // A decision gate LEADS the frame the way a design gate does, and every band says so in
  // its own words: band 1 names the document, band 3 what accepting it merges — or, when
  // there is no one document to accept, why Approve is disabled.
  const isDecision = gate.kind === 'decision_approval';
  const decisionDoc = decision?.document ?? null;
  const decisionPrs = decision?.openPullRequests ?? [];
  const decisionShown = decisionDocumentShown(decisionDoc);
  const b = (chunks: ReactNode) => <b className="font-semibold text-(--el-text)">{chunks}</b>;
  const monoSpan = (chunks: ReactNode) => <span className="font-mono">{chunks}</span>;
  function decisionMeta(): ReactNode {
    const prCount = decisionPrs.length;
    const withRun = <K extends string>(key: K) => (runLabel ? key : (`${key}NoRun` as const));
    if (gate.state === 'superseded') {
      const asked = parseDecisionVersion(gate.subjectVersion);
      return asked
        ? tDecision('headMeta.withdrawn', { path: asked.path, blob: asked.blob.slice(0, 7) })
        : t('meta.withdrawnSet', { count: prCount });
    }
    const run = runLabel ?? '';
    if (
      decisionDoc?.outcome === 'resolved' ||
      (decisionDoc?.outcome === 'unresolvable' && decisionDoc.path)
    ) {
      const path = decisionDoc.outcome === 'resolved' ? decisionDoc.path : decisionDoc.path!;
      return tDecision(`headMeta.${withRun('one')}`, { path, count: prCount, run });
    }
    if (decisionDoc?.outcome === 'unresolvable' && decisionDoc.reason === 'none') {
      return tDecision(`headMeta.${withRun('none')}`, { count: prCount, run });
    }
    if (decisionDoc?.outcome === 'unresolvable' && decisionDoc.reason === 'several') {
      return tDecision(`headMeta.${withRun('several')}`, {
        docs: decisionDoc.paths.length,
        count: prCount,
        run,
      });
    }
    return runLabel
      ? t('meta.delivered', { count: prCount, run: runLabel })
      : t('meta.count', { count: prCount });
  }

  // ── Band 3 ────────────────────────────────────────────────────────────────────
  const verbs: GateVerb[] = actions
    ? [
        {
          decision: 'request_changes',
          label: tGate('verb.requestChanges'),
          variant: 'secondary',
          // Sending the pull requests back records a note and moves nothing, so it does not
          // confirm — a reversible act asked twice is friction rather than care.
          confirms: false,
        },
        {
          decision: 'approve',
          label: t('verb.approveAndMerge'),
          variant: 'primary',
          // Merging is not reversible from here, which is what the confirm step says aloud.
          confirms: true,
          // A decision with no one document on screen cannot be accepted (§27 Panels 3a–3d):
          // Approve stays drawn and disabled, with the reason as band 3's line.
          disabled: isDecision && !decisionShown,
        },
      ]
    : [];
  // The members this re-asked question is actually about, and whether a SETTING is what is
  // in the way — which changes what approving promises (a merge, not a queue).
  const unlandedNames = [
    ...membersIn('leftQueue'),
    ...membersIn('removedFromQueue'),
    ...membersIn('refusedSetting'),
  ].map(nameOf);
  const settingHeld = membersIn('refusedSetting').length > 0;
  // One or two pull requests are NAMED; three or more are COUNTED, because band 3 is one line
  // and an unbounded list pushes the verbs off the frame. The confirm step names every one.
  const consequence = isDecision
    ? actions
      ? decisionShown
        ? decisionPrs.length > 0
          ? tDecision.rich('consequence', {
              prs: nameList(decisionPrs),
              key: itemIdentifier,
              b,
            })
          : tDecision.rich('consequenceNoPrs', { key: itemIdentifier, b })
        : tDecision('blocked')
      : null
    : // ⚠️ THE RE-ASKED GATE PROMISES SOMETHING NARROWER (§ 28 panel 1's `af-why`): the
      // members that did not land go back where they came from — a merge queue, or the
      // host once a setting allows it — rather than the whole set being sent for the first
      // time. The general line is still right for every other awaiting gate.
      actions && reasked && unlandedNames.length > 0
      ? t(settingHeld ? 'reasked.whySetting' : 'reasked.why', {
          pr: nameList(unlandedNames),
          key: itemIdentifier,
        })
      : actions && count > 0
        ? count <= 2
          ? t('consequence.named', { prs: nameList(members.map(nameOf)), key: itemIdentifier })
          : t('consequence.counted', { count, key: itemIdentifier })
        : null;
  const rowPressMember = rowPress
    ? (members.find((member) => member.subjectVersion === rowPress.subjectVersion) ?? null)
    : null;
  const confirmConsequences = isDecision
    ? [
        tDecision('confirm.records'),
        ...decisionPrs.map((pr) => t('confirm.mergeOrQueue', { pr })),
        tDecision('confirm.moves', { key: itemIdentifier }),
      ]
    : // ⚠️ A ROW PRESS AGREES TO ITS OWN TWO THINGS (§ 28 panel 8a). The set's list would
      // name pull requests this press does not touch, and — the point of the whole
      // amendment — it must say ALOUD that this is a NEW approval, not the spent one.
      rowPress && rowPressMember
      ? [
          t('reasked.confirm.newApproval', { count }),
          rowPress.queueAgain
            ? t('reasked.confirm.requeue', { pr: nameOf(rowPressMember) })
            : t('reasked.confirm.merge', { pr: nameOf(rowPressMember) }),
          t('confirm.movesToApproved', { key: itemIdentifier }),
        ]
      : actions
        ? [
            t('confirm.records', { count }),
            ...members.map((member) => t('confirm.mergeOrQueue', { pr: nameOf(member) })),
            t('confirm.movesToApproved', { key: itemIdentifier }),
          ]
        : [];

  /** The row verb, as a frame verb: the band opens for it, and proceeding runs its act. */
  const requestedVerb: GateVerb | null =
    rowPress && rowPressMember
      ? {
          decision: 'approve',
          label: rowPress.label,
          variant: 'primary',
          confirms: true,
          perform: () =>
            retryMember(rowPress.subjectVersion, rowPress.pullRequestId, rowPress.queueAgain, true),
        }
      : null;

  // State `H` for a MEMBER: the approval stands, and the refusal is named in place.
  const refused = members.flatMap((member) => {
    const pressed = outcomes.get(member.subjectVersion);
    return !pressing && pressed?.outcome === 'refused'
      ? [{ member, refusal: pressed.refusal, requeue: requeued.has(member.subjectVersion) }]
      : [];
  });
  const mergedNames = membersIn('merged').map(nameOf);
  const alert =
    refused.length > 0 ? (
      <div
        role="alert"
        className="flex gap-2.5 border-t border-(--el-border-soft) bg-(--el-tint-peach) px-4 py-3"
      >
        <AlertTriangle
          className="mt-0.5 h-4 w-4 flex-none text-(--el-danger-on-surface)"
          aria-hidden
        />
        <p className="text-[13px] leading-snug text-(--el-text-strong)">
          {refused.map(({ member, refusal, requeue }) => (
            <RefusedMemberLine
              key={member.subjectVersion}
              name={nameOf(member)}
              refusal={refusal}
              requeue={requeue}
            />
          ))}
          {/* ⚠️ *YOUR APPROVAL STANDS* IS GONE, AND ITS ABSENCE IS THE POINT (MOTIR-5834;
              §4 FOURTH AMENDMENT, point 1). A press that did not land SPENT the approval,
              whatever the reason class, so the only true thing left to say here is what
              DID merge — and when nothing did, nothing. Each member's own line already
              says what to do next. */}
          {mergedNames.length > 0 ? (
            <span className="block text-(--el-text-secondary)">
              {t('refused.stands', { other: nameList(mergedNames) })}
            </span>
          ) : null}
        </p>
      </div>
    ) : null;

  // The decided record's own facts: how many commits the approval covered, and the ONE thing
  // the merges are still waiting on — a member with no merge yet, a queue, or the host.
  const notYet = membersIn('notMergedYet');
  const queued = membersIn('queued');
  const why =
    notYet.length > 0
      ? t('notMergedYet.why', { pr: nameList(notYet.map(nameOf)), host: t('host') })
      : queued.length > 0
        ? t('queued.why', { key: itemIdentifier, pr: nameList(queued.map(nameOf)) })
        : count > 0 && membersIn('merged').length === count
          ? t('merged.why', { key: itemIdentifier, host: t('host') })
          : null;
  // THE EXITS (MOTIR-5635; § 22): every member the queue removed and nobody has put back,
  // in words, with its failing check — or, while its *Queue again* is in flight, what is
  // happening instead (E2).
  const bold = (chunks: ReactNode) => <b className="font-semibold text-(--el-text)">{chunks}</b>;
  /**
   * THE SENTENCE UNDER AN UN-LANDED OUTCOME, by class and by where the gate stands
   * (MOTIR-5806; § 28 panels 1–4).
   *
   * ⚠️ ON THE RE-ASKED GATE IT SAYS THE APPROVAL WAS SPENT. That is the whole of what
   * changed for a reader: the pill and the verb look much as they did, and only this line
   * says the press ahead of them is a NEW approval rather than the old one still working.
   */
  function unlandedSub(kind: RowMergeOutcome['kind'], neutral: boolean): ReactNode {
    if (kind === 'newCommits') return t('exit.newCommits');
    if (kind === 'cannotLand') return t.rich('exit.cannotLand', { b: bold });
    if (kind === 'refusedSetting') return t.rich('setting.reasked', { b: bold });
    if (!reasked) return t.rich('exit.unchanged', { b: bold });
    return t.rich(neutral ? 'exit.neutral.reasked' : 'exit.reasked.failure', { b: bold });
  }
  const exitParts = members.flatMap((member) => {
    const kind = rowOutcomes.get(rowKey(member.repo, member.number))?.kind;
    // ⚠️ `cannotLand` AND `refusedSetting` ARE IN THE LIST (MOTIR-5806; § 28 panels 3 and
    // 4). The first offers no verb at all, which is exactly why the band still has to SAY
    // WHY; the second's verb cannot explain which setting is in the way.
    if (
      kind !== 'leftQueue' &&
      kind !== 'removedFromQueue' &&
      kind !== 'newCommits' &&
      kind !== 'cannotLand' &&
      kind !== 'refusedSetting'
    ) {
      return [];
    }
    const fact = factOf(member);
    // A HOST REFUSAL HAS NO EXIT ROW (MOTIR-5833): the queue never saw these commits, so
    // the line is the refusal's own, and the failing check it has no notion of is absent.
    if (fact && !fact.exit && fact.refusal) {
      if (retrying.has(member.subjectVersion)) {
        return [
          <span key={member.subjectVersion} className="inline-flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {t('requeue.progress', { pr: nameOf(member) })}
          </span>,
        ];
      }
      return [
        <span
          key={member.subjectVersion}
          className="flex w-full min-w-0 basis-full flex-col gap-1"
          data-merge-refusal
        >
          <span className="flex items-start gap-2 leading-snug">
            <CircleX
              className="mt-0.5 h-3.5 w-3.5 flex-none text-(--el-danger-on-surface)"
              aria-hidden
            />
            <span>
              {fact.refusal.permission
                ? t.rich('setting.linePermission', {
                    pr: nameOf(member),
                    permission: fact.refusal.permission,
                    b: bold,
                  })
                : t.rich(kind === 'cannotLand' ? 'cannotLand.line' : 'setting.line', {
                    pr: nameOf(member),
                    b: bold,
                  })}
            </span>
          </span>
          <span className="ml-5.5 text-(--el-text-secondary)">{unlandedSub(kind, false)}</span>
        </span>,
      ];
    }
    if (!fact?.exit) return [];
    if (kind !== 'newCommits' && retrying.has(member.subjectVersion)) {
      return [
        <span key={member.subjectVersion} className="inline-flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {t('requeue.progress', { pr: nameOf(member) })}
        </span>,
      ];
    }
    return [
      <QueueExitLine
        key={member.subjectVersion}
        name={nameOf(member)}
        exit={fact.exit}
        sub={unlandedSub(kind, fact.exit.disposition !== 'failure')}
      />,
    ];
  });
  // ⚠️ THE RE-ASKED GATE CARRIES A RECORD BAND, which no other awaiting gate does
  // (§ 28 panel 1). It is the one question with history behind it: the reader is being
  // asked again because a press of theirs did not land, and the reason has to be on screen
  // WHILE they decide rather than only after.
  const awaitingRecord = reasked && exitParts.length > 0 ? <>{exitParts}</> : null;
  const decisionAccepted = isDecision && gate.state === 'approved';
  const acceptedBlob = decisionAccepted ? parseDecisionVersion(gate.subjectVersion)?.blob : null;
  const recordDetail = decisionAccepted ? (
    // Panels 4 and 6a: the accepted BLOB named, then — while a pull request is still open —
    // that it merges on its own once its checks pass. No verb: a second press would ask a
    // question whose answer is already on the record.
    <>
      {acceptedBlob ? (
        <span>
          {tDecision.rich('acceptedBlob', { blob: acceptedBlob.slice(0, 7), mono: monoSpan })}
        </span>
      ) : null}
      {decisionPrs.length > 0 ? <span>{tDecision('mergeHeld')}</span> : null}
      {why ? <span>{why}</span> : null}
    </>
  ) : gate.state === 'approved' && count > 0 ? (
    <>
      <span>{t('record.commits', { count })}</span>
      {why ? <span>{why}</span> : null}
      {exitParts}
    </>
  ) : null;

  // The item page's frame steps out of its card's padding so the bands meet the
  // card's edges; the overlay HAS no card — the dialog is the container — so it
  // takes no wrapper at all (§ 24, *FILL, not FLUSH*).
  const inBox = (frame: ReactNode) =>
    layout === 'fill' ? (
      frame
    ) : (
      <div className="-mx-(--spacing-card-padding) -mb-(--spacing-card-padding) overflow-hidden rounded-b-(--radius-card) border-t border-(--el-border-soft)">
        {frame}
      </div>
    );

  return (
    <MergeOutcomeProvider value={rowOutcomes}>
      {inBox(
        <ApprovalGateControl
          // A fresh read is a fresh frame: the stale refusal clears and the verbs return.
          key={`${read.gate.id}:${read.stamp ?? ''}:${gateKey}`}
          layout={layout}
          // ⚠️ THE VERSION IS NOT HANDED TO THE RECORD STRIP. The frame prints the first eight
          // characters of `subjectVersion`, which names a design's commit — and would print
          // `moooon/m` for a set. The set is named in band 1 and counted in `recordDetail`;
          // the audit column itself is untouched.
          gate={{ ...gate, subjectVersion: null }}
          canDecide={read.canDecide}
          // ⚠️ THE KIND LABEL FOLLOWS THE GATE, not the block (Story MOTIR-5652 ·
          // Subtask MOTIR-5667; `design-result.md` AMENDMENT 6 Q1). A design card
          // with commits holds TWO gates and the DESIGN one leads: the frame is its
          // port, with the pull requests beneath it as what approving will merge.
          // Band 1 saying *Pull requests* over a design subject is the near miss
          // this level is about — a question that IS there, wearing the words of a
          // different one, which a reviewer would answer anyway.
          //
          // Band 3 is deliberately UNCHANGED: the verb and the consequence are the
          // shipped approve-and-merge wording, because one press is what merges the
          // set (MOTIR-5664), and a second visual language for the same act would be
          // the duplication this level exists to remove.
          kindLabel={
            gate.kind === 'design_result'
              ? tDesign('kindLabel')
              : isDecision
                ? tDecision('kindLabel')
                : t('kindLabel')
          }
          subjectMeta={isDecision ? decisionMeta() : subjectMeta}
          // `data-port` lifts the block's code surfaces to `--el-card` on the port's
          // `--el-surface` (§20 Decisions: the same fill would leave only the edge).
          port={
            <div data-port className="min-w-0">
              {children}
            </div>
          }
          verbs={verbs}
          consequence={consequence}
          confirmConsequences={confirmConsequences}
          routedToLabel={read.routedToLabel}
          alert={alert}
          recordDetail={recordDetail}
          recordLead={
            decisionAccepted && gate.decidedByLabel && gate.decisionSource !== 'github'
              ? tDecision.rich('accepted', {
                  name: gate.decidedByLabel,
                  when: gate.decidedAt ? new Date(gate.decidedAt).toLocaleString() : '',
                  b,
                })
              : undefined
          }
          withdrawnPort={
            isDecision
              ? {
                  // A PER-KIND cause (§27): the shared `head_moved` line stays true for every
                  // other kind; the decision kind is withdrawn by a push only when the push
                  // changed the DOCUMENT, and says so.
                  port:
                    gate.supersededCause === 'head_moved'
                      ? tGate('withdrawn.causeByKind.decision_approval.head_moved')
                      : tGate(`withdrawn.cause.${gate.supersededCause ?? 'unknown'}`),
                  cite: tDecision('withdrawnNext'),
                }
              : {
                  port:
                    moved.length > 0
                      ? t('withdrawn.port', { pr: nameList(moved.map(nameOf)) })
                      : t('withdrawn.portSet'),
                  cite: t('withdrawn.portCite'),
                }
          }
          onDecide={onDecide}
          onShowCurrentVersion={() => {
            setRereadAsked(true);
            (onShowCurrentVersion ?? (() => router.refresh()))();
          }}
          focusPortOnMount={rereadAsked}
          requestedVerb={requestedVerb}
          onRequestedVerbDone={() => setRowPress(null)}
          awaitingRecord={awaitingRecord}
        />,
      )}
    </MergeOutcomeProvider>
  );
}
