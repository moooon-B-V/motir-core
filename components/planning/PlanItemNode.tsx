'use client';

import { AlertTriangle, ArchiveX, ChevronRight, Pencil, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WorkItemStatusPill } from '@/components/planning/WorkItemNode';
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

// ⚠️ THE THIRD COPY OF THE STATUS SET USED TO LIVE HERE, AND IT IS GONE (bug
// MOTIR-3170). It was a six-member literal that coerced anything outside itself
// to `todo`, so a `modify` proposal whose live target sat at `implemented` drew
// on the plan canvas as **To Do** — a confident false statement about a card
// whose pull request was open. The status KEY now travels verbatim to the ONE
// shared chip (`WorkItemStatusPill` → `lib/workflows/canvasStatusMeta.ts`), and
// there is deliberately no mapping left in `components/planning/` to forget to
// update the next time a status is added.
const KNOWN_KINDS = new Set<IssueType>(['epic', 'story', 'task', 'bug', 'subtask']);

function toKind(raw: string): IssueType {
  return KNOWN_KINDS.has(raw as IssueType) ? (raw as IssueType) : 'task';
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

// ⚠️ The node carries NO edit affordance (MOTIR-3084). MOTIR-1370's inline-edit
// pencil and its modal are REMOVED: a proposal is READ — the canvas peek — and
// changed by re-planning, not hand-corrected in a five-field form. The design
// records the supersession in `design/ai-planning/design-notes.md` Part V §3.
export function PlanItemNode({ item }: { item: PlanReviewItemDto }) {
  const t = useTranslations('planReview');
  const kind = toKind(item.kind);

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
          {item.status ? (
            <WorkItemStatusPill
              status={item.status}
              label={item.statusLabel}
              category={item.statusCategory}
            />
          ) : null}
          {item.hasChildren ? (
            <ChevronRight
              className="size-4 shrink-0 text-(--el-text-muted)"
              aria-hidden="true"
              data-testid="drill-affordance"
            />
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
          <span className="block font-mono text-xs text-(--el-text-secondary)">
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

/** The label for a changed field, degrading to the field's own WIRE NAME when
 *  the catalog has no message for it (MOTIR-3151).
 *
 *  The key is INTERPOLATED (`field_<name>`), so nothing checks it at build time:
 *  `buildChanges` grew `storyPoints` / `estimateMinutes` in MOTIR-1532 and the
 *  labels never followed, and with no `getMessageFallback` configured
 *  (`i18n/request.ts`) `t()` renders the KEY PATH — a reader of the approve
 *  screen saw `planReview.field_storyPoints` where a word belongs. `t.has()`
 *  asks the catalog first, so the NEXT field somebody teaches `buildChanges` to
 *  emit degrades to something readable instead of leaking a key. This is the
 *  same fallback `PlanEditsReviewDock` has always had, which is why its own
 *  gap was cosmetic and this one was not.
 *
 *  The copy itself is still owed — `plan-change-field-labels.test.tsx` fails
 *  when a `PLAN_ITEM_CHANGE_FIELDS` member has no message. */
function fieldLabel(t: ReturnType<typeof useTranslations>, field: string): string {
  const key = `field_${field}`;
  return t.has(key) ? t(key) : field;
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
        {fieldLabel(t, first.field)}
      </span>
      {first.from != null ? (
        <span className="truncate text-(--el-text-muted) line-through">{first.from}</span>
      ) : null}
      <ChevronRight className="size-3 shrink-0 text-(--el-text-faint)" aria-hidden="true" />
      <span className="truncate font-medium text-(--el-text)">{first.to ?? '—'}</span>
      {more > 0 ? (
        <span className="ml-auto shrink-0 text-(--el-text-secondary)">
          {t('moreChanges', { n: more })}
        </span>
      ) : null}
    </div>
  );
}
