'use client';

import {
  Ban,
  Check,
  ChevronRight,
  CircleDashed,
  CircleDot,
  Eye,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import {
  STATUS_LABELS,
  type WorkItemCanvasItem,
  type WorkItemCanvasStatus,
} from '@/lib/planning/workItemCanvasModel';
import { NODE_W } from '@/lib/planning/workItemCanvasModel';

// The CONTENT of a work-item canvas node (Subtask 7.20.2 / MOTIR-1194) — the card
// the reusable `WorkItemCanvas` renders inside each `PlanningCanvas` node. The
// canvas owns the box, position + drag; this owns the card's look in the shipped
// `StationCard` language: the type-coloured tile (the kind's `--el-type-*` hue via
// `IssueTypeIcon`), the identifier + title, the status pill, and the drill
// affordance when the node has children. Tokens only (`--el-*` + shape).

interface StatusMeta {
  icon: LucideIcon;
  /** tint BACKGROUND class (the hue lives in the tint, AA-safe text — finding #35) */
  tint: string;
  /** text class — strong on a hued tint, secondary on the neutral muted fill */
  text: string;
}

const STATUS_META: Record<WorkItemCanvasStatus, StatusMeta> = {
  done: { icon: Check, tint: 'bg-(--el-tint-mint)', text: 'text-(--el-text-strong)' },
  in_progress: { icon: CircleDot, tint: 'bg-(--el-tint-sky)', text: 'text-(--el-text-strong)' },
  in_review: { icon: Eye, tint: 'bg-(--el-tint-lavender)', text: 'text-(--el-text-strong)' },
  blocked: { icon: Ban, tint: 'bg-(--el-tint-peach)', text: 'text-(--el-text-strong)' },
  todo: { icon: CircleDashed, tint: 'bg-(--el-muted)', text: 'text-(--el-text-secondary)' },
  cancelled: { icon: XCircle, tint: 'bg-(--el-muted)', text: 'text-(--el-text-secondary)' },
};

const KIND_TINT: Record<WorkItemCanvasItem['kind'], string> = {
  epic: 'bg-(--el-tint-rose)',
  story: 'bg-(--el-tint-mint)',
  task: 'bg-(--el-tint-sky)',
  bug: 'bg-(--el-tint-peach)',
  subtask: 'bg-(--el-tint-lavender)',
};

export function WorkItemStatusPill({ status }: { status: WorkItemCanvasStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium ${meta.tint} ${meta.text}`}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function WorkItemNode({
  item,
  drillable = false,
  highlighted = false,
  dimmed = false,
}: {
  item: WorkItemCanvasItem;
  /** Has children — clicking DRILLS in; show the affordance. */
  drillable?: boolean;
  /** The search-to-focus match — ringed + raised. */
  highlighted?: boolean;
  /** Filtered out by the active status/assignee filter — kept on the map, faded. */
  dimmed?: boolean;
}) {
  return (
    <div
      style={{ width: NODE_W }}
      data-highlighted={highlighted || undefined}
      className={[
        'rounded-(--radius-card) border p-(--spacing-card-padding)',
        highlighted
          ? 'border-(--el-accent) bg-(--el-surface-soft) shadow-(--shadow-card)'
          : 'border-(--el-border-soft) bg-(--el-surface) shadow-(--shadow-subtle)',
        dimmed ? 'opacity-40' : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) ${KIND_TINT[item.kind]}`}
          aria-hidden="true"
        >
          <IssueTypeIcon type={item.kind} className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <span className="block font-mono text-xs text-(--el-text-faint)">{item.identifier}</span>
          <span className="mt-0.5 line-clamp-2 block text-sm leading-snug font-semibold text-(--el-text)">
            {item.title}
          </span>
        </div>
        {drillable && (
          <ChevronRight
            className="size-4 shrink-0 text-(--el-text-muted)"
            aria-hidden="true"
            data-testid="drill-affordance"
          />
        )}
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <WorkItemStatusPill status={item.status} />
        {item.assigneeName ? (
          <span className="truncate text-xs text-(--el-text-muted)">{item.assigneeName}</span>
        ) : null}
      </div>
    </div>
  );
}
