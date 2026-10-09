'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { planRowDestination } from '@/lib/planning/planDestination';
import { fetchPlanReview } from '@/lib/planning/planReviewClient';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { isPlainPrimaryClick } from '@/lib/hooks/useOpenPlanningWorkspace';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import type { PlanStatusDto } from '@/lib/dto/plans';

// THE PLAN-OVERLAY DOOR (Story MOTIR-7883 · MOTIR-7884).
//
// A door that holds ONLY A PLAN ID — a work item's pending-plan notice, a run
// finding, the paused-planning notice — needs three facts before it knows where
// the plan lands: its status, its session and its first anchor. This hook is the
// one place those facts are fetched and handed to the ONE destination rule,
// `planRowDestination`. It never inspects the status itself: a decided plan, a
// Visitor reader and a plan with no session all fall to whatever that rule
// answers, so a change to the rule reaches every door at once.
//
// ⚠️ THE OPEN IS IN PLACE. An undecided plan opens the planning overlay over the
// page the door sits on, written with `shallowPush` — the overlay is mounted for
// every authed page (`app/(authed)/layout.tsx`), so the page underneath keeps its
// state and Close returns to it. A modified click is the browser's, so it follows
// the real `href`: the same page with the overlay open, the cold deep link.
//
// ⚠️ NO PENDING AFFORDANCE (`CLAUDE.md` § *URL state the CLIENT reads is written
// with `shallowPush`*). The read starts on mount, so it has normally settled long
// before a person clicks; a click that beats it waits on the same promise rather
// than drawing a spinner.

/** The three facts the destination rule needs, when a caller already holds them. */
export interface KnownPlanFacts {
  planStatus: PlanStatusDto;
  sessionId: string | null;
  anchorKey: string | null;
}

export interface OpenPlanOverlay {
  /** Where the plan lands — the reader's plan page until the read settles, and if it fails. */
  href: string;
  /** The click handler; `open()` with no event is the imperative form. */
  open: (event?: MouseEvent<HTMLElement>) => void;
  /** True once the facts are settled: supplied, read, or the read failed. */
  resolved: boolean;
}

type Resolution = KnownPlanFacts | 'failed';

interface CacheEntry {
  promise: Promise<Resolution>;
  controller: AbortController;
  settled: Resolution | null;
  refs: number;
}

// ONE READ PER PLAN ID, shared by every door mounted at once — a notice listing N
// plans fetches each once. An entry lives exactly as long as some door holds it:
// the last door to unmount aborts a read still in flight and drops the entry, so
// a later mount reads the plan again rather than trusting a status that may have
// moved since (a plan approved elsewhere must not keep opening the overlay).
const reads = new Map<string, CacheEntry>();

function acquire(planId: string): CacheEntry {
  const existing = reads.get(planId);
  if (existing) {
    existing.refs += 1;
    return existing;
  }
  const controller = new AbortController();
  const entry: CacheEntry = {
    controller,
    settled: null,
    refs: 1,
    promise: fetchPlanReview(planId, controller.signal).then(
      (review): Resolution => ({
        planStatus: review.status,
        sessionId: review.conversation?.sessionId ?? null,
        anchorKey: review.conversation?.targetKeys[0] ?? null,
      }),
      (): Resolution => 'failed',
    ),
  };
  void entry.promise.then((resolution) => {
    entry.settled = resolution;
  });
  reads.set(planId, entry);
  return entry;
}

function release(planId: string, entry: CacheEntry): void {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (entry.settled === null) entry.controller.abort();
  if (reads.get(planId) === entry) reads.delete(planId);
}

export interface OpenPlanOverlayOptions {
  /**
   * Compose the overlay address on THIS page instead of the current one, and
   * NAVIGATE there with `router.push` rather than `shallowPush` (MOTIR-7890). The
   * caller is declaring that the overlay is not mounted where it stands — the
   * onboarding hand-off, outside `app/(authed)` — so an in-place write would set
   * an address nothing reads. Absent, the door opens in place over the current page.
   */
  host?: string;
}

export function useOpenPlanOverlay(
  planId: string,
  known?: KnownPlanFacts,
  options?: OpenPlanOverlayOptions,
): OpenPlanOverlay {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const routes = useReaderRoutes();

  // `known` is an object literal at its call sites; its VALUE is the dependency.
  const knownStatus = known?.planStatus ?? null;
  const knownSession = known?.sessionId ?? null;
  const knownAnchor = known?.anchorKey ?? null;
  const knownFacts = useMemo<KnownPlanFacts | null>(
    () =>
      knownStatus === null
        ? null
        : { planStatus: knownStatus, sessionId: knownSession, anchorKey: knownAnchor },
    [knownStatus, knownSession, knownAnchor],
  );

  const [read, setRead] = useState<{ planId: string; resolution: Resolution } | null>(null);
  const entryRef = useRef<CacheEntry | null>(null);

  useEffect(() => {
    if (knownFacts !== null) return;
    const entry = acquire(planId);
    entryRef.current = entry;
    let live = true;
    void entry.promise.then((resolution) => {
      if (live) setRead({ planId, resolution });
    });
    return () => {
      live = false;
      if (entryRef.current === entry) entryRef.current = null;
      release(planId, entry);
    };
  }, [planId, knownFacts]);

  const resolution: Resolution | null =
    knownFacts ?? (read !== null && read.planId === planId ? read.resolution : null);

  const hostOverride = options?.host ?? null;
  const host = useMemo(() => {
    if (hostOverride !== null) return hostOverride;
    const qs = searchParams.toString();
    return `${pathname}${qs ? `?${qs}` : ''}`;
  }, [hostOverride, pathname, searchParams]);

  const destinationOf = useCallback(
    (facts: Resolution | null) =>
      facts === null || facts === 'failed'
        ? null
        : planRowDestination({ ...facts, planId, host, routes }),
    [planId, host, routes],
  );

  const destination = destinationOf(resolution);
  const href = destination?.href ?? routes.plan(planId);

  const open = useCallback(
    (event?: MouseEvent<HTMLElement>) => {
      if (event) {
        if (!isPlainPrimaryClick(event)) return;
        event.preventDefault();
      }
      const go = (facts: Resolution | null) => {
        const answer = destinationOf(facts);
        if (answer === null) router.push(routes.plan(planId));
        else if (answer.kind === 'planning-surface' && hostOverride === null)
          shallowPush(answer.href);
        else router.push(answer.href);
      };
      if (resolution !== null) {
        go(resolution);
        return;
      }
      // The click beat the read: wait on the same promise the mount started.
      const pending = entryRef.current;
      if (pending === null) {
        go(null);
        return;
      }
      void pending.promise.then(go);
    },
    [resolution, destinationOf, router, routes, planId, hostOverride],
  );

  return { href, open, resolved: resolution !== null };
}
