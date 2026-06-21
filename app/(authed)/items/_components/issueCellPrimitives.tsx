'use client';

import { useTranslations } from 'next-intl';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';

// The presentational vocabulary the /items row cells share (Subtask 2.5.3,
// extracted in 2.5.5). A leaf module — no Server Actions, no context — so BOTH
// the static column cells (issueColumns) AND the inline-edit cells
// (IssueInlineEdit) render the SAME pill/avatar for a value, whether the cell is
// read-only or editable. Keeping these here (not in issueColumns) lets the
// inline-edit module import the display without an import cycle.

// Lifecycle category → Pill status tone — the same mapping the detail page's
// ChildList uses (todo→planned, in_progress→in-progress, done→done). All AA-safe
// (finding #35); an unclassifiable status falls back to a neutral Pill.
export const STATUS_TONE: Record<StatusCategoryDto, NonNullable<PillProps['status']>> = {
  todo: 'planned',
  in_progress: 'in-progress',
  done: 'done',
};

/** Initial-letter avatar — mirrors the detail rail / ChildList avatar. */
export function Avatar({ name }: { name: string }) {
  return (
    <span
      className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[10px] font-semibold text-(--el-text-inverted)"
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** The STATUS cell value — a `Pill` by lifecycle category (neutral fallback). */
export function StatusValue({
  category,
  label,
}: {
  category: StatusCategoryDto | null;
  label: string;
}) {
  return category ? (
    <Pill status={STATUS_TONE[category]}>{label}</Pill>
  ) : (
    <Pill tone="neutral">{label}</Pill>
  );
}

/** The ASSIGNEE cell value — avatar + name, or the muted "Unassigned" empty. */
export function AssigneeValue({ name }: { name: string | null }) {
  const t = useTranslations('issues');
  return name ? (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={name} />
      <span className="truncate text-(--el-text-secondary)">{name}</span>
    </span>
  ) : (
    <span className="text-(--el-text-muted)">{t('columns.unassigned')}</span>
  );
}

/** The PRIORITY cell value — the shared PRIORITY_META chip (tone + direction icon). */
export function PriorityValue({ priority }: { priority: WorkItemPriorityDto }) {
  const t = useTranslations('labels');
  const meta = PRIORITY_META[priority];
  return (
    <Pill {...meta.pill}>
      <meta.icon className="h-3 w-3" aria-hidden />
      {t(`priority.${priority}`)}
    </Pill>
  );
}

/** The DUE cell value — the pre-formatted date, or a muted em dash when unset. */
export function DueValue({ label }: { label: string | null }) {
  return label ? (
    <span className="truncate text-(--el-text-secondary)">{label}</span>
  ) : (
    <span className="text-(--el-text-muted)">—</span>
  );
}

/** The ESTIMATE cell value — the pre-formatted duration, or a muted em dash. */
export function EstimateValue({ label }: { label: string | null }) {
  return label ? (
    <span className="truncate text-(--el-text-secondary)">{label}</span>
  ) : (
    <span className="text-(--el-text-muted)">—</span>
  );
}
