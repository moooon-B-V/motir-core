'use client';

import { useCallback, type MouseEvent, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
// The peek's shallow URL update, lifted into `lib/navigation/` by MOTIR-3434 so
// the three view switches share ONE implementation with it rather than each
// growing a copy. The reasoning that used to sit here — a pure, immediate URL
// change that does not re-render the host server page, and a history entry so
// Back / Esc step back — moved with it.
import { shallowPush } from '@/lib/navigation/shallowUrl';

// The quick-view (peek) MODAL FRAME (Subtask 2.5.19) — the client shell mounted
// by IssueQuickViewController when `?peek=<key>` is present (on /items, /ready,
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
 * Returns a stable `(identifier) => void` that opens the quick-view peek for a
 * work item by setting `?peek=<identifier>` on the current URL (preserving every
 * other param — view/sort/filter/page) via shallow routing. The peek is
 * URL-driven — shareable, reload-safe, and closed by `usePeekClose`. Shared by
 * the issue-list rows (List + Tree), the board (Subtask 3.2.2), and the /ready
 * list: all open the SAME peek surface, so the open wiring lives here.
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

/**
 * Returns a stable `(event, identifier) => void` for a whole-row / relationship
 * LINK that should open the quick-view peek on a PLAIN primary click while
 * keeping its real `/items/<id>` href intact. A plain left-click is intercepted
 * (`preventDefault` + open the peek); a modifier / secondary / middle click is
 * left to the browser, so ⌘/ctrl/middle-click still opens the full detail page
 * in a new tab. This is the SINGLE peek-on-click guard, shared by the
 * relationships-panel `RelationshipPeekLink` (MOTIR-8.8.31) and the /items row
 * links — the List's stretched anchor and the Tree's `TreeTable` row link
 * (MOTIR-1306, replacing the per-row eye `QuickViewTrigger`). Keyboard Enter on
 * an anchor fires an unmodified click, so it routes here too.
 */
export function usePeekRowClick() {
  const openPeek = usePeekOpen();
  return useCallback(
    (e: MouseEvent, identifier: string) => {
      // Let the browser handle modifier / secondary clicks natively (open in a
      // new tab/window); only an unmodified primary click opens the peek.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      openPeek(identifier);
    },
    [openPeek],
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
