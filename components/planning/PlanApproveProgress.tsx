'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { TimerOff } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';

// WHAT APPROVE SAYS WHILE IT RUNS (Subtask MOTIR-5249; design of record
// `design/ai-planning/design-notes.md` Part XXV, `plan-review--approve-progress.mock.html`).
//
// One presentational surface, mounted by the planning overlay's TWO approve doors —
// the canvas confirm bar (`place="bar"`) and the rail's review block (`place="rail"`).
// It reads nothing: no fetch, no router, no search params. Everything it draws comes
// from its five props (§25.4), so a host mounts it rather than rebuilding it.
//
// It has TWO states, not four (§25.4): `running` covers *creating* and *still going*
// — the component owns the timer between them — and `timedOut` is the one refusal
// that can promise nothing was written. *Failed otherwise* is the shipped
// conversation bubble, unchanged, so there is no `failed` state to reach.

/**
 * The still-going line appears this long after the press — Part XXV §25.3: above the
 * measured ordinary approve (~5 s), before the 10 s point where attention leaves a
 * wait that shows no progress, and far from the ~40 s budget ceiling. Owned HERE so
 * no host can pick a different number; measured on the client, from mount.
 */
export const APPROVE_SLOW_AFTER_MS = 8_000;

export type PlanApproveProgressState = 'running' | 'timedOut';
export type PlanApproveProgressKind = 'adds' | 'changes';
export type PlanApproveProgressPlace = 'rail' | 'bar';

export interface PlanApproveProgressProps {
  state: PlanApproveProgressState;
  /** The review's own item count — every proposal, not only the adds. */
  count: number;
  /** `adds` when every proposal is an add; `changes` when any is a modify or remove. */
  kind: PlanApproveProgressKind;
  place: PlanApproveProgressPlace;
  /** Whether this instance is the live region. Exactly one mounted instance announces:
   *  the one at the door that was pressed; the mirror passes `false`. */
  announce?: boolean;
}

/** What a door is handed: everything but its own `place`, which the door knows.
 *  `null` means the approve is not running and did not time out at this door. */
export type PlanApproveProgressView = Omit<PlanApproveProgressProps, 'place'>;

export function PlanApproveProgress({
  state,
  count,
  kind,
  place,
  announce = true,
}: PlanApproveProgressProps) {
  if (state === 'timedOut') return <TimedOutBand place={place} announce={announce} />;
  return <Running count={count} kind={kind} place={place} announce={announce} />;
}

function Running({
  count,
  kind,
  place,
  announce,
}: {
  count: number;
  kind: PlanApproveProgressKind;
  place: PlanApproveProgressPlace;
  announce: boolean;
}) {
  const t = useTranslations('planReview.approveProgress');
  // The threshold runs from MOUNT, which is the press: the host mounts this exactly
  // while the decision is in flight.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), APPROVE_SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  const upper = kind === 'adds' ? t('creating', { n: count }) : t('applying', { n: count });
  const lower = slow ? t('slow') : t('together');
  // The words are the announcement; the ring is decoration and stops under reduced
  // motion (§25.6) — this use only, the package primitive is left alone.
  const spinner = (
    <Spinner
      size="sm"
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-(--el-accent-on-surface) motion-reduce:animate-none"
    />
  );
  const live = announce
    ? ({ role: 'status', 'aria-live': 'polite' } as const)
    : ({ 'aria-hidden': true } as const);

  if (place === 'bar') {
    // The bar's own two-line grammar, rendered INSIDE the bar the host already has,
    // so its height and position do not change (§25.7).
    return (
      <div
        data-testid="plan-approve-progress"
        data-place="bar"
        data-slow={slow ? 'true' : 'false'}
        {...live}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        {spinner}
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold wrap-anywhere text-(--el-text)">{upper}</span>
          {/* Wraps rather than truncates: "no need to press again" is the sentence
              that matters on a narrow pane (§25.7). */}
          <span className="text-xs text-(--el-text-secondary)">{lower}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="plan-approve-progress"
      data-place="rail"
      data-slow={slow ? 'true' : 'false'}
      {...live}
      className="flex flex-col gap-2"
    >
      <div className="flex min-h-(--height-btn-md) items-center gap-2.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)">
        {spinner}
        <span className="min-w-0 text-sm font-semibold wrap-anywhere text-(--el-text)">
          {upper}
        </span>
      </div>
      <p className="text-center text-xs text-(--el-text-secondary)">{lower}</p>
    </div>
  );
}

/**
 * TIMED OUT — `PLAN_APPROVE_TIMED_OUT` (§25.2). The shipped stale band's grammar —
 * container, tint, placement — told apart by its glyph and its sentence: nothing was
 * written, and deciding again is safe.
 */
function TimedOutBand({ place, announce }: { place: PlanApproveProgressPlace; announce: boolean }) {
  const t = useTranslations('planReview.approveProgress');
  const body = (
    <>
      <TimerOff className="mt-px size-3.5 flex-none" aria-hidden="true" />
      <span>
        <span className="font-semibold">{t('timedOutTitle')}</span> {t('timedOutNext')}
      </span>
    </>
  );
  const role = announce ? 'alert' : undefined;
  return place === 'bar' ? (
    <div
      role={role}
      data-testid="plan-approve-timed-out"
      data-place="bar"
      className="flex items-start gap-2 border-t border-(--el-border) bg-(--el-tint-yellow) px-4 py-2.5 text-xs leading-relaxed text-(--el-text-strong)"
    >
      {body}
    </div>
  ) : (
    <p
      role={role}
      data-testid="plan-approve-timed-out"
      data-place="rail"
      className="flex items-start gap-1.5 rounded-(--radius-control) bg-(--el-tint-yellow) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
    >
      {body}
    </p>
  );
}
