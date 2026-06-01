'use client';

import { useEffect, useInsertionEffect, useRef } from 'react';

/**
 * useShortcut — one shared keyboard-shortcut primitive for the whole shell.
 *
 * Story 1.5 registers several global shortcuts (toggle the sidebar, open the
 * command palette, show the shortcut cheatsheet, close transient surfaces).
 * Routing them all through one hook keeps the combo grammar, the
 * cross-platform `Mod` resolution, and the input-focus guard identical
 * everywhere instead of each consumer re-implementing `keydown` parsing.
 *
 * In 1.5.2 only two combos are wired: `Mod+\` (collapse toggle) and `esc`
 * (close the mobile drawer). 1.5.4 adds `Mod+K` (palette) and `?`
 * (shortcuts) against this same hook.
 *
 * @param combo   A combo string. Grammar:
 *                  - `"Mod+\\"`, `"Mod+K"` — `Mod` is the cross-platform
 *                    ⌘ (Mac) / Ctrl (everywhere else) token, resolved at
 *                    bind time via `navigator.platform`.
 *                  - `"?"` — a bare printable key (matched case-insensitively
 *                    against `event.key`).
 *                  - `"esc"` / `"escape"` — the Escape key.
 *                The combo is case-insensitive (`"Mod+k"` === `"Mod+K"`).
 * @param handler Called when the combo fires. The event's default is
 *                prevented so the browser doesn't also act on it.
 * @param opts.whenInputFocused When `false` (default) the shortcut is
 *                suppressed while the user is typing in an `<input>`,
 *                `<textarea>`, `<select>`, or `contenteditable` element —
 *                so `?` in a search box types a question mark instead of
 *                opening the cheatsheet. Set `true` for combos that should
 *                fire even mid-typing (e.g. `esc`).
 */
export interface UseShortcutOptions {
  /** Fire even while a text input is focused. Default `false`. */
  whenInputFocused?: boolean;
  /** Disable the binding without unmounting the consumer. Default `true`. */
  enabled?: boolean;
}

/** Resolved once per module load — `platform` doesn't change at runtime. */
function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  // `navigator.platform` is deprecated but still the most reliable sync
  // signal for ⌘-vs-Ctrl; userAgentData.platform is async + not universal.
  return /mac|iphone|ipad|ipod/i.test(navigator.platform);
}

interface ParsedCombo {
  mod: boolean;
  key: string;
}

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.split('+').map((p) => p.trim().toLowerCase());
  const mod = parts.includes('mod');
  const rawKey = parts.filter((p) => p !== 'mod').join('+') || combo.toLowerCase();
  // Normalize the escape aliases to the value `KeyboardEvent.key` reports.
  const key = rawKey === 'esc' || rawKey === 'escape' ? 'escape' : rawKey;
  return { mod, key };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

export function useShortcut(
  combo: string,
  handler: () => void,
  opts: UseShortcutOptions = {},
): void {
  const { whenInputFocused = false, enabled = true } = opts;

  // Keep the latest handler in a ref so the keydown effect doesn't re-subscribe
  // every render (which would drop the listener mid-keystroke). Assign in
  // `useInsertionEffect` — the canonical "latest ref" slot: it runs on every
  // commit, synchronously before layout effects fire, so the listener never
  // sees a stale handler, and it satisfies the react-hooks/refs rule (no ref
  // writes during render).
  const handlerRef = useRef(handler);
  useInsertionEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!enabled) return;
    const { mod, key } = parseCombo(combo);
    const isMac = isMacPlatform();

    function onKeyDown(event: KeyboardEvent) {
      if (mod) {
        const modPressed = isMac ? event.metaKey : event.ctrlKey;
        if (!modPressed) return;
      }
      if (event.key.toLowerCase() !== key) return;
      if (!whenInputFocused && isEditableTarget(event.target)) return;

      event.preventDefault();
      handlerRef.current();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [combo, whenInputFocused, enabled]);
}
