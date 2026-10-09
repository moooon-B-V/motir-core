'use client';

import { Fragment, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, RefreshCw, Sparkles } from 'lucide-react';

import { RelationshipPeekLink } from '@/app/(authed)/items/[key]/_components/RelationshipPeekLink';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import type { StalePlanFinishedCard } from '@/lib/planning/planSessionClientErrors';

// THE STALE-PLAN ANSWER (Story MOTIR-7928 · MOTIR-7932), built to MOTIR-7929's
// `planning-workspace--waiting-plan-carry.mock.html` state 10 and its variants.
//
// A turn landed on a plan whose work was finished after it was made, so the plan
// can be neither revised nor approved (MOTIR-7945's typed outcome). That is an
// ANSWER, not a failure: an assistant message on the WARNING role — never danger —
// naming the finished work items, with ONE way forward, Plan it again. Exported for
// the situation-2 overlay (MOTIR-7909) to place unchanged.

/** How many finished items the sentence names before it counts the rest. */
const NAMED = 2;

export interface StalePlanNoticeProps {
  finishedCards: readonly StalePlanFinishedCard[];
  onPlanAgain: () => void;
  /** Plan it again is in flight: the button holds still (variant D). */
  pending: boolean;
  /** A fresh plan was started from this conversation: the action is withdrawn
   *  (variant E). */
  accepted: boolean;
  /** The press was refused because the plan was decided first: the decide door's
   *  stale-read words, the action withdrawn. */
  refused: boolean;
  /** The plan was current again when pressed — the press revised it (variant G). */
  restored?: boolean;
  /** The new plan is being written right now (variant E's line). */
  writing?: boolean;
}

/** One finished item, as a key chip that opens the item's peek. */
function ItemChip({ card }: { card: StalePlanFinishedCard }) {
  return (
    <RelationshipPeekLink
      identifier={card.key}
      className="inline-flex items-center rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) align-baseline font-mono text-[11px] font-semibold text-(--el-text-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      <span title={card.statusLabel ? `${card.title} · ${card.statusLabel}` : card.title}>
        {card.key}
      </span>
      <span className="sr-only">
        {card.title}
        {card.statusLabel ? ` (${card.statusLabel})` : ''}
      </span>
    </RelationshipPeekLink>
  );
}

/** Put React nodes where a message's ONE placeholder stood. next-intl's `rich`
 *  takes only tag functions, so the slot is a sentinel the sentence is split on. */
const SLOT = '\u0000';
function withSlot(sentence: string, node: ReactNode): ReactNode {
  const [before, after = ''] = sentence.split(SLOT);
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

/** The named chips (and "N more") joined the way the locale lists things. */
function ChipList({
  cards,
  locale,
  more,
}: {
  cards: readonly StalePlanFinishedCard[];
  locale: string;
  more: (count: number) => string;
}) {
  const named = cards.slice(0, NAMED);
  const rest = cards.length - named.length;
  const items: ReactNode[] = named.map((card) => <ItemChip key={card.id} card={card} />);
  if (rest > 0) items.push(more(rest));
  const parts = new Intl.ListFormat(locale, { type: 'conjunction' }).formatToParts(
    items.map((_, i) => `${SLOT}${i}${SLOT}`),
  );
  return (
    <>
      {parts.map((part, i) =>
        part.type === 'element' ? (
          <Fragment key={i}>{items[Number(part.value.replaceAll(SLOT, ''))]}</Fragment>
        ) : (
          <Fragment key={i}>{part.value}</Fragment>
        ),
      )}
    </>
  );
}

export function StalePlanNotice({
  finishedCards,
  onPlanAgain,
  pending,
  accepted,
  refused,
  restored = false,
  writing = false,
}: StalePlanNoticeProps) {
  const ts = useTranslations('planningWorkspace.session');
  const tRefusal = useTranslations('approvalGate.refusal.alreadyDecided');
  const locale = useLocale();

  const sentence =
    finishedCards.length === 0
      ? ts('stalePlan.generic')
      : finishedCards.length === 1
        ? withSlot(ts('stalePlan.one', { workItem: SLOT }), <ItemChip card={finishedCards[0]!} />)
        : withSlot(
            ts('stalePlan.many', { workItems: SLOT }),
            <ChipList
              cards={finishedCards}
              locale={locale}
              more={(count) => ts('stalePlan.more', { count })}
            />,
          );

  const withdrawn = accepted || refused || restored;
  return (
    <div className="flex flex-col gap-2">
      <div
        role="status"
        data-testid="planning-stale-plan"
        className="flex min-w-0 flex-col gap-2 rounded-(--radius-card) bg-(--el-tint-yellow) px-3 py-2 text-sm text-(--el-text-strong)"
      >
        <p className="flex items-start gap-2">
          <RefreshCw className="mt-0.5 size-3.5 flex-none" aria-hidden />
          <span>{sentence}</span>
        </p>
        {!withdrawn ? (
          <>
            <p className="text-xs leading-relaxed text-(--el-text-strong)">
              {ts('stalePlan.planAgainGloss')}
            </p>
            <Button
              variant="primary"
              size="sm"
              className="self-start"
              data-testid="planning-plan-again"
              leftIcon={<Sparkles className="size-4" aria-hidden="true" />}
              loading={pending}
              onClick={onPlanAgain}
            >
              {pending ? ts('stalePlan.planningAgain') : ts('stalePlan.planAgain')}
            </Button>
          </>
        ) : accepted && writing ? (
          <p
            data-testid="planning-stale-writing"
            className="flex items-center gap-2 text-xs text-(--el-text-strong)"
          >
            <Spinner size="sm" aria-hidden="true" />
            {ts('stalePlan.writing')}
          </p>
        ) : refused ? (
          <p data-testid="planning-stale-refused" className="text-xs text-(--el-text-strong)">
            <span className="font-semibold">{tRefusal('unattributed')}</span> {tRefusal('next')}
          </p>
        ) : null}
      </div>
      {restored ? (
        <p
          data-testid="planning-stale-restored"
          className="flex items-start gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
        >
          <Check className="mt-px size-3.5 flex-none" aria-hidden />
          <span>
            {finishedCards.length === 1
              ? ts('stalePlan.restoredOne', { workItem: finishedCards[0]!.key })
              : ts('stalePlan.restored')}
          </span>
        </p>
      ) : null}
    </div>
  );
}
