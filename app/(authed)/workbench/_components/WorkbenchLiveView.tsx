'use client';

import { useCallback, useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { HomeTabCountsDto, ToResumePlanningSessionDto } from '@/lib/dto/home';
import type { WorkbenchWindowDto } from '@/lib/dto/workbench';
import { keepIfEqual, mergeRowsByIdentity } from '@/lib/workbench/mergeRows';
import type { WorkbenchTab } from '@/lib/workbench/tab';
import { WorkbenchList } from './WorkbenchList';
import { WorkbenchReconnecting } from './WorkbenchLive';
import { WorkbenchTabStrip, type WorkbenchTabStripMessage } from './WorkbenchTabs';
import { toWorkbenchRowViews, type WorkbenchRowView } from './workbenchRows';
import { useWorkbenchWindow } from './useWorkbenchWindow';

// THE WORKBENCH'S LIVE VIEW (Story MOTIR-8539 · Subtask MOTIR-8574) — the strip,
// the window caption and the list, drawn from `useWorkbenchWindow`'s state rather
// than from server props, so a nudge is applied IN PLACE: one read of
// `GET /api/workbench/window`, rows and counts set together, no route refresh.
//
// ⚠️ THE FIRST PAINT IS THE SERVER'S, unchanged. The page reads the window and the
// counts through `workbenchWindowService.read` and hands them in as the seed; this
// component only takes over once a signal arrives.
//
// ⚠️ TO APPROVE AND PLANNING KEEP THEIR SERVER BODIES here (they go live in
// MOTIR-8575): the page passes them as `children`, and the strip above them still
// takes its counts from this state, so the numbers move with every nudge on those
// tabs too.

/** A work-item tab's window, as the list draws it. */
export interface WorkbenchWorkItemContent {
  rows: WorkbenchRowView[];
  pagination: { total: number; page: number; pageSize: number };
  planningSessions: ToResumePlanningSessionDto[];
}

/** Whether `tab` lists work items — the six tabs this view draws a list for. */
function listsWorkItems(tab: WorkbenchTab): boolean {
  return tab !== 'approvals' && tab !== 'planning';
}

/**
 * A grouped row's members merged by identity BEFORE the row itself is compared,
 * so a change to one member keeps every other member's object (and its render).
 */
function mergeHeads(prev: WorkbenchRowView[], next: WorkbenchRowView[]): WorkbenchRowView[] {
  const before = new Map(prev.map((row) => [row.id, row]));
  const withMembers = next.map((row) => {
    const old = before.get(row.id);
    if (!old || row.groupMembers.length === 0) return row;
    const groupMembers = mergeRowsByIdentity(old.groupMembers, row.groupMembers, (m) => m.id);
    return groupMembers === row.groupMembers ? row : { ...row, groupMembers };
  });
  return mergeRowsByIdentity(prev, withMembers, (row) => row.id);
}

/** `next` over `prev`, keeping every unchanged part — and `prev` itself when nothing changed. */
export function mergeWorkItemContent(
  prev: WorkbenchWorkItemContent,
  next: WorkbenchWorkItemContent,
): WorkbenchWorkItemContent {
  const rows = mergeHeads(prev.rows, next.rows);
  const pagination = keepIfEqual(prev.pagination, next.pagination);
  const planningSessions = mergeRowsByIdentity(
    prev.planningSessions,
    next.planningSessions,
    (entry) => entry.sessionId,
  );
  if (
    rows === prev.rows &&
    pagination === prev.pagination &&
    planningSessions === prev.planningSessions
  ) {
    return prev;
  }
  return { rows, pagination, planningSessions };
}

/** A window answer as this view draws it — `null` for To approve and Planning. */
export function workItemContentOf(read: WorkbenchWindowDto): WorkbenchWorkItemContent | null {
  if (read.window.kind !== 'workItems') return null;
  const { page, workflow, members } = read.window;
  return {
    rows: toWorkbenchRowViews(page.items, workflow, members, read.tab === 'watching'),
    pagination: { total: page.total, page: page.page, pageSize: page.pageSize },
    planningSessions: read.tab === 'to-resume' ? (page.planningSessions ?? []) : [],
  };
}

export function WorkbenchLiveView({
  tab,
  page,
  rows,
  pagination,
  planningSessions,
  counts,
  label,
  caption = null,
  empty,
  viewerId,
  children = null,
}: {
  tab: WorkbenchTab;
  /** The page the URL asked for (1-based) — what a re-read asks for again. */
  page: number;
  rows: WorkbenchRowView[];
  pagination: WorkbenchWorkItemContent['pagination'];
  planningSessions: ToResumePlanningSessionDto[];
  counts: HomeTabCountsDto;
  /** The list's accessible name — the tab's own label. */
  label: string;
  /** The window caption between the strip and the list (Recently finished's). */
  caption?: ReactNode;
  empty: ReactNode;
  viewerId: string;
  /** To approve's or Planning's server body, drawn under the live strip. */
  children?: ReactNode;
}) {
  const t = useTranslations('workbench');
  const translate = useCallback((key: WorkbenchTabStripMessage) => t(key), [t]);
  const content = useMemo<WorkbenchWorkItemContent>(
    () => ({ rows, pagination, planningSessions }),
    [rows, pagination, planningSessions],
  );
  const live = useWorkbenchWindow<WorkbenchWorkItemContent>({
    tab,
    page,
    content,
    counts,
    fromWindow: workItemContentOf,
    merge: mergeWorkItemContent,
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <WorkbenchTabStrip active={tab} counts={live.counts} t={translate} />
        {/* Beside the strip at `≥ md`, and BELOW it at `< md` — the strip
            already scrolls at that width, and a chip inside a scrolling
            track is a chip that can be scrolled out of sight (§ 26). */}
        <WorkbenchReconnecting />
      </div>
      {caption}
      {listsWorkItems(tab) ? (
        <WorkbenchList
          rows={live.content.rows}
          label={label}
          tab={tab}
          pagination={live.content.pagination}
          empty={empty}
          viewerId={viewerId}
          planningSessions={live.content.planningSessions}
          reread={live.reread}
        />
      ) : (
        children
      )}
    </div>
  );
}
