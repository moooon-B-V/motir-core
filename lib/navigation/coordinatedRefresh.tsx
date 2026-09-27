'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useTransition,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';

// ONE `router.refresh()` IN FLIGHT AT A TIME (bug MOTIR-6640).
//
// ⚠️ TWO OVERLAPPING REFRESHES CAN HARD-RELOAD THE PAGE. Next's app router
// models a refresh as a navigation to the current URL. When a navigation's
// server response leaves a segment of the client's tree unfilled, the router
// calls it a TREE MISMATCH and retries softly; a SECOND mismatch in a row
// (`previousNavigationDidMismatch`, module state in
// `next/dist/client/components/router-reducer/ppr-navigations.js`) falls back
// to a full document load (`completeHardNavigation`). Two refreshes dispatched
// tens of milliseconds apart, while a heavy client render is in progress, can
// mismatch back to back. The browser then reloads and every client island
// on the page loses its state.
//
// That is what ejected merge-queue entries from
// `cloud-plan-change-conversation.spec.ts`: after Approve in the planning
// overlay, the host refreshes (its `onApproved`) AND the Workbench's live
// stream nudges a refresh for the same write, so two refreshes landed ~40ms
// apart. The reload wiped the decided plan the overlay keeps after an approve
// (MOTIR-3206 / MOTIR-6155) and drew the plain roadmap in its place. It
// reproduces locally about one run in six with the browser CPU throttled 6x,
// and not unthrottled, which is why it only showed on a loaded CI runner.
//
// So the shell's refreshers go through this coordinator, not straight to the
// router:
//
//   · IDLE → the refresh runs now.
//   · A REFRESH IS PENDING → the request is COALESCED into ONE follow-up, run
//     once the pending refresh has committed. However many arrive meanwhile,
//     one follow-up covers them all, because a refresh re-reads the whole page
//     and the later read sees every write the earlier requests were for.
//
// Nothing is dropped: a request made during a refresh may be for a write that
// refresh's read missed, so the follow-up always runs.
//
// "Pending" is `useTransition`'s: the refresh is started inside
// `startTransition`, and React holds `isPending` until the transition's render
// (which suspends on the refreshed server data) commits.

/**
 * A pending refresh older than this is treated as settled. It exists only so
 * a transition that never reports back cannot hold every later refresh
 * forever. A real refresh is far below it.
 */
export const REFRESH_SETTLE_CEILING_MS = 10_000;

type RequestRefresh = () => void;

const CoordinatedRefreshContext = createContext<RequestRefresh | null>(null);

/**
 * Serialises every `router.refresh()` requested through
 * {@link useCoordinatedRefresh} below it. Mounted once, in the authed shell.
 */
export function CoordinatedRefreshProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // When the in-flight refresh started, or null when none is in flight.
  const startedAtRef = useRef<number | null>(null);
  const queuedRef = useRef(false);

  const run = useCallback(() => {
    startedAtRef.current = Date.now();
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  const request = useCallback(() => {
    const startedAt = startedAtRef.current;
    if (startedAt !== null && Date.now() - startedAt < REFRESH_SETTLE_CEILING_MS) {
      queuedRef.current = true;
      return;
    }
    queuedRef.current = false;
    run();
  }, [run]);

  // The pending refresh has committed: release the slot, and run the one
  // follow-up if anything asked while it was in flight.
  useEffect(() => {
    if (isPending || startedAtRef.current === null) return;
    startedAtRef.current = null;
    if (!queuedRef.current) return;
    queuedRef.current = false;
    run();
  }, [isPending, run]);

  return (
    <CoordinatedRefreshContext.Provider value={request}>
      {children}
    </CoordinatedRefreshContext.Provider>
  );
}

/**
 * The shell's `router.refresh()`. Serialised by {@link CoordinatedRefreshProvider}
 * when one is mounted above, and a plain refresh when none is (a component
 * rendered on its own, in a test).
 */
export function useCoordinatedRefresh(): RequestRefresh {
  const coordinated = useContext(CoordinatedRefreshContext);
  const router = useRouter();
  return useMemo(() => coordinated ?? (() => router.refresh()), [coordinated, router]);
}
