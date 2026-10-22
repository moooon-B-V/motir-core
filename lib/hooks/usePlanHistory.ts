'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { PlanSessionRowDto } from '@/lib/dto/planSessions';
import { listOwnSessions } from '@/lib/planning/planChangeClient';

// The planning overlay's HISTORY (Story MOTIR-9218 · MOTIR-9307; design MOTIR-9305):
// the caller's own sessions in the active project, ten a page, paged on the read's
// opaque cursor. Nothing is fetched until the section is first expanded; after that
// the loaded rows are kept, so collapsing and re-expanding costs no request.
//
// One request at a time: a bottom hit while a page is in flight is ignored, and a
// response that arrives after a newer request was started (a retry) is dropped by
// its sequence stamp. Pages are merged by session id, so a session that moved
// between two reads can never render twice.

export type PlanHistoryStatus =
  /** Not expanded yet — nothing has been asked for. */
  | 'idle'
  | 'loadingFirst'
  /** Rows are shown and an older page exists. */
  | 'ready'
  | 'loadingMore'
  /** The last request failed; `failedPage` says which. */
  | 'error'
  /** The oldest session is loaded. */
  | 'done';

export interface PlanHistory {
  rows: PlanSessionRowDto[];
  status: PlanHistoryStatus;
  /** Which request the error belongs to — the first page, or a next one. */
  failedPage: 'first' | 'next' | null;
  /** Ask for the next page; a no-op unless `status` is `ready`. */
  loadMore: () => void;
  /** Re-send the request that failed. */
  retry: () => void;
}

export function mergeById(
  rows: readonly PlanSessionRowDto[],
  page: readonly PlanSessionRowDto[],
): PlanSessionRowDto[] {
  const seen = new Set(rows.map((r) => r.id));
  return [...rows, ...page.filter((r) => !seen.has(r.id) && seen.add(r.id))];
}

/** `enabled` is the section's expanded state: the first page is fetched the first
 *  time it turns true, and never again by it. */
export function usePlanHistory(enabled: boolean): PlanHistory {
  const [rows, setRows] = useState<PlanSessionRowDto[]>([]);
  const [status, setStatus] = useState<PlanHistoryStatus>('idle');
  const [failedPage, setFailedPage] = useState<'first' | 'next' | null>(null);
  const cursorRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const inFlightRef = useRef(false);
  const startedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchPage = useCallback((which: 'first' | 'next') => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const seq = ++seqRef.current;
    const abort = new AbortController();
    abortRef.current = abort;
    setFailedPage(null);
    setStatus(which === 'first' ? 'loadingFirst' : 'loadingMore');
    listOwnSessions(which === 'first' ? null : cursorRef.current, abort.signal).then(
      (page) => {
        if (seq !== seqRef.current) return;
        inFlightRef.current = false;
        cursorRef.current = page.nextCursor;
        setRows((prev) =>
          which === 'first' ? mergeById([], page.sessions) : mergeById(prev, page.sessions),
        );
        setStatus(page.nextCursor ? 'ready' : 'done');
      },
      () => {
        if (seq !== seqRef.current) return;
        inFlightRef.current = false;
        setFailedPage(which);
        setStatus('error');
      },
    );
  }, []);

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    fetchPage('first');
  }, [enabled, fetchPage]);

  // An unmount mid-request drops the response rather than setting state on nothing.
  useEffect(
    () => () => {
      seqRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  const loadMore = useCallback(() => {
    if (status !== 'ready') return;
    fetchPage('next');
  }, [status, fetchPage]);

  const retry = useCallback(() => {
    if (status !== 'error' || !failedPage) return;
    fetchPage(failedPage);
  }, [status, failedPage, fetchPage]);

  return { rows, status, failedPage, loadMore, retry };
}
