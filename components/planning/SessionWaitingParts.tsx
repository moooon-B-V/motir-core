'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Hourglass } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import type { PlanSessionFailureDto } from '@/lib/dto/planChange';
import {
  refusalEndsWaiting,
  resumeReasonKeyOf,
  resumeRefusalKeyOf,
  stopPhraseKeyOf,
} from '@/app/(authed)/workbench/_components/planningSessionWords';

// A SESSION THAT WAITS, IN THE OVERLAY (Story MOTIR-7905 · MOTIR-7918; design
// `design/ai-chat/design-notes.md` § _The overlay waits with you_, mock
// `planning-workspace--waiting-on-you.mock.html` panels 3–5). Product-local parts the rail
// composes, beside `SessionEndParts.tsx`, which draws the sessions that ENDED.
//
// ⚠️ A FAILED HOSTED ATTEMPT NO LONGER ENDS ITS SESSION. It keeps its plans and cards and waits to
// be resumed, so this is not the *Closed* state: no end marker, no *Start a new session*, no
// Try again. The words are the To resume entry's (`workbench.planningSession.*`) — the stop in
// the progress line's step words, the stable reason code translated, never motir-ai's English.
//
// Every part reads the SERVER's row (`session.failure`), never a stream error, so a reload or a
// second tab draws exactly the same thing.

/**
 * THE FAILURE BLOCK of a session waiting to resume: where the walk stopped, why, when — and
 * **Resume** in place of Try again. The plan so far stays on the canvas through the live poll;
 * the sentence says so. Failed *again* carries a quiet *Second attempt* note.
 *
 * `canResume` false is the read-only face for a member who neither started the session nor
 * manages the project (panel 3c): no Resume, and the sentence names who can.
 */
export function FailedWaitingNotice({
  failure,
  failedAgain,
  resuming,
  resumeError,
  canResume,
  starterName,
  onResume,
}: {
  failure: PlanSessionFailureDto;
  failedAgain: boolean;
  resuming: boolean;
  resumeError: string | null;
  canResume: boolean;
  starterName: string | null;
  onResume: () => void;
}) {
  const t = useTranslations('workbench.planningSession');
  const tw = useTranslations('planningWorkspace.waiting');
  const format = useFormatter();
  const stop = stopPhraseKeyOf(failure);
  const refusal = resumeError === null ? null : resumeRefusalKeyOf(resumeError);
  const showRefusal = refusal !== null && refusal !== 'alreadyStarted';
  const sessionGone = refusal !== null && refusalEndsWaiting(refusal);
  return (
    <section
      aria-label={tw('failedHead')}
      data-testid="planning-failed-waiting"
      data-state={resuming ? 'resuming' : failedAgain ? 'failed-again' : 'waiting'}
      className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Hourglass className="size-4 flex-none text-(--el-icon-muted)" aria-hidden />
        <p className="text-sm font-semibold text-(--el-text-strong)">{tw('failedHead')}</p>
        {failedAgain && !resuming ? <Pill tone="neutral">{t('second')}</Pill> : null}
        <Pill tone="awaiting">{resuming ? t('resuming') : t('waitingToResume')}</Pill>
      </div>
      <p className="text-xs leading-relaxed text-(--el-text-secondary)">
        <span>{t('stoppedAt')} </span>
        <span className="font-medium text-(--el-text)">
          {t(`stop.${stop}`, { title: failure.stopTitle ?? '' })}
        </span>
        <span aria-hidden> · </span>
        <span>{t('because', { reason: t(`reason.${resumeReasonKeyOf(failure.reason)}`) })}</span>
        <span aria-hidden> · </span>
        <span
          title={format.dateTime(new Date(failure.failedAt), {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        >
          {t('failedAt', { when: format.relativeTime(new Date(failure.failedAt)) })}
        </span>
      </p>
      <p className="text-xs leading-relaxed text-(--el-text-secondary)">{tw('kept')}</p>
      {showRefusal ? (
        <p role="alert" className="text-xs text-(--el-text)">
          <span className="font-medium">{t('couldNot')}</span> {t(`refusal.${refusal}`)}
        </p>
      ) : null}
      {canResume ? (
        !sessionGone ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={resuming}
              onClick={onResume}
              data-testid="planning-resume"
            >
              {resuming ? t('resuming') : t('resume')}
            </Button>
            <span className="text-xs text-(--el-text-secondary)">{tw('holdReason')}</span>
          </div>
        ) : null
      ) : (
        <p data-testid="planning-resume-not-yours" className="text-xs text-(--el-text-secondary)">
          {starterName ? tw('onlyStarter', { name: starterName }) : tw('onlyStarterAnon')}
        </p>
      )}
    </section>
  );
}
