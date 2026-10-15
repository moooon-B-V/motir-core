'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HomeTabCountsDto } from '@/lib/dto/home';
import type { WorkbenchWindowDto } from '@/lib/dto/workbench';
import { useLiveSignal } from '@/lib/live/liveSignal';
import { fetchWorkbenchWindow } from '@/lib/workbench/windowClient';
import { keepIfEqual } from '@/lib/workbench/mergeRows';
import type { WorkbenchTab } from '@/lib/workbench/tab';

// THE WORKBENCH, APPLIED IN PLACE (Story MOTIR-8539 · Subtask MOTIR-8574).
//
// ⚠️ THIS IS CASE 3 OF CLAUDE.md's PAGE-STATE CONTRACT NOW, AND IT USED TO BE
// CASE 2. The Workbench's lists rendered from SERVER props and a nudge was a
// `router.refresh()` that re-ran the whole page under the reader — over an open
// approval too (MOTIR-8571's finding). The story forbids a refresh on a live
// path, so the surface holds its own fetched state: the strip's counts and the
// tab's window, seeded from the server's first paint, re-read from
// `GET /api/workbench/window` on a `workbench` signal from the seam.
//
// ⚠️ ROWS AND COUNTS ARRIVE IN ONE RESPONSE AND ARE SET IN ONE UPDATE, so there
// is no render in which the strip and the list disagree — § 21 / § 26's rule,
// kept by the one endpoint instead of by one server render.
//
// ⚠️ THE READ POLICY is `useGeneratingPlanPoll`'s:
//
//   · ONE READ IN FLIGHT. A signal during a read sets `pending`, and exactly one
//     more read runs once it settles — a burst of N nudges costs two reads, not N.
//   · AN ABORT per read, on unmount and on a change of tab or page; an answer for
//     a view the reader has left, or older than one already applied, is DROPPED.
//   · A FAILED read keeps the last state and draws nothing. Transport trouble is
//     the *Reconnecting…* chip's, unchanged; the next signal reads again. The run
//     of consecutive failures is counted (`failures`), because the Planning tab's
//     rows report a dropped read after three (§ 36.7) — it is the one tab whose
//     cadence is a poll rather than the stream (MOTIR-8581).
//
// ⚠️ AN EQUAL ANSWER IS NO UPDATE. `merge` returns the previous value for what
// did not change (rows by identity, `mergeRowsByIdentity`), and when nothing
// changed the previous STATE comes back — React bails out and renders nothing.

export interface WorkbenchWindowOptions<T> {
  tab: WorkbenchTab;
  /** The page the reader is on (1-based). */
  page: number;
  /** The server's first paint of the tab's content. */
  content: T;
  /** The server's first paint of the strip. */
  counts: HomeTabCountsDto;
  /**
   * The tab's content out of a window answer — or `null` when the answer carries
   * none this view renders (its rows are drawn elsewhere), which keeps the content.
   */
  fromWindow: (read: WorkbenchWindowDto) => T | null;
  /** Merge `next` over `prev`, returning `prev` itself when nothing changed. */
  merge: (prev: T, next: T) => T;
}

export interface WorkbenchWindow<T> {
  content: T;
  counts: HomeTabCountsDto;
  /** Re-read now — what a verb that moved a row calls (Continue, a fix, Approve). */
  reread: () => void;
  /** Consecutive reads that failed; `0` again on the next success. */
  failures: number;
}

interface State<T> {
  /** The view this state is for. A different one is a LOAD: reseed clean. */
  view: string;
  /** The props it was last seeded from — a change for the same view is merged. */
  seed: { content: T; counts: HomeTabCountsDto };
  content: T;
  counts: HomeTabCountsDto;
}

export function useWorkbenchWindow<T>(options: WorkbenchWindowOptions<T>): WorkbenchWindow<T> {
  const { tab, page, content, counts } = options;
  const view = `${tab}:${page}`;

  const [state, setState] = useState<State<T>>(() => ({
    view,
    seed: { content, counts },
    content,
    counts,
  }));

  // The latest mapping functions, without re-subscribing when a caller re-renders.
  const fns = useRef({ fromWindow: options.fromWindow, merge: options.merge });
  useEffect(() => {
    fns.current = { fromWindow: options.fromWindow, merge: options.merge };
  });

  // ⚠️ RESEED DURING RENDER — `useLiveRows`' pattern, React's for deriving state
  // from props. A new view (tab switch, pager move) is a load: what the server
  // sent, nothing merged. New props for the SAME view are another surface's own
  // refresh landing, and they merge like any read.
  let current = state;
  if (state.view !== view) {
    current = { view, seed: { content, counts }, content, counts };
    setState(current);
  } else if (state.seed.content !== content || state.seed.counts !== counts) {
    const mergedContent = options.merge(state.content, content);
    const mergedCounts = keepIfEqual(state.counts, counts);
    current = { view, seed: { content, counts }, content: mergedContent, counts: mergedCounts };
    setState(current);
  }

  // The view a read was issued for, read when it lands.
  const viewRef = useRef({ tab, page, view });
  useEffect(() => {
    viewRef.current = { tab, page, view };
  });

  const [failures, setFailures] = useState(0);

  const reader = useRef({
    inFlight: null as AbortController | null,
    pending: false,
    issued: 0,
    applied: 0,
  });

  const read = useCallback(function issue(): void {
    const r = reader.current;
    if (r.inFlight) {
      r.pending = true;
      return;
    }
    const { tab: forTab, page: forPage, view: forView } = viewRef.current;
    const seq = ++r.issued;
    const ctrl = new AbortController();
    r.inFlight = ctrl;
    void fetchWorkbenchWindow({ tab: forTab, page: forPage, signal: ctrl.signal })
      .then((answer) => {
        // Dropped: aborted, a later read already applied, or the reader left the view.
        if (ctrl.signal.aborted || seq <= r.applied || viewRef.current.view !== forView) return;
        if (answer.tab !== forTab) return;
        r.applied = seq;
        setFailures(0);
        setState((prev) => {
          if (prev.view !== forView) return prev;
          const next = fns.current.fromWindow(answer);
          const nextContent = next === null ? prev.content : fns.current.merge(prev.content, next);
          const nextCounts = keepIfEqual(prev.counts, answer.counts);
          if (nextContent === prev.content && nextCounts === prev.counts) return prev;
          return { ...prev, content: nextContent, counts: nextCounts };
        });
      })
      .catch(() => {
        // Best-effort: the last state stands, and the next signal reads again. An
        // abort is not a failure, and nor is one older than an applied success.
        if (ctrl.signal.aborted || seq <= r.applied) return;
        setFailures((n) => n + 1);
      })
      .finally(() => {
        if (r.inFlight !== ctrl) return;
        r.inFlight = null;
        if (r.pending && !ctrl.signal.aborted) {
          r.pending = false;
          issue();
        }
      });
  }, []);

  // A change of view, and unmount, abort what is out and forget what was pending.
  useEffect(() => {
    const r = reader.current;
    return () => {
      r.inFlight?.abort();
      r.inFlight = null;
      r.pending = false;
    };
  }, [view]);

  useLiveSignal({ kind: 'workbench' }, read);

  return { content: current.content, counts: current.counts, reread: read, failures };
}
