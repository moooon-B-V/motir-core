'use client';

import { Fragment, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { GitMerge, Lock, ScanEye, Sparkles } from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { planRowDestination } from '@/lib/planning/planDestination';
import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';
import type { PlanHoldDTO } from '@/lib/dto/plans';

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
// A PLAN HOLD (Story MOTIR-6017 · MOTIR-6267), built to the delta
// `design/work-items/status-held-by-decision--plan-hold.mock.html` and its § _The
// status control says a PLAN holds it_: a new line SHAPE in this same box, drawn
// FIRST — the refusal, then what the plan is doing, then **Review plan**, which
// goes where `planRowDestination` sends the plan (the planning surface for a plan
// with a session, `/plans/<id>` for one without) and NEVER opens the approval
// overlay (ADR `approval-gates.md` §11.5b). It shows to a reader who cannot edit
// too: it decides nothing, it goes and looks. While a plan holds, a gate's line
// says it can be decided once the plan is, with NO button — deciding it is itself
// refused while the plan holds (AMENDMENT 21 §6).
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
  /** The undecided plan holding the card at Planning, or null / absent. */
  plan?: PlanHoldDTO | null;
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

/** The plan's door — where `planRowDestination` sends it. The planning surface is
 *  an overlay over THIS page, written with `shallowPush` so Close returns here; the
 *  plan page is an ordinary link. */
function ReviewPlanLink({ plan }: { plan: PlanHoldDTO }) {
  const t = useTranslations('approvalGate.statusHeld');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qs = searchParams?.toString() ?? '';
  const destination = planRowDestination({
    planStatus: plan.planStatus,
    planId: plan.planId,
    sessionId: plan.sessionId,
    host: `${pathname}${qs ? `?${qs}` : ''}`,
    anchorKey: plan.anchorKey,
  });
  const className = buttonVariants({ variant: 'primary', size: 'sm' });
  const content = (
    <>
      <Sparkles aria-hidden className="h-3.5 w-3.5" />
      {t('reviewPlan')}
    </>
  );
  if (destination.kind === 'plan-page') {
    return (
      <Link href={destination.href} data-plan-door={destination.kind} className={className}>
        {content}
      </Link>
    );
  }
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    // A modified or non-primary click keeps the real href (a new tab).
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    shallowPush(destination.href);
  }
  return (
    <a
      href={destination.href}
      onClick={onClick}
      data-plan-door={destination.kind}
      className={className}
    >
      {content}
    </a>
  );
}

export function StatusHeldNotice({ itemKey, lines, plan = null }: StatusHeldNoticeProps) {
  const t = useTranslations('approvalGate.statusHeld');
  if (lines.length === 0 && !plan) return null;

  const strong = (chunks: ReactNode) => <strong className="font-semibold">{chunks}</strong>;

  return (
    <div
      role="status"
      data-testid="status-held-notice"
      className="flex w-full flex-col gap-2 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-tint-yellow) px-(--spacing-control-x) py-(--spacing-control-y)"
    >
      {plan ? (
        <div className="flex items-start gap-2" data-waiting-on="plan">
          <Lock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-text-strong)" />
          <div className="flex min-w-0 flex-col items-start gap-2">
            <p className="m-0 text-[13px] leading-snug text-(--el-text-strong)">{t('planHeld')}</p>
            <p className="m-0 mt-0.5 text-xs leading-snug text-(--el-text-secondary)">
              {t(`planState.${plan.planStatus}`)}
            </p>
            <ReviewPlanLink plan={plan} />
          </div>
        </div>
      ) : null}
      {lines.map((line, index) => {
        const decision = t(`decisionNoun.${line.kind}`);
        const { key, values } = heldSentence(line, decision);
        // Under a plan, a decision line says it waits on the plan too, and carries
        // no door — deciding the gate is refused while the plan holds.
        const behindPlan = plan !== null && line.waitingOn === 'decision';
        const text: ReactNode = behindPlan
          ? t.rich('planAndGate', { decision, strong })
          : t.rich(key, { ...values, strong });
        const withDoor = !plan && line.waitingOn === 'decision' && line.canDecide;
        const Glyph = line.waitingOn === 'merge' ? GitMerge : Lock;
        return (
          <Fragment key={line.statusKey}>
            {index > 0 || plan ? <hr aria-hidden className="border-(--el-border-soft)" /> : null}
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
