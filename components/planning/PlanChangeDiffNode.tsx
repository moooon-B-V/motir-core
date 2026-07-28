'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Lock, Minus, Pencil, Plus } from 'lucide-react';
import { PlanItemNode } from '@/components/planning/PlanItemNode';
import { NODE_H, NODE_W } from '@/lib/planning/projectCanvasModel';
import {
  changedFields,
  type PlanChangeDiffState,
  type ProposedAdd,
} from '@/lib/planning/planChangeDiff';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// The DIFF chrome a canvas node takes while a plan-change proposal is pending
// (Subtask MOTIR-1730; design `plan-change-conversation.mock.html` panel 4 — "the
// review surface is the CANVAS, not a corner dock").
//
// ⚠️ It WRAPS the shipped node instead of redrawing one. An existing work item on
// the canvas keeps rendering as the real `WorkItemNode` (its kind tile, status
// pill, progress meter, "you are here" chrome — all of it), and this frame adds
// only the diff layer ON TOP: a border treatment + a corner tag + a word. That is
// the compose-don't-redraw rule (`notes.html` #82 / #95) at the node level, and it
// is why the canvas cannot drift from the roadmap it decorates.
//
// A PROPOSED item has no shipped node to wrap, so it reuses `PlanItemNode` — the
// component the 7.21 plan detail already uses to draw a proposed item — fed an
// adapted review item.
//
// NOT COLOUR ALONE (design + AA): every state pairs a border treatment with a
// glyph AND a word, and the word is real text, so it reaches a screen reader.

const FRAME: Record<PlanChangeDiffState, string> = {
  // A proposed add draws its own dashed-accent frame inside `PlanItemNode`.
  add: '',
  change: 'rounded-(--radius-card) ring-2 ring-(--el-info)',
  // A proposed REMOVE (design panel 4's `.node.removed`): DASHED danger, like the
  // add's dashed accent — dashed is the design's grammar for "proposed, not real
  // yet", and only `change` (which touches a card that stays) is solid. An
  // `outline` rather than a `border`, because a border would inset the fixed
  // NODE_W×NODE_H box and break the canvas's deterministic spacing. Paired below
  // with the glyph, the word, the struck title and the rose wash — never colour
  // alone.
  remove:
    'rounded-(--radius-card) outline-2 outline-dashed outline-(--el-danger) [&_[data-node-title]]:text-(--el-text-muted) [&_[data-node-title]]:line-through',
  locked: 'rounded-(--radius-card) ring-1 ring-(--el-border-strong)',
};

const TAG_TONE: Record<PlanChangeDiffState, string> = {
  add: 'bg-(--el-tint-lavender) text-(--el-text-strong)',
  change: 'bg-(--el-tint-sky) text-(--el-text-strong)',
  remove: 'bg-(--el-tint-rose) text-(--el-text-strong)',
  locked: 'bg-(--el-muted) text-(--el-text-secondary)',
};

/** The hatched surface that makes a LOCKED node legibly immutable (the shipped
 *  `GhostAnchor` hatch technique, in neutral tokens — the stripes are drawn over
 *  the real card, so its own content stays readable underneath). */
// Deliberately SPARSE + palette-derived: the stripes must read as "hatched, so
// not editable" without competing with the card's own title underneath (a dense
// hatch made the struck-through title unreadable in the live render).
const LOCK_HATCH =
  'repeating-linear-gradient(135deg, transparent, transparent 13px, color-mix(in srgb, var(--el-muted) 60%, transparent) 13px, color-mix(in srgb, var(--el-muted) 60%, transparent) 15px)';

export interface PlanChangeDiffFrameProps {
  state: PlanChangeDiffState;
  /** The proposal behind a `change` / `remove`, so the tag can name WHAT changed. */
  proposal?: PlanReviewItemDto;
  children: ReactNode;
}

export function PlanChangeDiffFrame({ state, proposal, children }: PlanChangeDiffFrameProps) {
  const t = useTranslations('planningWorkspace.conversation.diff');
  const fields = state === 'change' && proposal ? changedFields(proposal) : [];

  return (
    <div
      // The canvas positions a fixed NODE_W×NODE_H box; the frame must not change
      // that footprint or the deterministic row spacing breaks.
      style={{ width: NODE_W, height: NODE_H }}
      className={`relative ${FRAME[state]}`}
      data-diff-state={state}
      data-testid="plan-change-diff-node"
      // A locked node is not editable by the proposal — say so, don't imply it.
      aria-disabled={state === 'locked' ? true : undefined}
    >
      {children}

      {state === 'locked' ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-(--radius-card)"
          style={{ backgroundImage: LOCK_HATCH }}
        />
      ) : null}

      {/* The removed card's rose wash (design `.node.removed`'s fill) — drawn OVER
          the real card, translucent, so its own content stays readable. */}
      {state === 'remove' ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-(--radius-card) bg-(--el-tint-rose) opacity-45"
        />
      ) : null}

      <span
        className={`absolute -top-2 left-2.5 inline-flex items-center gap-1 rounded-(--radius-badge) px-(--spacing-chip-x) py-px font-mono text-[10px] font-bold tracking-wide uppercase ${TAG_TONE[state]}`}
      >
        {state === 'add' ? (
          <Plus className="size-3" aria-hidden="true" />
        ) : state === 'change' ? (
          <Pencil className="size-3" aria-hidden="true" />
        ) : state === 'remove' ? (
          <Minus className="size-3" aria-hidden="true" />
        ) : (
          <Lock className="size-3" aria-hidden="true" />
        )}
        {t(state)}
      </span>

      {/* A locked node says WHY it can't move; a changed one says what moved; a
          removed one says it goes. All are real text (never a bare tint), so the
          state is legible and audible. */}
      {state === 'locked' ? (
        <span className="absolute right-2 -bottom-2 inline-flex items-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) py-px text-[10px] font-semibold text-(--el-text-secondary)">
          {t('cantChange')}
        </span>
      ) : state === 'remove' ? (
        <span
          data-testid="plan-change-fields"
          className="absolute right-2 -bottom-2 inline-flex items-center rounded-(--radius-badge) bg-(--el-tint-rose) px-(--spacing-chip-x) py-px text-[10px] font-semibold text-(--el-text-strong)"
        >
          {t('willRemove')}
        </span>
      ) : state === 'change' && fields.length > 0 ? (
        <span
          data-testid="plan-change-fields"
          className="absolute right-2 -bottom-2 inline-flex max-w-[16rem] items-center truncate rounded-(--radius-badge) bg-(--el-tint-sky) px-(--spacing-chip-x) py-px text-[10px] font-semibold text-(--el-text-strong)"
        >
          {fields.map((f) => t(`field.${f}`)).join(' · ')}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A PROPOSED (not-yet-persisted) item's node. It reuses the shipped `PlanItemNode`
 * — the same card the 7.21 plan detail draws a proposal with — fed the review item
 * VERBATIM (MOTIR-1746). Both entrances now read the same `PlanReviewItemDto` off
 * the same Plan, so there is no adapter left to drift: the rail's canvas and
 * `/plans/[id]` draw one proposal one way.
 */
export function ProposedAddNode({ add }: { add: ProposedAdd }) {
  return (
    <PlanChangeDiffFrame state="add">
      <PlanItemNode item={add.item} />
    </PlanChangeDiffFrame>
  );
}
