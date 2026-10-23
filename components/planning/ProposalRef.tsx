'use client';

import { Children, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { PlanningTargetChip } from '@/components/planning/PlanningTargetChip';

// A PROPOSAL named in a Markdown body by `[label](motir-ref:planItem:<id>)`.
// Lives on its own (moved out of `MidRunTurn`, bug MOTIR-9355) so the proposal
// peek can draw it in a proposed body without importing the planning rail.

/** The plain text of a Markdown link's children — the title the chip shows. */
function textOf(label: ReactNode): string {
  return Children.toArray(label)
    .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('');
}

/**
 * State 3b — a PROPOSAL named in an answer. It has no key, so it is the shipped
 * proposal chip: the word *New* in the key slot, the dashed accent frame, the
 * title. With `onSelect` it is a button that selects the node on the canvas;
 * without, the same chip as text. Never a key, never a stale one.
 */
export function ProposalRef({
  planItemId,
  label,
  onSelect,
}: {
  planItemId: string;
  label: ReactNode;
  onSelect?: (planItemId: string) => void;
}) {
  const tPlan = useTranslations('planReview');
  const chip = (
    <PlanningTargetChip
      target={{ identifier: '', title: textOf(label), kind: 'task' }}
      proposedWord={tPlan('proposedCrumb')}
    />
  );
  return (
    <span data-testid="plan-change-proposal-ref" data-plan-item={planItemId}>
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(planItemId)}
          className="inline-flex max-w-full rounded-(--radius-control) text-left focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {chip}
        </button>
      ) : (
        chip
      )}
    </span>
  );
}
