'use client';

import { useCallback, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';

// The quick-view (peek) MODAL FRAME (Subtask 2.5.19) — the client shell mounted
// by IssueQuickViewController when `?peek=<key>` is present (on /issues, /ready,
// /boards). It composes the shipped components/ui/Modal (Radix focus-trap + Esc
// + backdrop-close + return-focus) as a LARGE dialog (size="xl", h-[680px]
// capped to 82vh, p-0 so the peek owns its own full-bleed header/body) per
// design/work-items/quick-view.mock.html. The controller passes the panel as
// `children` (skeleton → fields), so the modal opens IMMEDIATELY with a skeleton
// while the item's fields fetch over the wire.
//
// The peek lives in the URL, updated via SHALLOW routing (bug 8.8.2): opening /
// closing / swapping the peek calls `window.history.pushState` rather than
// `router.push`, so it is a pure, immediate URL change that does NOT re-render
// the host server page (no underlying-list refetch, no open/close lag). The
// client controller reacts to the URL via `useSearchParams`. Closing (Esc /
// backdrop / the × / "Close") clears `?peek` while preserving every other param
// (view/sort/filter/page). `usePeekClose` is the one place that computes the
// cleared URL — reused by the header × and the not-found Close
// (QuickViewCloseButton).

/**
 * Shallow URL update — push `href` onto the history stack WITHOUT a server
 * navigation (so the host page does not re-render / refetch). Next's App Router
 * syncs `usePathname` / `useSearchParams` with native `history.pushState`, so
 * the client peek controller picks the change up; the underlying list is
 * untouched (bug 8.8.2). A history entry (not `replaceState`) so Back / Esc step
 * back through peeked items, the design's "Back closes it" behaviour.
 */
function shallowPush(href: string) {
  window.history.pushState(null, '', href);
}

/**
 * Returns a stable `(identifier) => void` that opens the quick-view peek for a
 * work item by setting `?peek=<identifier>` on the current URL (preserving every
 * other param — view/sort/filter/page) via shallow routing. The peek is
 * URL-driven — shareable, reload-safe, and closed by `usePeekClose`. Shared by
 * the issue-list row `QuickViewTrigger`, the board (Subtask 3.2.2), and the
 * /ready list: all open the SAME peek surface, so the open wiring lives here.
 */
export function usePeekOpen() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(
    (identifier: string) => {
      const params = new URLSearchParams(searchParams?.toString());
      params.set('peek', identifier);
      shallowPush(`${pathname}?${params.toString()}`);
    },
    [pathname, searchParams],
  );
}

/** Returns a stable callback that clears `?peek` from the URL (shallow). */
export function usePeekClose() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(() => {
    const params = new URLSearchParams(searchParams?.toString());
    params.delete('peek');
    const query = params.toString();
    shallowPush(query ? `${pathname}?${query}` : pathname);
  }, [pathname, searchParams]);
}

export function IssueQuickView({ peekKey, children }: { peekKey: string; children: ReactNode }) {
  const t = useTranslations('issueViews');
  const close = usePeekClose();

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      hideClose
      size="xl"
      srTitle={t('quickViewDialogLabel', { key: peekKey })}
      className="h-[680px] max-h-[82vh] w-[90vw] p-0"
    >
      {children}
    </Modal>
  );
}
