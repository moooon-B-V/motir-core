'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { useRefusalCopy } from '@/components/approvals/ApprovalGateControl';
import { useOptimisticStatusWriter } from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';
import type { queueAgainAutoAction } from '@/app/(authed)/items/[key]/approvalGateActions';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import type { PullRequestStandingExitDTO } from '@/lib/dto/approvalGate';
import { MergeOutcomeProvider, rowKey, type RowMergeOutcome } from './MergeOutcomeSlot';
import { QueueExitLine } from './QueueExitLine';

// THE MERGE-QUEUE PART OF AN `auto` CARD (Story MOTIR-5461 · MOTIR-5635;
// `design/github/design-notes.md` § 22, `approve-and-merge--ejected.mock.html` E5).
//
// An `auto` project raises no approval gate, so there is no frame to draw the exit in.
// The block is § 20's rows, and the exit is a FLUSH PART — a soft rule and an `h4`, § 21's
// grammar — between the rows' caption and How to test. The rows read their outcome from the
// same context the frame provides, so a row reads *Left the queue* here exactly as it does
// under a gate.
//
// ⚠️ *QUEUE AGAIN* IS A PERSON'S PRESS, offered to anyone who may edit the card — the item
// page's shipped `canEdit` — and only while the pull request is still at the head it left
// at. It re-sends the automatic merge for those commits (decision 5). The rail moves to
// In Review at once after a failure, and a refusal takes it back.

export interface AutoQueueExits {
  workItemId: string;
  exits: PullRequestStandingExitDTO[];
  /** Whether the viewer may edit the card — the only readers offered *Queue again*. */
  canEdit: boolean;
  /** The item page's action; omitted by a read-only host, which then offers no press. */
  queueAgain?: typeof queueAgainAutoAction;
}

type Pressed = { kind: 'queued' } | { kind: 'refused'; refusal: GateRefusal };

function RefusedLine({ name, refusal }: { name: string; refusal: GateRefusal }) {
  const t = useTranslations('approvalGate.pullRequestApproval');
  const { headline, nextAction } = useRefusalCopy(refusal);
  return (
    <span className="block">
      <b>{t('requeue.refusedTitle', { pr: name })}</b> {headline}{' '}
      <span className="text-(--el-text-secondary)">{nextAction}</span>
    </span>
  );
}

export function QueueExitAutoPart({
  read,
  itemIdentifier,
  rows,
  children,
}: {
  read: AutoQueueExits;
  itemIdentifier: string;
  /** The rows and their caption — they read the outcomes this part provides. */
  rows: ReactNode;
  /** Whatever follows the part — How to test. */
  children?: ReactNode;
}) {
  const t = useTranslations('approvalGate.pullRequestApproval');
  const router = useRouter();
  const { applyOptimisticStatus, clearOptimisticStatus } = useOptimisticStatusWriter();
  const [pressing, setPressing] = useState<ReadonlySet<string>>(new Set());
  const [pressed, setPressed] = useState<ReadonlyMap<string, Pressed>>(new Map());

  const nameOf = (exit: PullRequestStandingExitDTO) => `${exit.repo} · #${exit.number}`;
  const canPress = read.canEdit && read.queueAgain !== undefined;

  async function queueAgain(exit: PullRequestStandingExitDTO) {
    if (!read.queueAgain) return;
    const id = exit.pullRequestId;
    const failure = exit.exit.disposition === 'failure';
    setPressing((prev) => new Set(prev).add(id));
    if (failure) applyOptimisticStatus('in_review');
    try {
      const result = await read.queueAgain({
        workItemId: read.workItemId,
        pullRequestId: id,
        identifier: itemIdentifier,
      });
      if (result.ok) {
        applyOptimisticStatus(result.status);
        setPressed((prev) => new Map(prev).set(id, { kind: 'queued' }));
        router.refresh();
      } else {
        if (failure) clearOptimisticStatus();
        setPressed((prev) => new Map(prev).set(id, { kind: 'refused', refusal: result.refusal }));
      }
    } finally {
      setPressing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const rowOutcomes = new Map<string, RowMergeOutcome>();
  const standing: PullRequestStandingExitDTO[] = [];
  for (const exit of read.exits) {
    const key = rowKey(exit.repo, exit.number);
    if (pressed.get(exit.pullRequestId)?.kind === 'queued') {
      rowOutcomes.set(key, { kind: 'queued' });
      continue;
    }
    standing.push(exit);
    if (!exit.requeueable) {
      rowOutcomes.set(key, { kind: 'newCommits' });
      continue;
    }
    rowOutcomes.set(key, {
      kind: exit.exit.disposition === 'failure' ? 'leftQueue' : 'removedFromQueue',
      onQueueAgain: canPress ? () => void queueAgain(exit) : null,
      queueing: pressing.has(exit.pullRequestId),
    });
  }
  const bold = (chunks: ReactNode) => <b className="font-semibold text-(--el-text)">{chunks}</b>;
  const refused = read.exits.flatMap((exit) => {
    const p = pressed.get(exit.pullRequestId);
    return p?.kind === 'refused' ? [{ exit, refusal: p.refusal }] : [];
  });

  return (
    <MergeOutcomeProvider value={rowOutcomes}>
      {rows}
      {standing.length > 0 ? (
        <div
          role="group"
          aria-label={t('exit.partTitle')}
          className="mt-4 flex min-w-0 flex-col gap-2 border-t border-(--el-border-soft) pt-4 text-[13px] text-(--el-text)"
        >
          <h4 className="text-sm font-semibold text-(--el-text)">{t('exit.partTitle')}</h4>
          {standing.map((exit) => (
            <QueueExitLine
              key={exit.pullRequestId}
              name={nameOf(exit)}
              exit={exit.exit}
              sub={exit.requeueable ? t.rich('exit.auto', { b: bold }) : t('exit.newCommits')}
            />
          ))}
          {refused.length > 0 ? (
            <div
              role="alert"
              className="flex gap-2.5 rounded-(--radius-card) bg-(--el-tint-peach) px-3 py-2.5"
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 flex-none text-(--el-danger-on-surface)"
                aria-hidden
              />
              <p className="leading-snug text-(--el-text-strong)">
                {refused.map(({ exit, refusal }) => (
                  <RefusedLine key={exit.pullRequestId} name={nameOf(exit)} refusal={refusal} />
                ))}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
    </MergeOutcomeProvider>
  );
}
