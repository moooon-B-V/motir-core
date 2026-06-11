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
  type DisplayStyle,
  type ResolvedThemePattern,
  type ThemePattern,
} from '@/lib/theme/types';

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
  displayStyle: DisplayStyle;
  setPattern: (pattern: ThemePattern) => void;
  setDisplayStyle: (displayStyle: DisplayStyle) => void;
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
  const [displayStyle, setDisplayStyleState] = useState<DisplayStyle>(() =>
    readStorage<DisplayStyle>(THEME_STORAGE_KEYS.displayStyle, THEME_DEFAULTS.displayStyle),
  );

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
    document.documentElement.setAttribute('data-display-style', displayStyle);
  }, [displayStyle]);

  const setPattern = useCallback((next: ThemePattern) => {
    setPatternState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEYS.pattern, next);
    } catch {
      // localStorage unavailable — accept that the choice won't persist.
    }
  }, []);

  const setDisplayStyle = useCallback((next: DisplayStyle) => {
    setDisplayStyleState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEYS.displayStyle, next);
    } catch {
      // localStorage unavailable — accept that the choice won't persist.
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ pattern, resolvedPattern, displayStyle, setPattern, setDisplayStyle }),
    [pattern, resolvedPattern, displayStyle, setPattern, setDisplayStyle],
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
