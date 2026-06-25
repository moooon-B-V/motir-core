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
}: {
  item: WorkItemNodeData;
  /** Has children — clicking DRILLS in; show the affordance. */
  drillable?: boolean;
  /** Blocked by an item on ANOTHER level — flag the bad-plan tangle (MOTIR-1331). */
  crossBlocked?: boolean;
}) {
  return (
    <div
      // Fixed height (= the layout's NODE_H) so a long, two-line title can never
      // grow the card into the row below it — the deterministic layout spaces rows
      // by NODE_H, so the card must honour it exactly. Compact: tight padding + a
      // small status chip, no wasted space (MOTIR-1194 review).
      style={{ width: NODE_W, height: NODE_H }}
      className={`flex flex-col overflow-hidden rounded-(--radius-card) border p-3.5 ${
        crossBlocked
          ? 'border-(--el-danger) bg-(--el-surface) shadow-[0_0_0_1px_var(--el-danger)_inset] shadow-(--shadow-subtle)'
          : 'border-(--el-border-soft) bg-(--el-surface) shadow-(--shadow-subtle)'
      }`}
    >
      {/* TOP ROW — a compact STATUS chip (top-left), and the cross-link tag (or the
          has-children hint) pushed to the right. Keeping status here frees the body
          below for the title. */}
      <div className="flex shrink-0 items-center gap-2">
        <WorkItemStatusPill status={item.status} />
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

      {item.assigneeName ? (
        <span className="shrink-0 truncate pt-1.5 text-right text-xs text-(--el-text-muted)">
          {item.assigneeName}
        </span>
      ) : null}
    </div>
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
