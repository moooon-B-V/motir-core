'use client';

import { useCallback, useEffect, useState } from 'react';

// THE UNSAVED-CHANGES GUARD for the Public page room (Story MOTIR-3875 ·
// MOTIR-4171) — the moment `design/public-projects/public-projects.mock.html`
// panel 1d decided for the on-page editor and `design/projects/design-notes.md`
// § *Public page — the room in project settings* carries over to the room:
// navigating away with edits pending ASKS FIRST (*Discard unsaved changes?* —
// Keep editing / Discard).
//
// Two doors out of a page, two mechanisms, both here so a caller cannot wire one
// and forget the other:
//
//   1. A HARD navigation (reload, closing the tab, typing a URL) — the browser's
//      own `beforeunload` prompt. The browser owns that dialog's copy; nothing a
//      page says is shown, which is why the second door needs the app's own.
//   2. A SOFT navigation — a click on an in-app link (the rail, a breadcrumb, a
//      `Link` inside the room). Captured at the document BEFORE React's root
//      listener sees it, so neither the native navigation nor `next/link`'s
//      client transition fires; the href is parked and the caller renders the
//      confirm. `discard()` hands the parked href back so the caller can reset
//      its state and then navigate on purpose.
//
// What it deliberately does NOT intercept: a link opening a new tab
// (`target="_blank"` — the room's own *View public page*), a download, a
// modifier-key or middle-button click (the reader is opening a second tab, and
// this page stays), a cross-origin `href`, and an in-page hash. None of those
// leaves the edits behind.
//
// Programmatic `router.push` calls are not caught — there is no navigation
// event to catch in the app router — and the room has none besides the one
// `discard()` performs.

export interface UnsavedChangesGuard {
  /** The in-app `href` a click was parked on, or null while nothing is pending. */
  pendingHref: string | null;
  /** *Keep editing* — drop the parked navigation. */
  keepEditing: () => void;
  /** *Discard* — returns the parked `href` for the caller to navigate to, and clears it. */
  discard: () => string | null;
}

export function useUnsavedChangesGuard(dirty: boolean): UnsavedChangesGuard {
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers read the string; modern ones only need the call above.
      event.returnValue = '';
    };

    const onClickCapture = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClickCapture, true);
    };
  }, [dirty]);

  const keepEditing = useCallback(() => setPendingHref(null), []);
  const discard = useCallback(() => {
    const href = pendingHref;
    setPendingHref(null);
    return href;
  }, [pendingHref]);

  return { pendingHref, keepEditing, discard };
}
