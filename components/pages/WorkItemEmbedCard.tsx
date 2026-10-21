'use client';

import { Archive } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { AvailableWorkItemRefView } from '@motir/pages';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WorkItemTypeIcon } from '@/components/issues/WorkItemTypeIcon';
import { Pill } from '@/components/ui/Pill';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';
import type { IssueType } from '@/lib/issues/parentRules';
import { cn } from '@/lib/utils/cn';

// The LIVE embedded work-item card (Story MOTIR-7566 · MOTIR-9182), to
// `design/pages/page--work-item-embed.mock.html` and
// `design/pages/design-notes.md` § _Embed a work item_ — what `<PageEditor>`'s
// card node view hands the host to draw for an item the reader may see.
//
// It draws exactly five facts about the item and nothing else: the type's glyph,
// the mono key, the title, the status pill and the assignee. The frame is the
// package's — in the editor a `role="group"`, in the read-only page the ONE
// `<a>` — so this component holds no link and no button of its own.
//
// Colour is `--el-*` only and shape the element shape tokens only.

const STATUS_TONE = { todo: 'planned', in_progress: 'in-progress', done: 'done' } as const;

/** The assignee's initials for the avatar tile. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function WorkItemEmbedCard({ view }: { view: AvailableWorkItemRefView }) {
  const t = useTranslations('pages.embed');
  const tl = useTranslations('labels');
  const type = view.type as WorkItemTypeDto | null;
  const typeName = type ? tl(`workItemType.${type}`) : null;
  const assigneeName = view.assignee?.name ?? null;

  return (
    <span
      data-testid="work-item-embed-card"
      className={cn(
        'wi-card flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-(--radius-card) border border-(--el-border) px-(--spacing-card-padding-16) py-(--spacing-card-padding-12) text-left',
        view.archived ? 'is-archived bg-(--el-surface-soft)' : 'bg-(--el-card)',
      )}
    >
      {type && typeName ? (
        <span role="img" aria-label={t('typeLabel', { type: typeName })} className="inline-flex">
          <WorkItemTypeIcon type={type} className="h-4 w-4" />
        </span>
      ) : (
        <IssueTypeIcon type={view.kind as IssueType} className="h-4 w-4 shrink-0" />
      )}
      <span className="font-mono text-xs text-(--el-text-identifier)">{view.identifier}</span>
      {view.status ? (
        <Pill status={STATUS_TONE[view.status.category]}>{view.status.label}</Pill>
      ) : (
        <Pill tone="neutral" className="border-dashed">
          {t('noStatus')}
        </Pill>
      )}
      {view.archived ? (
        <Pill tone="neutral">
          <Archive className="h-3 w-3" aria-hidden />
          {t('archived')}
        </Pill>
      ) : null}
      <span
        title={view.title}
        className="order-last line-clamp-2 min-w-0 basis-full text-[15px] leading-snug font-semibold text-(--el-text-strong) md:order-none md:basis-0 md:flex-1"
      >
        {view.title}
      </span>
      <span className="ml-auto inline-flex items-center gap-2 text-xs text-(--el-text-secondary)">
        {assigneeName || view.assignee ? (
          <>
            <span
              aria-hidden
              className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-(--el-avatar-fallback) font-mono text-[9px] text-(--el-text-strong)"
            >
              {initialsOf(assigneeName ?? '')}
            </span>
            <span>{assigneeName}</span>
          </>
        ) : (
          <>
            <span
              aria-hidden
              className="inline-flex h-5 w-5 rounded-full border border-dashed border-(--el-border-strong)"
            />
            {t('unassigned')}
          </>
        )}
      </span>
    </span>
  );
}
