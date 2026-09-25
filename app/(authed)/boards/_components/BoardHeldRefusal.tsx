'use client';

import { createContext, useContext, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { StatusHeldNotice, type StatusHeldLine } from '@/components/issues/StatusHeldNotice';
import { useDismissOnEscapeOrOutside } from '@/components/issues/heldRefusal';
import type { BoardPlanHoldSummaryDto } from '@/lib/dto/boards';
import type { PlanHoldDTO } from '@/lib/dto/plans';

// The board's HELD refusal, anchored ON the returned card (Story MOTIR-4887 ·
// Subtask MOTIR-5529; `design/boards/design-notes.md` § panel 2b) — and, since
// MOTIR-6268, the PLAN hold (§ _⭐ The board refuses ON THE CARD while a PLAN holds
// it_, `design/boards/board--plan-hold.mock.html`).
//
// `BoardContainer` owns the state (it is the one that sees the 409); the card that
// was refused renders the refusal itself. A context rather than a prop threaded
// through `BoardColumn`, `SwimlaneBoard` and `LaneCell`: exactly one card on the
// board can be showing it, and the flat and swimlane layouts reach cards by
// different paths. The same context carries the board's plan-hold facts every
// held card's footer reads — the plans' labels and counts, and which plan's items
// are outlined right now.
//
// ONE refusal component, two slots: a gate refusal (an approval or a merge holds
// ONE target) draws UNDER the card, as panel 2b drew it; a plan refusal (a plan
// holds the WHOLE item) grows inside the item's own plan footer, within its border
// — never a separate box that reads as one more card in the lane.

export type BoardHeldRefusal =
  | { kind: 'gate'; workItemId: string; itemKey: string; line: StatusHeldLine }
  | {
      kind: 'plan';
      workItemId: string;
      itemKey: string;
      plan: PlanHoldDTO;
      /** How many OTHER items of the project this plan holds. */
      siblings: number;
    };

export interface BoardHeldRefusalContextValue {
  held: BoardHeldRefusal | null;
  close: () => void;
  /** Every plan holding a loaded card, keyed by `planId` (the projection's). */
  planHolds?: Record<string, BoardPlanHoldSummaryDto>;
  /** The `{name}` rule's last fallback. */
  projectName?: string;
  /** The plan whose items are outlined: a hovered / focused footer's, else an
   *  open plan refusal's. */
  highlightedPlanId?: string | null;
  /** A footer's hover / focus sets it; leaving clears it. */
  onPlanFooterHover?: (planId: string | null) => void;
}

/** Outside a board (a card rendered on its own): nothing held, nothing to close. */
export const NO_BOARD_HELD_REFUSAL: BoardHeldRefusalContextValue = {
  held: null,
  close: () => {},
};

const BoardHeldRefusalContext = createContext<BoardHeldRefusalContextValue>(NO_BOARD_HELD_REFUSAL);

export const BoardHeldRefusalProvider = BoardHeldRefusalContext.Provider;

/** The board's held state, for a card deciding how to draw itself. */
export function useBoardHeldRefusal(): BoardHeldRefusalContextValue {
  return useContext(BoardHeldRefusalContext);
}

/**
 * HOW A PLAN IS NAMED, consistently (the notes' `{name}` rule): its anchor key,
 * else its title, else the project's name — the order `ApprovalRow.tsx` names a
 * plan in. The projection's summary wins over the card's own hold, which carries
 * the anchor only.
 */
export function planHoldName(
  plan: Pick<PlanHoldDTO, 'planId' | 'anchorKey'>,
  planHolds: Record<string, BoardPlanHoldSummaryDto> | undefined,
  projectName: string | undefined,
): { name: string; isKey: boolean } {
  const summary = planHolds?.[plan.planId];
  const anchorKey = summary?.anchorKey ?? plan.anchorKey;
  if (anchorKey) return { name: anchorKey, isKey: true };
  const title = summary?.title?.trim();
  if (title) return { name: title, isKey: false };
  return { name: projectName ?? '', isKey: false };
}

/** A sentinel the marker's `{name}` is split on, so a KEY renders in mono inside
 *  the translated sentence without a second message per locale. */
const NAME_SLOT = '\u0000';

/** `Plan · MOTIR-6017` — the footer's label, the same words on every item of the
 *  plan. Lock glyph first; a key in mono, a title truncated to one line. */
export function PlanHoldMarker({ plan }: { plan: Pick<PlanHoldDTO, 'planId' | 'anchorKey'> }) {
  const t = useTranslations('boards.planHold');
  const { planHolds, projectName } = useContext(BoardHeldRefusalContext);
  const { name, isKey } = planHoldName(plan, planHolds, projectName);
  const [before = '', after = ''] = t('marker', { name: NAME_SLOT }).split(NAME_SLOT);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-semibold">
      <Lock aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {before}
        <span className={isKey ? 'font-mono' : undefined}>{name}</span>
        {after}
      </span>
    </span>
  );
}

/** The plan footer's own box — shared by the resting door, the inert drag clone
 *  and the open refusal, so the three cannot drift. */
export const PLAN_FOOTER_CLASS =
  'flex flex-col gap-1.5 border-t border-(--el-border-soft) bg-(--el-tint-mint) px-(--spacing-control-x) py-(--spacing-control-y) text-xs text-(--el-text-strong) no-underline';

/**
 * Draws nothing unless THIS card was the one refused. `slot="under"` (the
 * default) is the gate refusal under the card; `slot="footer"` is the plan
 * refusal, rendered BY the card's plan footer in its place. Closes on `Esc` or a
 * click outside (the next drag start closes it from the container).
 */
export function BoardCardHeldRefusal({
  workItemId,
  slot = 'under',
}: {
  workItemId: string;
  slot?: 'under' | 'footer';
}) {
  const { held, close } = useContext(BoardHeldRefusalContext);
  const ref = useRef<HTMLDivElement>(null);
  const kind = slot === 'footer' ? 'plan' : 'gate';
  const open = held?.workItemId === workItemId && held.kind === kind;
  useDismissOnEscapeOrOutside(ref, open, close);
  if (!open || !held) return null;
  if (held.kind === 'gate') {
    return (
      <div
        ref={ref}
        data-board-held=""
        className="mt-2 rounded-(--radius-control) shadow-(--shadow-elevated)"
      >
        <StatusHeldNotice itemKey={held.itemKey} lines={[held.line]} />
      </div>
    );
  }
  return (
    <div
      ref={ref}
      data-board-held=""
      data-plan-footer={held.plan.planId}
      className={PLAN_FOOTER_CLASS}
    >
      <PlanHoldMarker plan={held.plan} />
      <PlanSiblings count={held.siblings} />
      <StatusHeldNotice itemKey={held.itemKey} lines={[]} plan={held.plan} />
    </div>
  );
}

function PlanSiblings({ count }: { count: number }) {
  const t = useTranslations('boards.planHold');
  return <p className="m-0 leading-snug text-(--el-text-secondary)">{t('siblings', { count })}</p>;
}
