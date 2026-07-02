'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  THEME_DEFAULTS,
  THEME_STORAGE_KEYS,
  type ResolvedThemePattern,
  type ThemePattern,
} from '../theme/types';
import { DEFAULT_STYLE_ID, isStyleId, resolveStyle, type StyleId } from '../theme/styles';
import { DEFAULT_PALETTE_ID, isPaletteId, type PaletteId } from '../theme/palettes';
import { isTypeId, type TypeId } from '../theme/typography';
import type { AppearancePreferenceDto, AppliedAppearanceDto } from '../appearance';

/**
 * Theme context for Motir's three-axis design system (style · palette · type),
 * plus the light/dark pattern.
 *
 * `pattern` is what the user picked (system | light | dark).
 * `resolvedPattern` is what's currently applied (light | dark) — these
 * differ when pattern='system' and the OS preference resolves to one or
 * the other.
 *
 * State is persisted to localStorage and re-applied to <html>'s
 * data-attributes on every change. The init script in app/layout.tsx
 * does the same work BEFORE React hydrates to avoid FOUC; this provider
 * keeps the attributes in sync after hydration.
 *
 * Implementation note: this uses lazy `useState` initializers and
 * `useSyncExternalStore` rather than `useEffect`+`setState`, per the
 * React 19 / react-hooks/set-state-in-effect rule. Setting state inside
 * effects causes cascading renders; subscribing to external systems
 * (localStorage, matchMedia) via the right primitives avoids that.
 */
interface ThemeContextValue {
  pattern: ThemePattern;
  resolvedPattern: ResolvedThemePattern;
  /** The active named style (`data-style`) — Axis 2, independent of palette. */
  styleId: StyleId;
  /** The active named palette (`data-palette`) — Axis 1 (colour), independent of style. */
  palette: PaletteId;
  /**
   * The EFFECTIVE type pairing (`data-type`) — Axis 3. Either the user's pinned
   * choice, or (when unpinned) the active style's `defaultTypeId`. Independent
   * of palette + style.
   */
  type: TypeId;
  setPattern: (pattern: ThemePattern) => void;
  setStyleId: (styleId: StyleId) => void;
  setPalette: (palette: PaletteId) => void;
  /** Pin an explicit type pairing (overrides the style's default until cleared). */
  setType: (type: TypeId) => void;
  /**
   * Cross-device sync status (Subtask 7.3.62). `'idle'` while nothing has
   * failed; `'error'` when the LAST attempt to persist a change to the account
   * failed (a 401 / write failure) — the local switch still applied (it's in
   * localStorage), so this only drives a quiet "couldn't sync" affordance. Always
   * `'idle'` for an anonymous visitor, who never syncs. Clears back to `'idle'`
   * on the next successful sync.
   */
  syncState: AppearanceSyncState;
}

/** The cross-device sync status surfaced to the Appearance pane (7.3.62). */
export type AppearanceSyncState = 'idle' | 'error';

/** The axes a single PATCH carries — the setters only ever send valid ids. */
type AppearanceSyncPatch = Partial<Record<'pattern' | 'styleId' | 'paletteId' | 'typeId', string>>;

/** How long rapid toggles of the SAME axis coalesce before one write fires. */
const SYNC_DEBOUNCE_MS = 250;

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Lazily read a localStorage key. Returns null on SSR or if the key isn't set. */
function readStorage<T extends string>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    return (window.localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * `useSyncExternalStore` subscription to the prefers-color-scheme media
 * query. Returns 'dark' or 'light' based on the OS preference.
 *
 * Server snapshot returns 'light' (a stable default — the FOUC init
 * script will apply the real value before hydration completes).
 */
function subscribeColorScheme(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  mql.addEventListener('change', callback);
  return () => mql.removeEventListener('change', callback);
}

function getColorSchemeSnapshot(): ResolvedThemePattern {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getColorSchemeServerSnapshot(): ResolvedThemePattern {
  return 'light';
}

export function ThemeProvider({
  children,
  initialPreference = null,
  signedIn = false,
}: {
  children: ReactNode;
  /**
   * The signed-in user's APPLIED appearance, resolved server-side (Subtask
   * 7.3.61). When present it SEEDS this island's state — the page-state
   * contract: a client island must be GIVEN the server value, not left to
   * re-read localStorage (which `useState` would do only at mount, ignoring the
   * authoritative server pref and risking a flash from a stale value synced on
   * another device). `null` (anonymous) keeps the original localStorage path.
   */
  initialPreference?: AppliedAppearanceDto | null;
  /**
   * Whether a user is signed in (Subtask 7.3.62). Only then does an axis change
   * also PERSIST to the account via `/api/appearance-preference` (cross-device
   * sync). Anonymous visitors keep the localStorage-only path and never fire a
   * write — so they never hit a 401 or see a "couldn't sync" affordance. This is
   * a SEPARATE signal from `initialPreference`: a signed-in user who has pinned
   * nothing yet has `initialPreference === null` but must still sync their first
   * pick (a row is created on the first PATCH).
   */
  signedIn?: boolean;
}) {
  // Lazy initializers — run once on first render. Seed from the server
  // preference when signed in (authoritative, cross-device); otherwise read
  // localStorage synchronously without an effect.
  const [pattern, setPatternState] = useState<ThemePattern>(() =>
    initialPreference
      ? initialPreference.pattern
      : readStorage<ThemePattern>(THEME_STORAGE_KEYS.pattern, THEME_DEFAULTS.pattern),
  );
  const [styleId, setStyleIdState] = useState<StyleId>(() => {
    if (initialPreference) {
      return isStyleId(initialPreference.styleId) ? initialPreference.styleId : DEFAULT_STYLE_ID;
    }
    // A stale / unknown stored value (e.g. a pre-7.3.32 `default`/`soft`
    // display-style leftover) resolves to the default, never a dead id.
    const stored = readStorage<string>(THEME_STORAGE_KEYS.style, THEME_DEFAULTS.style);
    return isStyleId(stored) ? stored : DEFAULT_STYLE_ID;
  });
  const [palette, setPaletteState] = useState<PaletteId>(() => {
    if (initialPreference) {
      return isPaletteId(initialPreference.paletteId)
        ? initialPreference.paletteId
        : DEFAULT_PALETTE_ID;
    }
    // A stale / unknown stored value resolves to the default, never a dead id.
    const stored = readStorage<string>(THEME_STORAGE_KEYS.palette, THEME_DEFAULTS.palette);
    return isPaletteId(stored) ? stored : DEFAULT_PALETTE_ID;
  });
  // The user's PINNED type choice, or `null` = "follow the active style's
  // default pairing". Only a valid stored id pins; anything else (unset/stale)
  // falls through to the style default below.
  const [typeChoice, setTypeChoiceState] = useState<TypeId | null>(() => {
    if (initialPreference) {
      // The server pref carries the EFFECTIVE type + whether it was pinned: an
      // unpinned user must stay `null` so they keep following the style default.
      return initialPreference.typePinned && isTypeId(initialPreference.typeId)
        ? initialPreference.typeId
        : null;
    }
    const stored = readStorage<string>(THEME_STORAGE_KEYS.type, '');
    return isTypeId(stored) ? stored : null;
  });

  // Subscribe to OS color-scheme changes. Only consulted when pattern='system'.
  const osColorScheme = useSyncExternalStore(
    subscribeColorScheme,
    getColorSchemeSnapshot,
    getColorSchemeServerSnapshot,
  );

  const resolvedPattern: ResolvedThemePattern = pattern === 'system' ? osColorScheme : pattern;

  // Effective type (Axis 3): a pinned choice wins; otherwise FOLLOW the active
  // style's default pairing — so switching style (while unpinned) re-points type
  // to that style's curated default, and an explicit pick sticks across styles.
  const type: TypeId = typeChoice ?? resolveStyle(styleId).defaultTypeId;

  // Sync data-theme to <html>. This IS an effect (synchronizing with an
  // external system — the DOM), but the effect body only writes to the DOM,
  // not back to React state. That's the correct effect shape.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedPattern);
  }, [resolvedPattern]);

  useEffect(() => {
    document.documentElement.setAttribute('data-style', styleId);
  }, [styleId]);

  useEffect(() => {
    document.documentElement.setAttribute('data-palette', palette);
  }, [palette]);

  useEffect(() => {
    document.documentElement.setAttribute('data-type', type);
  }, [type]);

  // ── Cross-device sync (Subtask 7.3.62) ────────────────────────────────────
  // A signed-in user's axis change is OPTIMISTIC: the setter flips the live UI +
  // localStorage instantly (below), then queues a debounced PATCH to
  // `/api/appearance-preference`. The write is reconciled from its 200 body, and
  // a failure (401 / network / server) degrades quietly — the local switch is
  // never lost (localStorage holds it) — surfacing `syncState: 'error'` for the
  // pane's affordance. Anonymous visitors never sync (the localStorage-only path).
  const [syncState, setSyncState] = useState<AppearanceSyncState>('idle');
  // Monotonic per-flush counter — the seq-guard that stops an older response from
  // clobbering a newer choice (the WatchControl `fetchSeq` idiom; the
  // E2E-authoritative-signal contract). Only the latest flush may reconcile / set
  // the affordance.
  const syncSeqRef = useRef(0);
  // Axes changed since the last flush, coalesced so rapid toggles send one write.
  const pendingPatchRef = useRef<AppearanceSyncPatch>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reconcile ONLY the axes this flush actually sent, from the resolved 200 body
  // — never the untouched axes (the per-axis DTO resolves an unpinned `typeId` to
  // the GLOBAL default, which would wrongly pin a follow-the-style user if applied
  // off a different axis's write). The raw state setters skip the localStorage /
  // re-PATCH side effects; for the valid ids the setters send, this is a no-op
  // confirmation, but it adopts any value the server normalised.
  const reconcile = useCallback((sent: AppearanceSyncPatch, resolved: AppearancePreferenceDto) => {
    if ('pattern' in sent) setPatternState(resolved.pattern);
    if ('styleId' in sent && isStyleId(resolved.styleId)) setStyleIdState(resolved.styleId);
    if ('paletteId' in sent && isPaletteId(resolved.paletteId)) setPaletteState(resolved.paletteId);
    if ('typeId' in sent && isTypeId(resolved.typeId)) setTypeChoiceState(resolved.typeId);
  }, []);

  const flushSync = useCallback(() => {
    debounceRef.current = null;
    const patch = pendingPatchRef.current;
    pendingPatchRef.current = {};
    if (Object.keys(patch).length === 0) return;

    const seq = ++syncSeqRef.current;
    fetch('/api/appearance-preference', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`appearance sync failed: ${res.status}`);
        const body = (await res.json()) as { preference: AppearancePreferenceDto };
        // Drop a response superseded by a newer flush — it must not clobber the
        // newer choice nor flip the affordance.
        if (seq !== syncSeqRef.current) return;
        reconcile(patch, body.preference);
        setSyncState('idle');
      })
      .catch(() => {
        if (seq !== syncSeqRef.current) return;
        // Keep the optimistic local value (localStorage holds it); surface the
        // quiet "couldn't sync" affordance without blocking the live switch.
        setSyncState('error');
      });
  }, [reconcile]);

  // Merge an axis change into the pending patch and (re)arm the debounce. A
  // no-op for anonymous visitors — they never write to the account.
  const queueSync = useCallback(
    (patch: AppearanceSyncPatch) => {
      if (!signedIn) return;
      pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(flushSync, SYNC_DEBOUNCE_MS);
    },
    [signedIn, flushSync],
  );

  // Flush any pending write on unmount so a just-made choice isn't dropped.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        flushSync();
      }
    };
  }, [flushSync]);

  const setPattern = useCallback(
    (next: ThemePattern) => {
      setPatternState(next);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEYS.pattern, next);
      } catch {
        // localStorage unavailable — accept that the choice won't persist.
      }
      queueSync({ pattern: next });
    },
    [queueSync],
  );

  const setStyleId = useCallback(
    (next: StyleId) => {
      setStyleIdState(next);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEYS.style, next);
      } catch {
        // localStorage unavailable — accept that the choice won't persist.
      }
      queueSync({ styleId: next });
    },
    [queueSync],
  );

  const setPalette = useCallback(
    (next: PaletteId) => {
      setPaletteState(next);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEYS.palette, next);
      } catch {
        // localStorage unavailable — accept that the choice won't persist.
      }
      queueSync({ paletteId: next });
    },
    [queueSync],
  );

  const setType = useCallback(
    (next: TypeId) => {
      setTypeChoiceState(next);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEYS.type, next);
      } catch {
        // localStorage unavailable — accept that the choice won't persist.
      }
      queueSync({ typeId: next });
    },
    [queueSync],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      pattern,
      resolvedPattern,
      styleId,
      palette,
      type,
      setPattern,
      setStyleId,
      setPalette,
      setType,
      syncState,
    }),
    [
      pattern,
      resolvedPattern,
      styleId,
      palette,
      type,
      setPattern,
      setStyleId,
      setPalette,
      setType,
      syncState,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}

/**
 * Non-throwing variant of {@link useTheme}. Returns `null` when no
 * `<ThemeProvider>` is mounted instead of throwing.
 *
 * Use this in low-level primitives that must also render outside the authed
 * shell — e.g. the `MarkdownEditor` (Subtask 2.3.5) reads `resolvedPattern`
 * to drive the underlying editor's `data-color-mode`, but it's also exercised
 * on the public `/tokens` specimen and in component tests where wrapping every
 * render in a provider would be noise. Callers fall back to a sensible default
 * (`'light'`).
 */
export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext);
}
