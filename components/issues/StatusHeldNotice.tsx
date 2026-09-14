'use client';

import { Fragment, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { GitMerge, Lock, ScanEye } from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';

// THE STATUS CONTROL SAYS SO (Story MOTIR-4887 · Subtask MOTIR-5528), built to
// `design/work-items/status-held-by-decision.mock.html` and its § _The status
// control says so_ in `design/work-items/design-notes.md`.
//
// ONE box under the status value, ONE line per held status. A line waits on a
// DECISION (the lock) or on a MERGE (git-merge) — ADR `approval-gates.md` §6d
// AMENDMENT rules 1 and 2b decide which, and this component draws what the read
// (`approvalGatesService.listHeldTransitions`) or a refusal payload says:
//
//   · a `decision` line with `canDecide` carries **Review & approve** — a LINK to
//     the current page with the overlay address added, written with `shallowPush`
//     so the full-screen overlay opens over whatever page holds the control and
//     Close returns there;
//   · a `decision` line a reader may only look at names whom it waits on, or —
//     when no gate has been raised yet — says the approval is asked for once the
//     pull request's checks pass;
//   · a `merge` line NEVER carries a button: merging the pull request moves it.
//
// Presentational: no fetch, no status write. The surfaces own the read and the
// refusal that feeds it.

export interface StatusHeldLine {
  statusKey: string;
  /** The held target's own label, for `{status}`. */
  statusLabel: string;
  waitingOn: 'decision' | 'merge';
  kind: ApprovalGateKindDTO;
  gateRaised: boolean;
  canDecide: boolean;
  routedToLabel: string | null;
}

/**
 * WHICH sentence a held line reads, and its values — the one statement of the
 * choice, shared by this component (rich text) and the board's `aria-live`
 * announcement (plain text), so the two can never say different things.
 */
export function heldSentence(
  line: Pick<
    StatusHeldLine,
    'waitingOn' | 'gateRaised' | 'canDecide' | 'routedToLabel' | 'statusLabel'
  >,
  decision: string,
): {
  key: 'merge' | 'decisionNotRaised' | 'decisionSeeOnly' | 'decision';
  values: Record<string, string>;
} {
  const status = line.statusLabel;
  if (line.waitingOn === 'merge') return { key: 'merge', values: { status } };
  if (!line.gateRaised) return { key: 'decisionNotRaised', values: { status, decision } };
  if (!line.canDecide && line.routedToLabel) {
    return { key: 'decisionSeeOnly', values: { status, decision, name: line.routedToLabel } };
  }
  return { key: 'decision', values: { status, decision } };
}

export interface StatusHeldNoticeProps {
  itemKey: string;
  lines: StatusHeldLine[];
}

/** The door — its own component so the URL hooks run only where a door is drawn
 *  (a surface with nothing held reads no navigation state at all). */
function ReviewAndApproveLink({ itemKey, kind }: { itemKey: string; kind: ApprovalGateKindDTO }) {
  const t = useTranslations('approvalGate.statusHeld');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qs = searchParams?.toString() ?? '';
  const href = withApprovalOverlay(`${pathname}${qs ? `?${qs}` : ''}`, { itemKey, kind });
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        shallowPush(href);
      }}
      className={buttonVariants({ variant: 'primary', size: 'sm' })}
    >
      <ScanEye aria-hidden className="h-3.5 w-3.5" />
      {t('reviewAndApprove')}
    </a>
  );
}

export function StatusHeldNotice({ itemKey, lines }: StatusHeldNoticeProps) {
  const t = useTranslations('approvalGate.statusHeld');
  if (lines.length === 0) return null;

  const strong = (chunks: ReactNode) => <strong className="font-semibold">{chunks}</strong>;

  return (
    <div
      role="status"
      data-testid="status-held-notice"
      className="flex w-full flex-col gap-2 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-tint-yellow) px-(--spacing-control-x) py-(--spacing-control-y)"
    >
      {lines.map((line, index) => {
        const { key, values } = heldSentence(line, t(`decisionNoun.${line.kind}`));
        const text: ReactNode = t.rich(key, { ...values, strong });
        const withDoor = line.waitingOn === 'decision' && line.canDecide;
        const Glyph = line.waitingOn === 'merge' ? GitMerge : Lock;
        return (
          <Fragment key={line.statusKey}>
            {index > 0 ? <hr aria-hidden className="border-(--el-border-soft)" /> : null}
            <div className="flex items-start gap-2" data-waiting-on={line.waitingOn}>
              <Glyph aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-text-strong)" />
              <div className="flex min-w-0 flex-col items-start gap-2">
                <p className="m-0 text-[13px] leading-snug text-(--el-text-strong)">{text}</p>
                {withDoor ? <ReviewAndApproveLink itemKey={itemKey} kind={line.kind} /> : null}
              </div>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
