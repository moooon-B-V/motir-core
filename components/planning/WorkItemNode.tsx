'use client';

import {
  ArrowUpRight,
  Ban,
  Check,
  ChevronRight,
  CircleDashed,
  CircleDot,
  Eye,
  Flag,
  MapPin,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import type { IssueType } from '@/lib/issues/parentRules';
import { NODE_H, NODE_W } from '@/lib/planning/projectCanvasModel';

// The CONTENT of a WORK-ITEM node on the project roadmap (Subtask 7.20.2 /
// MOTIR-1194) — the card the reusable `ProjectRoadmapCanvas` renders for an epic /
// story / subtask (the tier/design/plan stations render as `StationCard` instead).
// It owns the card's look in the shipped StationCard language: the kind-coloured
// tile (the kind's `--el-type-*` hue via `IssueTypeIcon`), the identifier + title,
// the status pill, and the drill affordance when the node has children. The canvas
// owns the box, position, drag, and the search-match ring. Tokens only.
//
// Subtask 7.20.6 / MOTIR-1013 adds two roadmap markers: a per-container PROGRESS
// meter (the subtree done/total bar on an epic/story) and the "YOU ARE HERE"
// current-position marker (the active node — its status pill is replaced by an
// accent map-pin pill, the card gets an accent border, and `aria-current="step"`).

/** A container's subtree done/total roll-up — the data behind the progress meter
 *  (Subtask 7.20.6 / MOTIR-1013). Mirrors `RoadmapProgress` in `roadmapClient`;
 *  kept local so the presentational node has no upward data dependency. */
export interface WorkItemProgress {
  done: number;
  total: number;
}

export type WorkItemStatus =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

export interface WorkItemNodeData {
  id: string;
  identifier: string;
  title: string;
  kind: IssueType;
  status: WorkItemStatus;
  assigneeName?: string | null;
}

export const STATUS_LABELS: Record<WorkItemStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

interface StatusMeta {
  icon: LucideIcon;
  tint: string;
  text: string;
}

const STATUS_META: Record<WorkItemStatus, StatusMeta> = {
  done: { icon: Check, tint: 'bg-(--el-tint-mint)', text: 'text-(--el-text-strong)' },
  in_progress: { icon: CircleDot, tint: 'bg-(--el-tint-sky)', text: 'text-(--el-text-strong)' },
  in_review: { icon: Eye, tint: 'bg-(--el-tint-lavender)', text: 'text-(--el-text-strong)' },
  blocked: { icon: Ban, tint: 'bg-(--el-tint-peach)', text: 'text-(--el-text-strong)' },
  todo: { icon: CircleDashed, tint: 'bg-(--el-muted)', text: 'text-(--el-text-secondary)' },
  cancelled: { icon: XCircle, tint: 'bg-(--el-muted)', text: 'text-(--el-text-secondary)' },
};

const KIND_TINT: Record<IssueType, string> = {
  epic: 'bg-(--el-tint-rose)',
  story: 'bg-(--el-tint-mint)',
  task: 'bg-(--el-tint-sky)',
  bug: 'bg-(--el-tint-peach)',
  subtask: 'bg-(--el-tint-lavender)',
};

export function WorkItemStatusPill({ status }: { status: WorkItemStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) px-1.5 py-0.5 text-[11px] font-medium ${meta.tint} ${meta.text}`}
    >
      <Icon className="size-3" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function WorkItemNode({
  item,
  drillable = false,
  crossBlocked = false,
  progress = null,
  here = false,
}: {
  item: WorkItemNodeData;
  /** Has children — clicking DRILLS in; show the affordance. */
  drillable?: boolean;
  /** Blocked by an item on ANOTHER level — flag the bad-plan tangle (MOTIR-1331). */
  crossBlocked?: boolean;
  /** Subtree done/total roll-up → a thin progress meter on a container node
   *  (Subtask 7.20.6 / MOTIR-1013). `null` (a leaf) or a `0`-total → no meter. */
  progress?: WorkItemProgress | null;
  /** The current-position node ("you are here", the active epic at the road's
   *  start) — its status pill becomes an accent map-pin pill, the card gets an
   *  accent border, and it carries `aria-current="step"` (Subtask 7.20.6 /
   *  MOTIR-1013). */
  here?: boolean;
}) {
  const showMeter = progress !== null && progress.total > 0;
  const pct = showMeter ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div
      // Fixed height (= the layout's NODE_H) so a long, two-line title can never
      // grow the card into the row below it — the deterministic layout spaces rows
      // by NODE_H, so the card must honour it exactly. Compact: tight padding + a
      // small status chip, no wasted space (MOTIR-1194 review).
      style={{ width: NODE_W, height: NODE_H }}
      // The current-position node carries `aria-current="step"` (the design's
      // "You are here" semantics — a step in the journey), so AT it reads as the
      // active waypoint, not just a visual ring.
      aria-current={here ? 'step' : undefined}
      // A raised `--el-surface` tile on the recessed `--el-canvas` board (the canvas
      // background, MOTIR-1362): the fill is now clearly lighter than the board in
      // BOTH themes, and the crisp `--el-border` + `--shadow-card` lift (matching the
      // onboarding StationCard) defines the edge — so the card stands out instead of
      // melting into the canvas. The active "you are here" node takes an accent
      // border (the StationCard ringed-active language); a cross-story tangle still
      // wins the border (it's the louder, must-not-miss signal).
      className={`flex flex-col overflow-hidden rounded-(--radius-card) border p-3.5 bg-(--el-surface) shadow-(--shadow-card) ${
        crossBlocked
          ? 'border-(--el-danger) shadow-[0_0_0_1px_var(--el-danger)_inset] shadow-(--shadow-card)'
          : here
            ? 'border-(--el-accent)'
            : 'border-(--el-border)'
      }`}
    >
      {/* TOP ROW — the compact STATUS chip (top-left) — REPLACED by the accent
          "You are here" pill on the current-position node — and the cross-link tag
          (or the has-children hint) pushed to the right. */}
      <div className="flex shrink-0 items-center gap-2">
        {here ? <HerePill /> : <WorkItemStatusPill status={item.status} />}
        {crossBlocked ? (
          <span
            data-testid="cross-blocked-flag"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-danger-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-danger-text)"
          >
            <Flag className="size-3" aria-hidden="true" />
            cross-story
          </span>
        ) : drillable ? (
          <ChevronRight
            className="ml-auto size-4 shrink-0 text-(--el-text-muted)"
            aria-hidden="true"
            data-testid="drill-affordance"
          />
        ) : null}
      </div>

      {/* BODY — the kind tile + identifier + title; the title gets the room. */}
      <div className="mt-1.5 flex min-h-0 flex-1 items-start gap-2 overflow-hidden">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) ${KIND_TINT[item.kind]}`}
          aria-hidden="true"
        >
          <IssueTypeIcon type={item.kind} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <span className="block font-mono text-xs text-(--el-text-faint)">{item.identifier}</span>
          <span className="mt-0.5 line-clamp-2 block text-sm leading-snug font-semibold text-(--el-text)">
            {item.title}
          </span>
        </div>
      </div>

      {/* PROGRESS METER (Subtask 7.20.6 / MOTIR-1013) — a thin done/total bar on a
          container node: `--el-success` fill over the `--el-muted` track, with the
          count beside it. Leaves (no `progress`) and `0`-total containers omit it. */}
      {showMeter ? (
        <div className="mt-2 flex shrink-0 items-center gap-2" data-testid="progress-meter">
          <div
            role="progressbar"
            aria-label="Subtree progress"
            aria-valuenow={progress.done}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-(--radius-badge) bg-(--el-muted)"
          >
            <div
              className="h-full rounded-(--radius-badge) bg-(--el-success)"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="shrink-0 text-xs font-medium text-(--el-text-muted) tabular-nums">
            {progress.done} / {progress.total}
          </span>
        </div>
      ) : item.assigneeName ? (
        <span className="shrink-0 truncate pt-1.5 text-right text-xs text-(--el-text-muted)">
          {item.assigneeName}
        </span>
      ) : null}
    </div>
  );
}

/** The "You are here" current-position pill (Subtask 7.20.6 / MOTIR-1013) — an
 *  accent map-pin chip in the StationCard's active-state language; it takes the
 *  status pill's slot on the active node. */
function HerePill() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-accent) px-1.5 py-0.5 text-[11px] font-medium text-(--el-accent-text)">
      <MapPin className="size-3" aria-hidden="true" />
      You are here
    </span>
  );
}

/**
 * The GHOST ANCHOR for an off-level blocker (MOTIR-1331) — a dashed-red, hatched
 * chip that names the blocker the canvas can't show a node for ("PROD-42 ↗ in
 * Story X"), so the red cross-story edge has a target.
 */
export function GhostAnchor({
  identifier,
  title,
  parentTitle,
}: {
  identifier: string;
  title: string;
  parentTitle: string | null;
}) {
  return (
    <div
      style={{
        width: 200,
        backgroundImage:
          'repeating-linear-gradient(135deg, var(--el-surface), var(--el-surface) 7px, var(--el-danger-surface) 7px, var(--el-danger-surface) 9px)',
      }}
      className="rounded-(--radius-card) border border-dashed border-(--el-danger) p-(--spacing-card-padding)"
    >
      <span className="flex items-center gap-1.5 font-mono text-xs font-semibold text-(--el-danger-text)">
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
        {identifier}
      </span>
      <span className="mt-1 line-clamp-1 block text-xs text-(--el-text-secondary)">{title}</span>
      {parentTitle ? (
        <span className="mt-0.5 block text-xs text-(--el-danger)">in {parentTitle} ↗</span>
      ) : (
        <span className="mt-0.5 block text-xs text-(--el-danger)">elsewhere in the plan ↗</span>
      )}
    </div>
  );
}
