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
import { useRegisterWorkbenchReread } from '@/lib/workbench/workbenchReread';
import {
  WorkbenchTabWindowContext,
  type WorkbenchTabWindowDto,
  type WorkbenchTabWindowValue,
} from './useTabWindowContent';

// THE WORKBENCH'S LIVE VIEW (Story MOTIR-8539 · Subtask MOTIR-8574) — the strip,
// the window caption and the list, drawn from `useWorkbenchWindow`'s state rather
// than from server props, so a nudge is applied IN PLACE: one read of
// `GET /api/workbench/window`, rows and counts set together, no route refresh.
//
// ⚠️ THE FIRST PAINT IS THE SERVER'S, unchanged. The page reads the window and the
// counts through `workbenchWindowService.read` and hands them in as the seed; this
// component only takes over once a signal arrives.
//
// ⚠️ TO APPROVE AND PLANNING KEEP THEIR SERVER-SEEDED BODIES, and are live too
// (MOTIR-8581). The page passes them as `children` — each reads its first paint
// inside its own `<Suspense>`, unchanged — and this view publishes the window the
// SAME read answered for them through `WorkbenchTabWindowContext`, so their rows
// and the strip's counts move in one update (`useTabWindowContent`).

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

/** What the view holds: a work-item tab's list, or the last To approve / Planning window. */
interface WorkbenchViewContent {
  items: WorkbenchWorkItemContent;
  tabWindow: WorkbenchTabWindowDto | null;
}

/** The work-item part of an answer for To approve or Planning: none, so it keeps what is held. */
const EMPTY_CONTENT: WorkbenchWorkItemContent = {
  rows: [],
  pagination: { total: 0, page: 1, pageSize: 0 },
  planningSessions: [],
};

function viewContentOf(read: WorkbenchWindowDto): WorkbenchViewContent | null {
  if (read.window.kind === 'workItems') {
    const items = workItemContentOf(read);
    return items === null ? null : { items, tabWindow: null };
  }
  return { items: EMPTY_CONTENT, tabWindow: read.window };
}

/** `next` over `prev`, part by part — a part `next` does not carry keeps `prev`'s. */
function mergeViewContent(
  prev: WorkbenchViewContent,
  next: WorkbenchViewContent,
): WorkbenchViewContent {
  const items =
    next.items === EMPTY_CONTENT ? prev.items : mergeWorkItemContent(prev.items, next.items);
  const tabWindow =
    next.tabWindow === null ? prev.tabWindow : keepIfEqual(prev.tabWindow, next.tabWindow);
  if (items === prev.items && tabWindow === prev.tabWindow) return prev;
  return { items, tabWindow };
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
  /** To approve's or Planning's server-seeded body, live through the tab-window context. */
  children?: ReactNode;
}) {
  const t = useTranslations('workbench');
  const translate = useCallback((key: WorkbenchTabStripMessage) => t(key), [t]);
  const content = useMemo<WorkbenchViewContent>(
    () => ({ items: { rows, pagination, planningSessions }, tabWindow: null }),
    [rows, pagination, planningSessions],
  );
  const live = useWorkbenchWindow<WorkbenchViewContent>({
    tab,
    page,
    content,
    counts,
    fromWindow: viewContentOf,
    merge: mergeViewContent,
  });
  // The overlay's approve asks THIS read to run, through the shell (MOTIR-8576).
  useRegisterWorkbenchReread(live.reread);
  const tabWindow = useMemo<WorkbenchTabWindowValue>(
    () => ({ window: live.content.tabWindow, reread: live.reread, failures: live.failures }),
    [live.content.tabWindow, live.reread, live.failures],
  );

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
          rows={live.content.items.rows}
          label={label}
          tab={tab}
          pagination={live.content.items.pagination}
          empty={empty}
          viewerId={viewerId}
          planningSessions={live.content.items.planningSessions}
          reread={live.reread}
        />
      ) : (
        <WorkbenchTabWindowContext.Provider value={tabWindow}>
          {children}
        </WorkbenchTabWindowContext.Provider>
      )}
    </div>
  );
}
