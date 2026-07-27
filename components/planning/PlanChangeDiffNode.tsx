'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Lock, Pencil, Plus } from 'lucide-react';
import { PlanItemNode } from '@/components/planning/PlanItemNode';
import { NODE_H, NODE_W } from '@/lib/planning/projectCanvasModel';
import {
  changedFields,
  type PlanChangeDiffState,
  type ProposedAdd,
} from '@/lib/planning/planChangeDiff';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanDeltaUpdateOp } from '@/lib/ai/planDelta';

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
  locked: 'rounded-(--radius-card) ring-1 ring-(--el-border-strong)',
};

const TAG_TONE: Record<PlanChangeDiffState, string> = {
  add: 'bg-(--el-tint-lavender) text-(--el-text-strong)',
  change: 'bg-(--el-tint-sky) text-(--el-text-strong)',
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
  /** The `update` op behind a `change`, so the tag can name WHAT changed. */
  op?: PlanDeltaUpdateOp;
  children: ReactNode;
}

export function PlanChangeDiffFrame({ state, op, children }: PlanChangeDiffFrameProps) {
  const t = useTranslations('planningWorkspace.conversation.diff');
  const fields = op ? changedFields(op) : [];

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

      <span
        className={`absolute -top-2 left-2.5 inline-flex items-center gap-1 rounded-(--radius-badge) px-(--spacing-chip-x) py-px font-mono text-[10px] font-bold tracking-wide uppercase ${TAG_TONE[state]}`}
      >
        {state === 'add' ? (
          <Plus className="size-3" aria-hidden="true" />
        ) : state === 'change' ? (
          <Pencil className="size-3" aria-hidden="true" />
        ) : (
          <Lock className="size-3" aria-hidden="true" />
        )}
        {t(state)}
      </span>

      {/* A locked node says WHY it can't move; a changed one says what moved. Both
          are real text (never a bare tint), so the state is legible and audible. */}
      {state === 'locked' ? (
        <span className="absolute right-2 -bottom-2 inline-flex items-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) py-px text-[10px] font-semibold text-(--el-text-secondary)">
          {t('cantChange')}
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
 * — the same card the 7.21 plan detail draws a proposal with — by adapting the
 * delta's `create` op to that component's review-item shape. Presentational
 * fields only: `PlanItemNode` reads op / kind / title / identifier / status /
 * stale / changes / hasChildren, so the adapter fills exactly those and nothing
 * is invented about a plan that does not exist yet.
 */
export function ProposedAddNode({ add }: { add: ProposedAdd }) {
  return (
    <PlanChangeDiffFrame state="add">
      <PlanItemNode item={toProposedReviewItem(add)} />
    </PlanChangeDiffFrame>
  );
}

export function toProposedReviewItem(add: ProposedAdd): PlanReviewItemDto {
  return {
    planItemId: add.nodeId,
    op: 'add',
    nodeId: add.nodeId,
    parentNodeId: add.parentNodeId,
    blockedByNodeIds: [],
    identifier: null,
    title: add.op.fields.title,
    kind: add.op.kind,
    priority: add.op.fields.priority ?? null,
    type: add.op.fields.type ?? null,
    descriptionMd: add.op.fields.descriptionMd ?? null,
    status: null,
    hasChildren: add.hasChildren,
    changes: [],
    stale: false,
    staleReasons: [],
    targetMissing: false,
  };
}
