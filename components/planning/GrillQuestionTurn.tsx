'use client';

import { useTranslations } from 'next-intl';
import { PenLine, Square } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Bubble } from '@/components/planning/PlanChangeRail';
import type { SharpenAction, SharpenQuestion } from '@/lib/ai/types';

// THE GRILLING QUESTION ON THE RAIL'S OWN QUESTION SURFACE (Task MOTIR-1101 ·
// Subtasks MOTIR-8447 / MOTIR-8177; design G3, panels 3–6).
//
// One question, drawn as the conversation phase already draws a planner
// question — `Bubble tone="asking"`, carrying the rail's pending-question anchor —
// then the reply row: one button per reading (the recommended one `primary`, its
// accessible name ending "(recommended)"), and Something else… · Skip · You
// decide · Stop grilling. Every act is ONE act; all of them are disabled while one
// is in flight, except Stop grilling, which is always reachable.

export interface GrillQuestionTurnProps {
  question: SharpenQuestion;
  /** 1-based — "asking · question N". */
  number: number;
  /** A turn's job is in flight. */
  pending: boolean;
  anchorId?: string;
  onAct: (action: Exclude<SharpenAction, 'start' | 'stop'>, opts?: { readingId?: string }) => void;
  onStop: () => void;
  /** Something else… — focus the composer for an own-words answer. */
  onSomethingElse: () => void;
}

export function GrillQuestionTurn({
  question,
  number,
  pending,
  anchorId,
  onAct,
  onStop,
  onSomethingElse,
}: GrillQuestionTurnProps) {
  const t = useTranslations('planningWorkspace.grill.question');

  return (
    <div className="flex flex-col gap-2" data-testid="grill-question">
      <Bubble
        role="assistant"
        tone="asking"
        label={t('label', { n: number })}
        {...(anchorId ? { anchorId } : {})}
      >
        <p className="text-(--el-text)">{question.text}</p>
        <ul className="mt-2 flex flex-col gap-1">
          {question.readings.map((reading) => (
            <li key={reading.id} className="text-sm text-(--el-text)">
              <span className="font-semibold">{reading.label}</span>
              {reading.detail ? (
                <span className="text-(--el-text-secondary)"> — {reading.detail}</span>
              ) : null}
              {reading.recommended ? (
                <span className="ml-1.5 inline-flex items-center rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[11px] font-semibold text-(--el-text-strong)">
                  {t('recommended')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Bubble>
      <div className="flex flex-col gap-1.5 pl-9" data-testid="grill-replies">
        <div className="flex flex-wrap gap-1.5">
          {question.readings.map((reading) => (
            <Button
              key={reading.id}
              variant={reading.recommended ? 'primary' : 'secondary'}
              size="sm"
              data-testid={`grill-reading-${reading.id}`}
              aria-label={
                reading.recommended ? t('recommendedName', { label: reading.label }) : reading.label
              }
              disabled={pending}
              onClick={() => onAct('answer', { readingId: reading.id })}
            >
              {reading.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            data-testid="grill-something-else"
            leftIcon={<PenLine className="size-4" aria-hidden />}
            disabled={pending}
            onClick={onSomethingElse}
          >
            {t('somethingElse')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="grill-skip"
            disabled={pending}
            onClick={() => onAct('skip')}
          >
            {t('skip')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="grill-you-decide"
            disabled={pending}
            onClick={() => onAct('you_decide')}
          >
            {t('youDecide')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="grill-stop"
            leftIcon={<Square className="size-4" aria-hidden />}
            onClick={onStop}
          >
            {t('stop')}
          </Button>
        </div>
      </div>
    </div>
  );
}
