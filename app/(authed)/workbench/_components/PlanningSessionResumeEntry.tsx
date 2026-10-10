'use client';

import { Children, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { PlanOverlayDoor } from '@/components/planning/PlanOverlayDoor';
import { planSentenceOf } from '@/lib/planning/planSentence';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { resumePlanSession } from '@/lib/planning/planChangeClient';
import { usePeekRowClick } from '@/app/(authed)/items/_components/IssueQuickView';
import { useRelativeLabel } from '@/components/approvals/useRelativeLabel';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import type { ToResumePlanningSessionDto } from '@/lib/dto/home';
import {
  entryControlsOf,
  refusalEndsWaiting,
  resumeRefusalKeyOf,
  type ResumeRefusalKey,
} from './planningSessionWords';
import { PlanningSessionFormBody, useLeftLine } from './PlanningSessionResumeForms';

// ONE FAILED PLANNING SESSION, as a To resume entry (Story MOTIR-7905 · MOTIR-7917;
// design `design/workbench/design-notes.md` § 37.2, mock
// `workbench--planning-session-needs-you.mock.html` Panels 5–10).
//
// ⚠️ IT COMPOSES THE ENTRY FRAME, NOT `WorkbenchRow`'s CARD COLUMNS. A session is not a
// work item: no key column, no assignee, no status, and no `motir continue`. Line 1 is
// § 29's plan leading line + the state pill + *failed {when}*; line 2 is WHERE THE WALK
// STOPPED in the progress line's step words, WHY in words (the stable code, translated),
// and *N of M written*. Actions: **Resume** (primary) and **Open**.
//
// ⚠️ THE STATE IS DERIVED, NOT STORED, so a re-read cannot strand it:
//   · *waiting* — the default;
//   · *resuming* — Resume was pressed for THIS failure (`resumedFor === failure.failedAt`).
//     The entry is HELD in place by the list (§ 26 / § 35.5) until a refresh drops it. A
//     failure with a newer `failedAt` is a different failure: the note clears and the entry
//     is waiting again — that is *failed again*;
//   · *failed again* — `failedAt` is newer than the one this reader first saw, so a quiet
//     *Second attempt* note shows (earlier reasons are not listed: one failure is the thing
//     to act on);
//   · *could not start* — a refusal in words, per code. `RESUME_ALREADY_STARTED` is no
//     error: it reads as resuming. `ended` / `notFailed` hold the row and ask the list to
//     re-read.
//
// ⚠️ THREE FORMS, ONE FRAME (MOTIR-7940). The body under the frame is
// `PlanningSessionResumeForms.tsx`'s, switched on the SERVER's `form`; a failure beside a
// waiting plan and a session that ended `failed` before this story offer Open only — a Resume
// on either would be refused.

export function PlanningSessionResumeEntry({
  entry,
  arrived,
  held,
  onSettled,
}: {
  entry: ToResumePlanningSessionDto;
  arrived: boolean;
  /** The list dropped it from the read — HELD in place with its reason (§ 26). */
  held: boolean;
  /** Called when a refusal means the session is no longer waiting: the list should re-read. */
  onSettled: () => void;
}) {
  const routes = useReaderRoutes();
  const locale = useLocale();
  const t = useTranslations('workbench.planningSession');
  const tPlan = useTranslations('approvalGate.planApproval.row');
  const tWorkbench = useTranslations('workbench');
  const relativeLabel = useRelativeLabel();
  const peekRowClick = usePeekRowClick();

  const failure = entry.failure;
  const failedAt = failure?.failedAt ?? null;
  // The first failure this reader saw on this entry — a newer one is *failed again*.
  const [firstSeenFailedAt] = useState(failedAt);
  const [resumedFor, setResumedFor] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Exclude<ResumeRefusalKey, 'alreadyStarted'> | null>(null);
  const inFlight = useRef(false);

  const canResume = entryControlsOf(entry.form).resume;
  const resuming = failedAt !== null && resumedFor === failedAt;
  const failedAgain =
    failedAt !== null && firstSeenFailedAt !== null && failedAt > firstSeenFailedAt;
  const sessionGone = refusal !== null && refusalEndsWaiting(refusal);

  async function onResume() {
    if (inFlight.current || resuming || failedAt === null) return;
    inFlight.current = true;
    setRefusal(null);
    try {
      await resumePlanSession(entry.sessionId);
      setResumedFor(failedAt);
    } catch (err) {
      const code = err instanceof PlanEditsClientError ? err.code : null;
      const status = err instanceof PlanEditsClientError ? err.status : null;
      const key = resumeRefusalKeyOf(code, status);
      // A concurrent Resume won: the walk IS resuming, so this reads as resuming.
      if (key === 'alreadyStarted') setResumedFor(failedAt);
      else {
        setRefusal(key);
        if (refusalEndsWaiting(key)) onSettled();
      }
    } finally {
      inFlight.current = false;
    }
  }

  const sentence = planSentenceOf({
    targets: entry.targets,
    title: entry.title,
    projectName: entry.projectName,
  });
  const sentenceText = tPlan.markup(sentence.form, {
    name: sentence.name,
    project: sentence.name,
    title: (chunks: string) => chunks,
  });
  const dim = held || resuming || sessionGone;
  const titleInk = dim ? 'text-(--el-text-secondary)' : 'text-(--el-text)';
  const parts: ReactNode = tPlan.rich(sentence.form, {
    name: sentence.name,
    project: sentence.name,
    title: (chunks) =>
      sentence.form === 'targeted' ? (
        <Link
          key="title"
          href={routes.item(sentence.key)}
          onClick={(e) => peekRowClick(e, sentence.key)}
          className={cn(
            'relative z-10 min-w-0 truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none',
            titleInk,
          )}
        >
          {chunks}
        </Link>
      ) : (
        <span key="title" className={cn('min-w-0 truncate font-medium', titleInk)}>
          {chunks}
        </span>
      ),
  });
  const keys = entry.targets.map((target) => target.key);

  // Form A opens its `generating` plan; B and C open the plan that WAITS, at its own state.
  const known = {
    planStatus:
      entry.form === 'failed_walk'
        ? ('generating' as const)
        : (entry.waitingPlan?.status ?? ('planned' as const)),
    sessionId: entry.sessionId,
    anchorKey: entry.targets[0]?.key ?? null,
  };
  // The planId is the door's key. A session that wrote no plan is opened by the session, so
  // its id stands in: with `known` supplied the door never reads it as a plan.
  const doorPlanId = entry.planId ?? entry.sessionId;

  const leftLine = useLeftLine(entry, held && !resuming);

  return (
    <div
      role="row"
      data-testid={`to-resume-session-${entry.sessionId}`}
      data-held={held || resuming ? 'true' : undefined}
      data-state={resuming ? 'resuming' : failedAgain ? 'failed-again' : 'waiting'}
      className={cn(
        'relative flex flex-col gap-1 border-b border-(--el-border) px-4 py-2.5 last:border-b-0',
        'hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2',
      )}
    >
      <div role="presentation" className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div role="cell" className="flex min-w-0 flex-1 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
          <span className="flex min-w-0 items-center gap-1 text-sm">
            {Children.toArray(parts).map((part, index) =>
              typeof part === 'string' ? (
                part.trim() === '' ? null : (
                  <span key={`frame-${index}`} className="shrink-0 text-(--el-text-secondary)">
                    {part}
                  </span>
                )
              ) : (
                part
              ),
            )}
          </span>
          {keys.length > 0 ? (
            <span
              className="shrink-0 font-mono text-xs text-(--el-text-secondary)"
              title={keys.length > 1 ? keys.join(', ') : undefined}
            >
              {keys.length > 1
                ? `${keys[0]} ${tPlan('moreTargets', { count: keys.length - 1 })}`
                : keys[0]}
            </span>
          ) : null}
          {arrived ? <Pill tone="neutral">{tWorkbench('live.new')}</Pill> : null}
          {failedAgain && !resuming ? <Pill tone="neutral">{t('second')}</Pill> : null}
          {entry.form === 'ended_with_waiting_plan' ? (
            // CALM, not Closed's warning peach: the plan is waiting, not lost (design § 38).
            <Pill tone="neutral">{t('form.c.chip')}</Pill>
          ) : (
            <Pill tone="awaiting">{resuming ? t('resuming') : t('waitingToResume')}</Pill>
          )}
          {failedAt && entry.form === 'failed_walk' ? (
            <span
              className="shrink-0 text-xs text-(--el-text-secondary)"
              title={new Date(failedAt).toLocaleString(locale)}
            >
              {t('failedAt', { when: relativeLabel(failedAt) })}
            </span>
          ) : null}
        </div>
        <div role="cell" className="flex shrink-0 items-center gap-2">
          {canResume && !sessionGone ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={resuming}
              onClick={() => void onResume()}
              data-testid="to-resume-session-resume"
            >
              {resuming ? t('resuming') : t('resume')}
            </Button>
          ) : null}
          <PlanOverlayDoor
            planId={doorPlanId}
            known={known}
            via="resume"
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            data-testid="to-resume-session-open"
            aria-label={t('openAria', { sentence: sentenceText })}
          >
            {t('open')}
          </PlanOverlayDoor>
        </div>
      </div>

      <PlanningSessionFormBody entry={entry} />

      {leftLine !== null ? (
        <p role="status" className="text-xs text-(--el-text-secondary)">
          {t(`left.${leftLine}`)}
        </p>
      ) : null}
      {resuming ? (
        <p role="status" className="text-xs text-(--el-text-secondary)">
          {t('resumingNote')}
        </p>
      ) : null}
      {refusal !== null ? (
        <p role="alert" className="text-xs text-(--el-text)">
          <span className="font-medium">{t('couldNot')}</span> {t(`refusal.${refusal}`)}
        </p>
      ) : null}
    </div>
  );
}
