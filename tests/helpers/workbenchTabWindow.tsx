import { useMemo, type ReactNode } from 'react';
import type { HomeTabCountsDto, WorkbenchPlanningPageDto } from '@/lib/dto/home';
import type { ApprovalQueueDto } from '@/lib/dto/approvalGate';
import type { WorkbenchWindowDto } from '@/lib/dto/workbench';
import { LiveSignalProvider, type LiveSignalSource } from '@/lib/live/liveSignal';
import { createLiveFlag } from '@/lib/live/liveFlag';
import { keepIfEqual } from '@/lib/workbench/mergeRows';
import { useWorkbenchWindow } from '../../app/(authed)/workbench/_components/useWorkbenchWindow';
import {
  WorkbenchTabWindowContext,
  type WorkbenchTabWindowDto,
} from '../../app/(authed)/workbench/_components/useTabWindowContent';

// THE WORKBENCH'S ONE READ, WITHOUT THE REST OF THE VIEW (Story MOTIR-8539 ·
// MOTIR-8581) — for a test of To approve's or Planning's LIST that wants its live
// arms (a read, a merge, a failure) without the strip and the shell around it. It
// runs the real `useWorkbenchWindow` and publishes its window through the real
// context, exactly as `<WorkbenchLiveView>` does; `workbench-*-live.test.tsx` mount
// the real view where the strip's pairing is the thing under test.

export const ZERO_COUNTS: HomeTabCountsDto = {
  myWork: 0,
  toDo: 0,
  inProgress: 0,
  toFix: 0,
  toResume: 0,
  recentlyFinished: 0,
  watching: 0,
  approvals: 0,
  planning: 0,
};

/** A source that never signals — the list's own cadence (or nothing) drives the reads. */
const QUIET: LiveSignalSource = {
  subscribe: () => () => {},
  reconnecting: createLiveFlag(false),
};

const tabWindowOf = (read: WorkbenchWindowDto): WorkbenchTabWindowDto | null =>
  read.window.kind === 'workItems' ? null : read.window;

function Reader({ tab, children }: { tab: 'approvals' | 'planning'; children: ReactNode }) {
  const live = useWorkbenchWindow<WorkbenchTabWindowDto | null>({
    tab,
    page: 1,
    content: null,
    counts: ZERO_COUNTS,
    fromWindow: tabWindowOf,
    merge: keepIfEqual,
  });
  const value = useMemo(
    () => ({ window: live.content, reread: live.reread, failures: live.failures }),
    [live.content, live.reread, live.failures],
  );
  return (
    <WorkbenchTabWindowContext.Provider value={value}>
      {children}
    </WorkbenchTabWindowContext.Provider>
  );
}

/** `children` under the Workbench's one read for `tab`. */
export function TabWindowHarness({
  tab,
  source = QUIET,
  children,
}: {
  tab: 'approvals' | 'planning';
  source?: LiveSignalSource;
  children: ReactNode;
}) {
  return (
    <LiveSignalProvider source={source}>
      <Reader tab={tab}>{children}</Reader>
    </LiveSignalProvider>
  );
}

/** `GET /api/workbench/window?tab=planning`'s answer carrying `page`. */
export function planningWindowAnswer(
  page: WorkbenchPlanningPageDto,
  counts: HomeTabCountsDto = { ...ZERO_COUNTS, planning: page.total },
): WorkbenchWindowDto {
  return {
    tab: 'planning',
    window: { kind: 'planning', page },
    counts,
    readAt: new Date().toISOString(),
  };
}

/** `GET /api/workbench/window?tab=approvals`'s answer carrying `queue`. */
export function approvalsWindowAnswer(
  queue: ApprovalQueueDto,
  counts: HomeTabCountsDto = { ...ZERO_COUNTS, approvals: queue.total },
): WorkbenchWindowDto {
  return {
    tab: 'approvals',
    window: { kind: 'approvals', queue },
    counts,
    readAt: new Date().toISOString(),
  };
}
