'use client';

import { useState, useSyncExternalStore, type RefObject } from 'react';

/**
 * The element currently in NATIVE full screen (`document.fullscreenElement`), or
 * `null` — re-read on every `fullscreenchange`.
 *
 * While an element is in native full screen the browser paints ONLY that
 * element's subtree, in the top layer. Anything portalled to `document.body` —
 * a dialog, a popover, a picker's menu — is not shown at all, whatever its
 * z-index (MOTIR-7658: the roadmap canvas's quick view opened invisibly and
 * held focus and scroll lock until Esc).
 *
 * A portalling primitive does not use this directly: it uses
 * `usePortalContainer`, which also refuses to follow full screen into the
 * primitive's own subtree.
 *
 * `null` on the server and in a document with no Fullscreen API.
 */
export function useFullscreenElement(): Element | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribe(onChange: () => void): () => void {
  document.addEventListener('fullscreenchange', onChange);
  return () => document.removeEventListener('fullscreenchange', onChange);
}

function getSnapshot(): Element | null {
  return document.fullscreenElement ?? null;
}

function getServerSnapshot(): null {
  return null;
}

/**
 * The element a portalling surface mounts into: the element in native full
 * screen while there is one (MOTIR-7658), else `null` — which the caller turns
 * into `document.body`.
 *
 * `own` is the surface's portalled root (a dialog's content, a menu). When the
 * element that goes full screen is INSIDE it — the native full-screen button of
 * a `<video>` in a dialog — the container stays where it was (MOTIR-8560).
 * Following it would re-portal the surface into its own descendant: React
 * unmounts the subtree to move it, the full-screen element leaves the document,
 * the browser exits full screen, and the surface snaps back to a fresh copy.
 *
 * `null` on the server and in a document with no Fullscreen API.
 */
export function usePortalContainer(own: RefObject<Element | null>): Element | null {
  const [store] = useState(() => createPortalContainerStore(own));
  return useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
}

function createPortalContainerStore(own: RefObject<Element | null>) {
  let container: Element | null =
    typeof document === 'undefined' ? null : (document.fullscreenElement ?? null);
  return {
    subscribe(onChange: () => void): () => void {
      const sync = () => {
        const next = document.fullscreenElement ?? null;
        const root = own.current;
        // The surface's own descendant went full screen: stay put.
        if (next !== null && root !== null && root.contains(next)) return;
        if (next === container) return;
        container = next;
        onChange();
      };
      // A change between creating the store and subscribing to it.
      sync();
      document.addEventListener('fullscreenchange', sync);
      return () => document.removeEventListener('fullscreenchange', sync);
    },
    getSnapshot: (): Element | null => container,
  };
}
