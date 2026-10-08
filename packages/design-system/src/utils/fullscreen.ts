'use client';

import { useSyncExternalStore } from 'react';

/**
 * The element currently in NATIVE full screen (`document.fullscreenElement`), or
 * `null` — re-read on every `fullscreenchange`.
 *
 * While an element is in native full screen the browser paints ONLY that
 * element's subtree, in the top layer. Anything portalled to `document.body` —
 * a dialog, a popover, a picker's menu — is not shown at all, whatever its
 * z-index (MOTIR-7658: the roadmap canvas's quick view opened invisibly and
 * held focus and scroll lock until Esc). So every portalling primitive in this
 * package mounts into this element while there is one, and into
 * `document.body` otherwise — exactly as before.
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
