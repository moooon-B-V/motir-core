'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ReportWidgetModal } from './ReportWidgetModal';

/**
 * ReportProvider — owns the open state of the in-app report widget (Subtask
 * 6.11.7) and mounts the modal once for the whole authenticated shell (mirrors
 * CreateIssueProvider's pattern). It exposes `openReport()` and `canReport` via
 * context so multiple entry points — the top-nav "Report" button and the inbox
 * header "Report" button — drive the same dialog without prop-drilling.
 *
 * `canReport` is false when there's no active project (a brand-new workspace):
 * a triage submission is project-scoped, so there's nothing to report into. The
 * triggers gate on it.
 *
 * The widget is only MOUNTED when there's an active project AND the actor may
 * edit it (`canEdit`): the 6.11.4 intake routes creation through
 * `workItemsService.createWorkItem`, which requires edit rights and rejects a
 * viewer with 403. So a read-only actor must not get a functional submit path —
 * the trigger still renders disabled (via ProjectAccessProvider) so the
 * affordance is visible-but-blocked rather than absent, exactly like the
 * create-issue button.
 */
interface ReportContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  openReport: () => void;
  canReport: boolean;
  /**
   * A monotonically increasing tick bumped each time a submission is
   * successfully created (mirrors CreateIssueProvider.issuesChangedAt). A
   * `router.refresh()` re-renders SERVER surfaces (e.g. the triage header
   * count), but it CANNOT reach a client island that seeds its list from
   * `useState(initialProps)` — the TriageInbox queue does. Such islands watch
   * this tick and refetch. It carries no payload: "a submission was created,
   * re-read if you cache the queue".
   */
  submissionsChangedAt: number;
}

const ReportContext = createContext<ReportContextValue | null>(null);

export function ReportProvider({
  projectKey,
  canEdit = true,
  children,
}: {
  /** The active project's identifier, or null when there's no active project. */
  projectKey: string | null;
  /** Whether the actor may EDIT the active project (Story 6.4.6). */
  canEdit?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [submissionsChangedAt, setSubmissionsChangedAt] = useState(0);

  const openReport = useCallback(() => setOpen(true), []);
  // The modal calls this on a successful submit; bumping the tick lets
  // client-fetched surfaces (the triage inbox queue) refetch.
  const notifySubmitted = useCallback(() => setSubmissionsChangedAt((n) => n + 1), []);

  const value = useMemo<ReportContextValue>(
    () => ({ open, setOpen, openReport, canReport: Boolean(projectKey), submissionsChangedAt }),
    [open, openReport, projectKey, submissionsChangedAt],
  );

  return (
    <ReportContext.Provider value={value}>
      {children}
      {projectKey && canEdit && (
        <ReportWidgetModal
          open={open}
          onOpenChange={setOpen}
          projectKey={projectKey}
          onSubmitted={notifySubmitted}
        />
      )}
    </ReportContext.Provider>
  );
}

export function useReport(): ReportContextValue {
  const ctx = useContext(ReportContext);
  if (!ctx) {
    throw new Error('useReport must be used inside <ReportProvider>');
  }
  return ctx;
}
