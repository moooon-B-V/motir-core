'use client';

import { AlertTriangle, ArchiveX, ChevronRight, Pencil, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WorkItemStatusPill, type WorkItemStatus } from '@/components/planning/WorkItemNode';
import type { IssueType } from '@/lib/issues/parentRules';
import { NODE_H, NODE_W } from '@/lib/planning/projectCanvasModel';
import type { PlanItemChangeDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { StaleReason } from '@/lib/dto/plans';

// The CONTENT of a proposed PlanItem node on the plan-detail canvas (Subtask
// 7.4.5 / MOTIR-847). It draws the SAME compact card language as the shipped
// `WorkItemNode`, layered with the op treatment from the ai-planning design
// (§3 Panel B) — three DISTINCT, non-colliding visual languages that never reuse
// the red dashed/hatched language the canvas reserves for cross-story deps:
//   • add    → dashed ACCENT border + lavender (accent) tint + "add" badge.
//   • modify → the existing node + a solid INFO (sky) ring + "change" badge + an
//              inline old→new diff (old read live, new from the patch; SAME id).
//   • remove → a dimmed, NEUTRAL "will be archived" treatment (muted fill +
//              strike-through title), deliberately not red (archive is reversible).
// Stale items carry a warning badge with the reason. Tokens only; the status pill
// carries TEXT (not colour only); per-kind `IssueTypeIcon`.

const KNOWN_STATUSES = new Set<WorkItemStatus>([
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
]);
const KNOWN_KINDS = new Set<IssueType>(['epic', 'story', 'task', 'bug', 'subtask']);

function toKind(raw: string): IssueType {
  return KNOWN_KINDS.has(raw as IssueType) ? (raw as IssueType) : 'task';
}
function toStatus(raw: string | null): WorkItemStatus | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/[\s-]+/g, '_');
  return KNOWN_STATUSES.has(s as WorkItemStatus) ? (s as WorkItemStatus) : 'todo';
}

const KIND_TINT: Record<IssueType, string> = {
  epic: 'bg-(--el-tint-rose)',
  story: 'bg-(--el-tint-mint)',
  task: 'bg-(--el-tint-sky)',
  bug: 'bg-(--el-tint-peach)',
  subtask: 'bg-(--el-tint-lavender)',
};

function staleReasonLabel(r: StaleReason, t: ReturnType<typeof useTranslations>): string {
  switch (r.code) {
    case 'parent_removed':
      return t('staleParentRemoved');
    case 'siblings_added':
      return t('staleSiblingsAdded');
    case 'blocker_removed':
      return t('staleBlockerRemoved');
    case 'base_revision_drift':
      return t(`staleDrift_${r.change}`);
  }
}

export function PlanItemNode({
  item,
  onEdit,
}: {
  item: PlanReviewItemDto;
  /** Open the inline-edit form for a proposed `add` (7.21.6 · MOTIR-1370). When
   *  supplied, an `add` node shows an Edit affordance; only an `add` is editable
   *  (modify/remove target existing items), so the trigger renders for `add` only. */
  onEdit?: (planItemId: string) => void;
}) {
  const t = useTranslations('planReview');
  const kind = toKind(item.kind);
  const status = toStatus(item.status);

  // Op-specific frame. None reuses the cross-story red dashed/hatch language.
  const frame =
    item.op === 'add'
      ? 'border border-dashed border-(--el-accent) bg-(--el-tint-lavender) shadow-(--shadow-card)'
      : item.op === 'remove'
        ? 'border border-(--el-border-strong) bg-(--el-muted) opacity-80 shadow-(--shadow-subtle)'
        : 'border border-(--el-border) bg-(--el-surface) ring-2 ring-(--el-info) shadow-(--shadow-card)';

  return (
    <div
      // Fixed footprint (= the layout's NODE_W/NODE_H) so a node never grows into
      // the row below — the deterministic layout spaces rows by NODE_H.
      style={{ width: NODE_W, height: NODE_H }}
      className={`flex flex-col overflow-hidden rounded-(--radius-card) p-3 ${frame}`}
      data-op={item.op}
      data-testid="plan-item-node"
    >
      {/* TOP ROW — the op badge (left) + the status pill / stale flag (right). */}
      <div className="flex shrink-0 items-center gap-2">
        <OpBadge op={item.op} t={t} />
        <div className="ml-auto flex items-center gap-1.5">
          {item.stale ? (
            <span
              data-testid="stale-badge"
              title={item.staleReasons.map((r) => staleReasonLabel(r, t)).join(' · ')}
              className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-yellow) px-1.5 py-0.5 text-[11px] font-semibold text-(--el-text-strong)"
            >
              <AlertTriangle className="size-3" aria-hidden="true" />
              {t('staleBadge')}
            </span>
          ) : null}
          {status ? <WorkItemStatusPill status={status} /> : null}
          {item.hasChildren ? (
            <ChevronRight
              className="size-4 shrink-0 text-(--el-text-muted)"
              aria-hidden="true"
              data-testid="drill-affordance"
            />
          ) : null}
          {item.op === 'add' && onEdit ? (
            <button
              type="button"
              data-testid="edit-proposal"
              aria-label={t('editTriggerAria')}
              // Stop the press/click from starting a canvas drag or selecting the
              // node — same guard the canvas's View/Open action buttons use.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onEdit(item.planItemId);
              }}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {/* BODY — the kind tile + identifier + title. */}
      <div className="mt-1.5 flex min-h-0 flex-1 items-start gap-2 overflow-hidden">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) ${KIND_TINT[kind]}`}
          aria-hidden="true"
        >
          <IssueTypeIcon type={kind} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <span className="block font-mono text-xs text-(--el-text-faint)">
            {item.identifier ?? t('newItem')}
          </span>
          <span
            className={`mt-0.5 line-clamp-2 block text-sm leading-snug font-semibold ${
              item.op === 'remove' ? 'text-(--el-text-muted) line-through' : 'text-(--el-text)'
            }`}
          >
            {item.title}
          </span>
        </div>
      </div>

      {/* MODIFY diff — a compact old→new line (the first change; "+N" when more). */}
      {item.op === 'modify' && item.changes.length > 0 ? (
        <DiffLine changes={item.changes} t={t} />
      ) : null}
    </div>
  );
}

function OpBadge({
  op,
  t,
}: {
  op: PlanReviewItemDto['op'];
  t: ReturnType<typeof useTranslations>;
}) {
  if (op === 'add') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-surface) px-1.5 py-0.5 text-[11px] font-semibold text-(--el-accent-on-surface)">
        <Plus className="size-3" aria-hidden="true" />
        {t('opAdd')}
      </span>
    );
  }
  if (op === 'remove') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-surface) px-1.5 py-0.5 text-[11px] font-semibold text-(--el-text-secondary)">
        <ArchiveX className="size-3" aria-hidden="true" />
        {t('opRemove')}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-sky) px-1.5 py-0.5 text-[11px] font-semibold text-(--el-text-strong)">
      <Pencil className="size-3" aria-hidden="true" />
      {t('opModify')}
    </span>
  );
}

function DiffLine({
  changes,
  t,
}: {
  changes: PlanItemChangeDto[];
  t: ReturnType<typeof useTranslations>;
}) {
  const first = changes[0]!;
  const more = changes.length - 1;
  return (
    <div
      data-testid="diff-line"
      className="mt-1.5 flex shrink-0 items-center gap-1 overflow-hidden text-xs text-(--el-text-secondary)"
    >
      <span className="shrink-0 font-medium text-(--el-text-muted)">
        {t(`field_${first.field}`)}
      </span>
      {first.from != null ? (
        <span className="truncate text-(--el-text-muted) line-through">{first.from}</span>
      ) : null}
      <ChevronRight className="size-3 shrink-0 text-(--el-text-faint)" aria-hidden="true" />
      <span className="truncate font-medium text-(--el-text)">{first.to ?? '—'}</span>
      {more > 0 ? (
        <span className="ml-auto shrink-0 text-(--el-text-faint)">
          {t('moreChanges', { n: more })}
        </span>
      ) : null}
    </div>
  );
}
