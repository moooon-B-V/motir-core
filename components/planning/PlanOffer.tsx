'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { CircleCheck, Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { WorkItemRefChip } from '@/components/markdown/WorkItemRefChip';
import type { PlanAnswerOfferDto, PlanChangeSessionDto } from '@/lib/dto/planChange';
import { answerRefusalKey, cannotStartKey } from '@/lib/planning/planOfferRow';

// THE PLAN OFFER on an answer turn (Story MOTIR-9219 · MOTIR-9294; design
// `design/ai-chat/plan-offer.mock.html`, § "The plan offer on an answer turn"). The
// answer may end with ONE stored offer to plan; this draws it under the answer
// bubble, composed the way `GuideReplanOffer` is so two offers in one thread read
// as one family, with its own `plan-offer*` hooks.
//
// ⚠️ EVERY STATE IS THE SERVED ONE. `offer.state` and `offer.cannotStart` are
// derived by core on every read, so a reload draws the identical row; nothing here
// mirrors them in component state. The only local state is the clamp toggle and
// which button was pressed, for its loading label.
//
// ⚠️ THE REQUEST TEXT IS DATA THE ANSWERING MODEL WROTE — rendered as markdown,
// never as catalogue copy.

/** A long request clamps to this many characters' worth of room until *Show all*. */
const CLAMP_AT = 480;

export interface PlanOfferProps {
  turnId: string;
  offer: PlanAnswerOfferDto;
  workItemRefs: PlanChangeSessionDto['workItemRefs'];
  /** The cards this conversation was opened on — the `targetElsewhere` line. */
  sessionTargetKeys: readonly string[];
  /** Confirm and Decline exist: the live offer, a viewer who may continue, a host
   *  with both answers (`offerAnswerable`). */
  answerable: boolean;
  /** This offer's answer is in flight. */
  answering: boolean;
  /** A turn is running under the thread: nothing is pressed. */
  busy: boolean;
  /** The conversation already plans something (`alreadyPlanning`). */
  midPlanning: boolean;
  /** The refused press's code for THIS offer, or null. */
  refusal: string | null;
  onConfirm?: (turnId: string) => void;
  onDecline?: (turnId: string) => void;
}

function sameKey(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

function TargetChip({
  itemKey,
  workItemRefs,
}: {
  itemKey: string;
  workItemRefs: PlanChangeSessionDto['workItemRefs'];
}) {
  // Only a READABLE summary names a title and a kind; the `accessible: false` arm
  // carries an id alone, so it draws the key the offer stored.
  const summary = Object.values(workItemRefs).find(
    (s) => s.accessible && sameKey(s.identifier, itemKey),
  );
  return (
    <span className="wi-chip-host min-w-0" data-testid="plan-offer-target-chip">
      {summary ? (
        <WorkItemRefChip summary={summary} fallbackLabel={itemKey} />
      ) : (
        <span className="rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-xs text-(--el-text)">
          {itemKey}
        </span>
      )}
    </span>
  );
}

/**
 * One more Motir AI line in the answer turn, in place of a panel — an offer that
 * cannot start, or whose target is being planned right now (design sheets 3 and 4).
 * Aligned under the answer bubble: the avatar's width is a spacer, not a second mark.
 */
function AnswerLine({
  testId,
  reason,
  children,
}: {
  testId: string;
  reason?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-start gap-2"
      data-testid={testId}
      {...(reason ? { 'data-reason': reason } : {})}
    >
      <span aria-hidden="true" className="size-7 shrink-0" />
      <div className="min-w-0 rounded-(--radius-card) bg-(--el-chat-bubble-ai) px-3 py-2 text-sm text-(--el-text) wrap-anywhere">
        {children}
      </div>
    </div>
  );
}

export function PlanOffer({
  turnId,
  offer,
  workItemRefs,
  sessionTargetKeys,
  answerable,
  answering,
  busy,
  midPlanning,
  refusal,
  onConfirm,
  onDecline,
}: PlanOfferProps) {
  const t = useTranslations('planningWorkspace.planOffer');
  const format = useFormatter();
  const [expanded, setExpanded] = useState(false);
  const [pressed, setPressed] = useState<'confirm' | 'decline' | null>(null);

  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : '';

  const state = offer.state ?? 'undecided';
  const target = offer.targetKey;

  if (state === 'superseded') {
    return (
      <p
        className="rounded-(--radius-card) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-xs text-(--el-text-secondary)"
        data-testid="plan-offer"
        data-offer-state="superseded"
      >
        {t('replaced')}
      </p>
    );
  }

  // AN OFFER THAT CANNOT START draws no panel and no Decline: there is nothing to
  // confirm and nothing to decline (design, second review).
  if (state === 'undecided' && offer.cannotStart) {
    const line = cannotStartKey(offer.cannotStart);
    if (line.kind === 'beingPlanned') {
      const key = target ?? '';
      const here = midPlanning && sessionTargetKeys.some((k) => sameKey(k, key));
      return (
        <AnswerLine testId="plan-offer-being-planned">
          {t(here ? 'beingPlannedHere' : 'beingPlanned', { key })}
        </AnswerLine>
      );
    }
    return (
      <AnswerLine testId="plan-offer-cannot-start" reason={offer.cannotStart}>
        {t(`cannotStart.${line.key}`)}
      </AnswerLine>
    );
  }

  const long = offer.requestMd.length > CLAMP_AT;
  const decided = state === 'confirmed' || state === 'declined';
  const live = state === 'undecided' && answerable;
  const variant = live && midPlanning;
  const elsewhere =
    target !== null &&
    sessionTargetKeys.length > 0 &&
    !sessionTargetKeys.some((k) => sameKey(k, target));
  const refusalKey = live && refusal !== null ? answerRefusalKey(refusal) : null;
  const confirming = answering && pressed === 'confirm';
  const declining = answering && pressed === 'decline';
  const disabled = busy || answering;

  return (
    <section
      aria-label={variant ? t('labelMidPlanning') : t('label')}
      data-testid="plan-offer"
      data-offer-state={state}
      className={`flex flex-col gap-2.5 rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding) ${
        decided ? 'bg-(--el-surface-soft)' : 'bg-(--el-surface)'
      }`}
    >
      <p className="text-xs font-semibold text-(--el-text-secondary)">
        {variant ? t('labelMidPlanning') : t('label')}
      </p>

      <div
        className={`rounded-(--radius-input) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-input-x) py-(--spacing-control-y-8) text-sm text-(--el-text) ${
          long && !expanded ? 'max-h-32 overflow-hidden' : ''
        }`}
        data-testid="plan-offer-request"
      >
        <MarkdownView value={offer.requestMd} workItemRefs={workItemRefs} />
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="self-start rounded-(--radius-control) px-(--spacing-control-x-4) text-xs font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          data-testid="plan-offer-show-all"
        >
          {expanded ? t('showLess') : t('showAll')}
        </button>
      ) : null}

      {target === null ? (
        <p
          className="border-l-2 border-(--el-border-strong) pl-2 text-xs text-(--el-text)"
          data-testid="plan-offer-no-target"
        >
          {t('noTarget')}
        </p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="plan-offer-target">
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-(--el-text-secondary)">
            <span>{t('target')}</span>
            <TargetChip itemKey={target} workItemRefs={workItemRefs} />
          </p>
          {elsewhere ? (
            <p className="text-xs text-(--el-text-secondary)">
              {t('targetElsewhere', { key: target })}
            </p>
          ) : null}
        </div>
      )}

      {state === 'confirmed' ? (
        <div className="flex flex-col gap-1.5" data-testid="plan-offer-confirmed">
          <span className="inline-flex w-fit items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-mint) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
            <CircleCheck className="size-3.5" aria-hidden />
            {t('started')}
          </span>
          {offer.confirmedAt ? (
            <p className="text-xs text-(--el-text-secondary)">
              {t('startedBy', { when: when(offer.confirmedAt) })}
            </p>
          ) : null}
          <p className="text-xs text-(--el-text-secondary)">{t('startedHere')}</p>
        </div>
      ) : state === 'declined' ? (
        <div className="flex flex-col gap-1.5" data-testid="plan-offer-declined">
          <span className="inline-flex w-fit items-center rounded-(--radius-badge) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
            {t('declined')}
          </span>
          {offer.declinedAt ? (
            <p className="text-xs text-(--el-text-secondary)">
              {t('declinedBy', { when: when(offer.declinedAt) })}
            </p>
          ) : null}
          <p className="text-xs text-(--el-text-secondary)">{t('recorded')}</p>
        </div>
      ) : !live ? null : refusalKey ? (
        // A REFUSED PRESS keeps the request and target and replaces BOTH buttons
        // with the reason (design sheet 7).
        <p
          className="flex items-start gap-1.5 border-l-2 border-(--el-border-strong) pl-2 text-xs text-(--el-text)"
          data-testid="plan-offer-cannot-start"
          data-reason={refusal ?? undefined}
        >
          <Lock className="mt-px size-3.5 flex-none" aria-hidden />
          <span>{t(`cannotStart.${refusalKey}`, { key: target ?? '' })}</span>
        </p>
      ) : (
        <>
          {variant ? (
            <p className="text-xs text-(--el-text-secondary)" data-testid="plan-offer-mid-planning">
              {t('midPlanning')}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              data-testid="plan-offer-confirm"
              loading={confirming}
              disabled={disabled}
              onClick={() => {
                setPressed('confirm');
                onConfirm?.(turnId);
              }}
            >
              {confirming ? t('confirming') : t('confirm')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              data-testid="plan-offer-decline"
              loading={declining}
              disabled={disabled}
              onClick={() => {
                setPressed('decline');
                onDecline?.(turnId);
              }}
            >
              {declining ? t('declining') : t('decline')}
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-(--el-text-secondary)">
            {target !== null ? t('confirmHelp', { key: target }) : t('confirmHelpNoTarget')}{' '}
            {t('declineHelp')}
          </p>
        </>
      )}
    </section>
  );
}
