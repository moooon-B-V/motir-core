'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
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
import { membersOf, type MemberVersion } from '@/lib/approvalGates/memberVersion';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import type {
  ApprovalGateDTO,
  ApproveAndMergeMemberOutcomeDTO,
  GateDecision,
  PullRequestApprovalMemberDTO,
} from '@/lib/dto/approvalGate';
import { MergeOutcomeProvider, rowKey, type RowMergeOutcome } from './MergeOutcomeSlot';

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
   * What a reload still knows about each member once the gate is APPROVED — whether its merge
   * gate still awaits and whether the press queued it (MOTIR-5484). Empty before that.
   */
  members?: PullRequestApprovalMemberDTO[];
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
 *  words from MOTIR-4882's union — never a string this surface writes. */
function RefusedMemberLine({ name, refusal }: { name: string; refusal: GateRefusal }) {
  const t = useTranslations('approvalGate.pullRequestApproval');
  const { headline, nextAction } = useRefusalCopy(refusal);
  return (
    <span className="block">
      <b>{t('refused.title', { pr: name })}</b> {headline}{' '}
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
  children: ReactNode;
}) {
  const t = useTranslations('approvalGate.pullRequestApproval');
  const tGate = useTranslations('approvalGate');
  const router = useRouter();
  // The in-browser path to the status rail (Bug MOTIR-5212) — a no-op outside the item page.
  const { applyOptimisticStatus } = useOptimisticStatusWriter();

  // The gate as this frame knows it: the server's, until this reader decides — then the row
  // the response returned. A DIFFERENT gate from the server (a withdrawal and a fresh raise
  // arrived on a refresh) replaces it, because it is a different question.
  const [decided, setDecided] = useState<ApprovalGateDTO | null>(null);
  const gate = decided && decided.id === read.gate.id ? decided : read.gate;
  const [pressing, setPressing] = useState(false);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, PressOutcome>>(new Map());
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());

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

  async function retryMember(subjectVersion: string, pullRequestId: string) {
    if (!actions) return;
    setRetrying((prev) => new Set(prev).add(subjectVersion));
    try {
      const result = await actions.retryMember({
        approvalGateId: gate.id,
        pullRequestId,
        identifier: itemIdentifier,
      });
      // ONLY THAT ROW: a retry reports one member, and the others keep what they showed.
      setOutcomes((prev) =>
        new Map(prev).set(
          subjectVersion,
          result.ok
            ? pressOutcomeOf(result.member)
            : { outcome: 'refused', refusal: result.refusal, pullRequestId },
        ),
      );
      if (result.ok) router.refresh();
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(subjectVersion);
        return next;
      });
    }
  }

  function retryFor(member: MemberVersion, pullRequestId: string | null) {
    return {
      onRetry:
        read.canDecide && actions && pullRequestId
          ? () => void retryMember(member.subjectVersion, pullRequestId)
          : null,
      retrying: retrying.has(member.subjectVersion),
    };
  }

  function outcomeFor(member: MemberVersion): RowMergeOutcome | null {
    if (pressing) return { kind: 'merging' };
    const pressed = outcomes.get(member.subjectVersion);
    if (pressed) {
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
    if (gate.state !== 'approved') return null;
    const fact = read.members?.find((m) => m.subjectVersion === member.subjectVersion);
    if (!fact) return null;
    if (fact.queued) return { kind: 'queued' };
    // MOTIR-5613: a retry is offered by the pull request under the card's own gate — there
    // is no second gate to press. The row's copy is MOTIR-5615's.
    if (fact.retryable) {
      return { kind: 'notMergedYet', ...retryFor(member, fact.pullRequestId) };
    }
    return null;
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
        result = await actions.approveAndMerge({ gateId: gate.id, identifier: itemIdentifier });
      } finally {
        setPressing(false);
      }
      // A refusal of the APPROVAL applies nothing: no merge was attempted.
      if (!result.ok) return result.refusal;
      setDecided(result.gate);
      setOutcomes(new Map(result.members.map((m) => [m.subjectVersion, pressOutcomeOf(m)])));
      // The rail, in the browser, from the status the decision RECORDED writing (MOTIR-5212).
      applyOptimisticStatus(result.gate.outcomeRef);
      router.refresh();
      return null;
    }
    const result = await actions.decide({ gateId: gate.id, decision, identifier: itemIdentifier });
    if (!result.ok) return result.refusal;
    setDecided(result.gate);
    applyOptimisticStatus(result.gate.outcomeRef);
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
  const subjectMeta =
    count === 0
      ? runLabel
      : gate.state === 'superseded'
        ? moved.length > 0
          ? t('meta.withdrawn', { count, pr: nameList(moved.map(nameOf)) })
          : t('meta.withdrawnSet', { count })
        : gate.state === 'approved'
          ? decidedByThisReader
            ? t('meta.approvedByYou', { count })
            : gate.decidedByLabel
              ? t('meta.approved', { name: gate.decidedByLabel, count })
              : t('meta.count', { count })
          : gate.state === 'awaiting' && runLabel
            ? t('meta.delivered', { count, run: runLabel })
            : t('meta.count', { count });

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
        },
      ]
    : [];
  // One or two pull requests are NAMED; three or more are COUNTED, because band 3 is one line
  // and an unbounded list pushes the verbs off the frame. The confirm step names every one.
  const consequence =
    actions && count > 0
      ? count <= 2
        ? t('consequence.named', { prs: nameList(members.map(nameOf)), key: itemIdentifier })
        : t('consequence.counted', { count, key: itemIdentifier })
      : null;
  const confirmConsequences = actions
    ? [
        t('confirm.records', { count }),
        ...members.map((member) => t('confirm.mergeOrQueue', { pr: nameOf(member) })),
        t('confirm.movesToApproved', { key: itemIdentifier }),
      ]
    : [];

  // State `H` for a MEMBER: the approval stands, and the refusal is named in place.
  const refused = members.flatMap((member) => {
    const pressed = outcomes.get(member.subjectVersion);
    return !pressing && pressed?.outcome === 'refused'
      ? [{ member, refusal: pressed.refusal }]
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
          {refused.map(({ member, refusal }) => (
            <RefusedMemberLine
              key={member.subjectVersion}
              name={nameOf(member)}
              refusal={refusal}
            />
          ))}
          <span className="block text-(--el-text-secondary)">
            {mergedNames.length > 0
              ? t('refused.stands', { other: nameList(mergedNames) })
              : t('refused.standsAlone')}
          </span>
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
  const recordDetail =
    gate.state === 'approved' && count > 0 ? (
      <>
        <span>{t('record.commits', { count })}</span>
        {why ? <span>{why}</span> : null}
      </>
    ) : null;

  return (
    <MergeOutcomeProvider value={rowOutcomes}>
      {/* Out of the card body's padding, so the frame's bands meet the card's edges. */}
      <div className="-mx-(--spacing-card-padding) -mb-(--spacing-card-padding) overflow-hidden rounded-b-(--radius-card) border-t border-(--el-border-soft)">
        <ApprovalGateControl
          layout="flush"
          // ⚠️ THE VERSION IS NOT HANDED TO THE RECORD STRIP. The frame prints the first eight
          // characters of `subjectVersion`, which names a design's commit — and would print
          // `moooon/m` for a set. The set is named in band 1 and counted in `recordDetail`;
          // the audit column itself is untouched.
          gate={{ ...gate, subjectVersion: null }}
          canDecide={read.canDecide}
          kindLabel={t('kindLabel')}
          subjectMeta={subjectMeta}
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
          withdrawnPort={{
            port:
              moved.length > 0
                ? t('withdrawn.port', { pr: nameList(moved.map(nameOf)) })
                : t('withdrawn.portSet'),
            cite: t('withdrawn.portCite'),
          }}
          onDecide={onDecide}
        />
      </div>
    </MergeOutcomeProvider>
  );
}
