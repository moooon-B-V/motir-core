'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  THEME_DEFAULTS,
  THEME_STORAGE_KEYS,
  type ResolvedThemePattern,
  type ThemePattern,
} from '@/lib/theme/types';
import { DEFAULT_STYLE_ID, isStyleId, type StyleId } from '@/lib/theme/styles';
import { DEFAULT_PALETTE_ID, isPaletteId, type PaletteId } from '@/lib/theme/palettes';

/**
 * Theme context for Motir's two-axis design system.
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
  setPattern: (pattern: ThemePattern) => void;
  setStyleId: (styleId: StyleId) => void;
  setPalette: (palette: PaletteId) => void;
}

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

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Lazy initializers — run once on first render, read localStorage
  // synchronously without an effect.
  const [pattern, setPatternState] = useState<ThemePattern>(() =>
    readStorage<ThemePattern>(THEME_STORAGE_KEYS.pattern, THEME_DEFAULTS.pattern),
  );
  const [styleId, setStyleIdState] = useState<StyleId>(() => {
    // A stale / unknown stored value (e.g. a pre-7.3.32 `default`/`soft`
    // display-style leftover) resolves to the default, never a dead id.
    const stored = readStorage<string>(THEME_STORAGE_KEYS.style, THEME_DEFAULTS.style);
    return isStyleId(stored) ? stored : DEFAULT_STYLE_ID;
  });
  const [palette, setPaletteState] = useState<PaletteId>(() => {
    // A stale / unknown stored value resolves to the default, never a dead id.
    const stored = readStorage<string>(THEME_STORAGE_KEYS.palette, THEME_DEFAULTS.palette);
    return isPaletteId(stored) ? stored : DEFAULT_PALETTE_ID;
  });

  // Subscribe to OS color-scheme changes. Only consulted when pattern='system'.
  const osColorScheme = useSyncExternalStore(
    subscribeColorScheme,
    getColorSchemeSnapshot,
    getColorSchemeServerSnapshot,
  );

  const resolvedPattern: ResolvedThemePattern = pattern === 'system' ? osColorScheme : pattern;

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

  const setPattern = useCallback((next: ThemePattern) => {
    setPatternState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEYS.pattern, next);
    } catch {
      // localStorage unavailable — accept that the choice won't persist.
    }
  }, []);

  const setStyleId = useCallback((next: StyleId) => {
    setStyleIdState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEYS.style, next);
    } catch {
      // localStorage unavailable — accept that the choice won't persist.
    }
  }, []);

  const setPalette = useCallback((next: PaletteId) => {
    setPaletteState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEYS.palette, next);
    } catch {
      // localStorage unavailable — accept that the choice won't persist.
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ pattern, resolvedPattern, styleId, palette, setPattern, setStyleId, setPalette }),
    [pattern, resolvedPattern, styleId, palette, setPattern, setStyleId, setPalette],
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
