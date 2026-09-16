'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { CircleEllipsis, CircleX, Clock, GitMerge, GitPullRequestArrow } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { parseMemberVersion } from '@/lib/approvalGates/memberVersion';
import type { PullRequestApprovalMemberDTO } from '@/lib/dto/approvalGate';

// A PULL-REQUEST ROW'S SECOND PILL SLOT, after Approve and merge (Story MOTIR-4909 ·
// MOTIR-5484; `design/github/design-notes.md` §20 *The verbs and their states*, decision
// *where a row's outcome shows*).
//
// ⚠️ THE ROW STAYS `PullRequestRow`, DERIVED AND UNCHANGED (§19). The rows are rendered on
// the SERVER, inside the approval frame's port, and the press's outcome lives in the
// frame's CLIENT state. So the frame provides the outcomes through context, and this slot —
// a client leaf inside each server-rendered row — reads its own. The quick view, which draws
// no frame, provides the persisted half through `PersistedMergeOutcomes` (Bug MOTIR-5650).
// With no provider (the frame before anything was pressed, a card with no approved gate) it
// renders exactly what it was handed: the row's CI pill.
//
// ⚠️ IT REPLACES THE CI PILL, IT DOES NOT SIT BESIDE IT. Every member was green by
// construction (decision 3), so after the press the CI pill has nothing left to say, and the
// slot says what happened instead.

/** What one row shows once the frame has something to report about it. */
export type RowMergeOutcome =
  | { kind: 'merging' }
  | { kind: 'merged' }
  | { kind: 'queued' }
  | {
      kind: 'refused' | 'notMergedYet';
      /** Retry this member's merge; `null` for a reader who may not decide. */
      onRetry: (() => void) | null;
      retrying: boolean;
    };

const MergeOutcomeContext = createContext<ReadonlyMap<string, RowMergeOutcome> | null>(null);

/** A row's identity — `owner/name#number`, case-insensitive on the repository, as
 *  `mergePullRequestRows` identifies a pull request. */
export function rowKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

export function MergeOutcomeProvider({
  value,
  children,
}: {
  value: ReadonlyMap<string, RowMergeOutcome>;
  children: ReactNode;
}) {
  return <MergeOutcomeContext.Provider value={value}>{children}</MergeOutcomeContext.Provider>;
}

/**
 * What a RELOAD still knows about one member of an approved set (MOTIR-5484) — the one
 * reading of `PullRequestApprovalMemberDTO` every surface shares, so the item page's frame
 * and the quick view cannot say different things about the same row (Bug MOTIR-5650).
 * `null` when there is nothing to report and the row keeps its CI pill.
 */
export function persistedRowOutcome(
  fact: Pick<PullRequestApprovalMemberDTO, 'queued' | 'retryable'>,
): 'queued' | 'notMergedYet' | null {
  if (fact.queued) return 'queued';
  if (fact.retryable) return 'notMergedYet';
  return null;
}

/**
 * The READ-ONLY provider (Bug MOTIR-5650) — the quick view has no approval frame, and must
 * still show what a reload of the item page shows. It takes the members of an APPROVED gate
 * (the server reads none for any other state) and offers no Retry: the peek has no verbs.
 */
export function PersistedMergeOutcomes({
  members,
  children,
}: {
  members: readonly PullRequestApprovalMemberDTO[];
  children: ReactNode;
}) {
  const value = new Map<string, RowMergeOutcome>();
  for (const fact of members) {
    const member = parseMemberVersion(fact.subjectVersion);
    const kind = member ? persistedRowOutcome(fact) : null;
    if (!member || !kind) continue;
    value.set(
      rowKey(member.repo, member.number),
      kind === 'queued' ? { kind } : { kind, onRetry: null, retrying: false },
    );
  }
  if (value.size === 0) return <>{children}</>;
  return <MergeOutcomeProvider value={value}>{children}</MergeOutcomeProvider>;
}

export function MergeOutcomeSlot({
  repo,
  number,
  merged,
  children,
}: {
  repo: string;
  number: number;
  /** The host already says merged: the row's state pill reads *Merged*, and the slot empties. */
  merged: boolean;
  /** What the slot shows with nothing to report — the row's CI pill. */
  children?: ReactNode;
}) {
  const t = useTranslations('approvalGate.pullRequestApproval.outcome');
  const outcome = useContext(MergeOutcomeContext)?.get(rowKey(repo, number)) ?? null;
  if (!outcome) return <>{children}</>;
  if (merged) return null;

  switch (outcome.kind) {
    case 'merging':
      return (
        <Pill status="in-progress">
          <CircleEllipsis className="h-3 w-3" aria-hidden />
          {t('merging')}
        </Pill>
      );
    case 'merged':
      return (
        <Pill status="done">
          <GitMerge className="h-3 w-3" aria-hidden />
          {t('merged')}
        </Pill>
      );
    case 'queued':
      return (
        <Pill severity="warning">
          <Clock className="h-3 w-3" aria-hidden />
          {t('queued')}
        </Pill>
      );
    case 'refused':
    case 'notMergedYet':
      return (
        <>
          {outcome.kind === 'refused' ? (
            <Pill severity="danger">
              <CircleX className="h-3 w-3" aria-hidden />
              {t('refused')}
            </Pill>
          ) : (
            // Neutral, not rose: after a reload the reason is gone, and a red pill with no
            // reason beside it would assert a refusal the page can no longer explain.
            <Pill tone="neutral">
              <GitPullRequestArrow className="h-3 w-3" aria-hidden />
              {t('notMergedYet')}
            </Pill>
          )}
          {outcome.onRetry ? (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={outcome.retrying}
              onClick={outcome.onRetry}
            >
              {t('retry')}
            </Button>
          ) : null}
        </>
      );
  }
}
