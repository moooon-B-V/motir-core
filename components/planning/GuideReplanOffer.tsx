'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { CircleCheck, Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { WorkItemRefChip } from '@/components/markdown/WorkItemRefChip';
import type { GuideReplanOffer } from '@/lib/ai/guideWorkItem';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { GuideReplanOfferState } from '@/lib/planning/guideReplanOffer';

// THE RE-PLAN OFFER under a guide reply (Story MOTIR-8684 · MOTIR-8694; design
// `design/ai-chat/guide-replan-offer.mock.html`, decision MOTIR-8685). The guide's
// wrong-card turn ends here instead of in a bare stop: the request the guide wrote,
// the target it chose, Confirm and Decline. Every state is drawn from the STORED
// offer alone (`replanOfferStateOf`), so a reload shows what happened.
//
// ⚠️ THE REQUEST TEXT IS DATA THE GUIDE WROTE — rendered as markdown, never as
// catalogue copy, and never put in a URL. Confirm and "Open the planning session"
// both hand the planner the OFFER'S TURN ID (`onOpen`), which is how a seed is
// addressed (MOTIR-8693).
//
// Only the LATEST undecided offer carries Confirm and Decline. A confirmed, declined
// or replaced offer carries no buttons.

/** A long request clamps to this many characters' worth of room until *Show all*. */
const CLAMP_AT = 480;

export interface GuideReplanOfferProps {
  turnId: string;
  offer: GuideReplanOffer;
  state: GuideReplanOfferState;
  /** The guided card's key — the offer's target when no other was chosen. */
  cardKey: string;
  /** First step not done, for the declined state's resume line. */
  resumeStep: number | null;
  /** The viewer may start planning (`ai:plan`). Decline stays either way. */
  canPlan: boolean;
  /** Why not, when {@link canPlan} is false — each reason has its own line. */
  cannotPlanReason?: 'no_permission' | 'ai_not_configured' | null;
  /** A guide turn is running: nothing is pressed under it. */
  busy: boolean;
  /** This offer's Decline is in flight. */
  declining: boolean;
  workItemRefs: PlanChangeSessionDto['workItemRefs'];
  /** Open the planner from this offer (Confirm, and the confirmed link). */
  onOpen: (turnId: string) => boolean | void;

  onDecline: (turnId: string) => void;
}

function KeyChip({
  itemKey,
  workItemRefs,
}: {
  itemKey: string;
  workItemRefs: PlanChangeSessionDto['workItemRefs'];
}) {
  const summary = Object.values(workItemRefs).find(
    (s) => s.accessible && s.identifier.toUpperCase() === itemKey.toUpperCase(),
  );
  if (summary) return <WorkItemRefChip summary={summary} fallbackLabel={itemKey} />;
  return (
    <span className="rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-xs text-(--el-text)">
      {itemKey}
    </span>
  );
}

export function GuideReplanOffer({
  turnId,
  offer,
  state,
  cardKey,
  resumeStep,
  canPlan,
  cannotPlanReason = null,
  busy,
  declining,
  workItemRefs,
  onOpen,
  onDecline,
}: GuideReplanOfferProps) {
  const t = useTranslations('planningWorkspace.guide.offer');
  const format = useFormatter();
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : '';

  if (state === 'superseded') {
    return (
      <p
        className="rounded-(--radius-card) bg-(--el-surface-soft) px-3 py-2 text-xs text-(--el-text-secondary)"
        data-testid="guide-offer"
        data-offer-state="superseded"
      >
        {t('replaced')}
      </p>
    );
  }

  const target = offer.targetKey;
  const noTarget = offer.targetResolution === 'none' || target === null;
  const long = offer.requestMd.length > CLAMP_AT;
  const decided = state === 'confirmed' || state === 'declined';

  return (
    <section
      aria-label={t('label')}
      data-testid="guide-offer"
      data-offer-state={state}
      className={`guide-offer flex flex-col gap-2.5 rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding) ${
        decided ? 'bg-(--el-surface-soft)' : 'bg-(--el-surface)'
      }`}
    >
      <p className="text-xs font-semibold text-(--el-text-secondary)">{t('label')}</p>

      <div
        className={`rounded-(--radius-input) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-input-x) py-2 text-sm text-(--el-text) ${
          long && !expanded ? 'max-h-32 overflow-hidden' : ''
        }`}
        data-testid="guide-offer-request"
      >
        <MarkdownView value={offer.requestMd} workItemRefs={workItemRefs} />
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="self-start rounded-(--radius-control) px-1 text-xs font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
          data-testid="guide-offer-show-all"
        >
          {expanded ? t('showLess') : t('showAll')}
        </button>
      ) : null}

      {noTarget ? (
        <p
          className="border-l-2 border-(--el-border-strong) pl-2 text-xs text-(--el-text)"
          data-testid="guide-offer-no-target"
        >
          {t('noTarget')}
        </p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="guide-offer-target">
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-(--el-text-secondary)">
            <span>{t('target')}</span>
            <KeyChip itemKey={target} workItemRefs={workItemRefs} />
          </p>
          {offer.targetResolution === 'nearest_open_ancestor' &&
          offer.requestedTargetKey !== null ? (
            <p className="text-xs text-(--el-text-secondary)">
              {t('resolved', { done: offer.requestedTargetKey, open: target })}
            </p>
          ) : target.toUpperCase() !== cardKey.toUpperCase() ? (
            <p className="text-xs text-(--el-text-secondary)">
              {t('targetElsewhere', { key: target })}
            </p>
          ) : null}
        </div>
      )}

      {state === 'confirmed' ? (
        <div className="flex flex-col gap-1.5" data-testid="guide-offer-confirmed">
          <span className="inline-flex w-fit items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-mint) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
            <CircleCheck className="size-3.5" aria-hidden />
            {t('started')}
          </span>
          {offer.confirmedAt ? (
            <p className="text-xs text-(--el-text-secondary)">
              {t('startedBy', { when: when(offer.confirmedAt) })}
            </p>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            className="w-fit"
            data-testid="guide-offer-open"
            disabled={busy}
            onClick={() => onOpen(turnId)}
          >
            {t('openSession')}
          </Button>
        </div>
      ) : state === 'declined' ? (
        <div className="flex flex-col gap-1.5" data-testid="guide-offer-declined">
          <span className="inline-flex w-fit items-center rounded-(--radius-badge) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
            {t('declined')}
          </span>
          {offer.declinedAt ? (
            <p className="text-xs text-(--el-text-secondary)">
              {t('declinedBy', { when: when(offer.declinedAt) })}
            </p>
          ) : null}
          <p className="text-xs text-(--el-text-secondary)">{t('recorded')}</p>
          {resumeStep !== null ? (
            <p className="text-xs text-(--el-text-secondary)" data-testid="guide-offer-resume">
              {t('resumeAt', { n: resumeStep })}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          {!canPlan ? (
            <p
              className="flex items-start gap-1.5 border-l-2 border-(--el-border-strong) pl-2 text-xs text-(--el-text)"
              data-testid="guide-offer-cannot-plan"
            >
              <Lock className="mt-px size-3.5 flex-none" aria-hidden />
              <span>{t(cannotPlanReason === 'ai_not_configured' ? 'noAi' : 'cannotPlan')}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {canPlan && !noTarget ? (
              <Button
                variant="primary"
                size="sm"
                data-testid="guide-offer-confirm"
                loading={confirming}
                disabled={busy || declining || confirming}
                onClick={() => {
                  setConfirming(true);
                  // `false` = refused here (out of credits): nothing opened, press again.
                  if (onOpen(turnId) === false) setConfirming(false);
                }}
              >
                {confirming ? t('confirming') : t('confirm')}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              data-testid="guide-offer-decline"
              loading={declining}
              disabled={busy || declining || confirming}
              onClick={() => onDecline(turnId)}
            >
              {declining ? t('declining') : t('decline')}
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-(--el-text-secondary)">
            {canPlan && !noTarget && target !== null ? (
              <>
                {t('confirmHelp', { key: target })} {t('declineHelp')}
              </>
            ) : (
              t('declineHelp')
            )}
          </p>
        </>
      )}
    </section>
  );
}
