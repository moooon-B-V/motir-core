// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { THEME_STORAGE_KEYS, TokensSpecimen } from '../src/index';

// MOTIR-7725 — the specimen is sold as "drop it into any route", so it must not
// own the document's appearance. It used to wrap itself in `ThemeProvider`,
// whose mount effects stamp `data-theme` / `data-style` / `data-palette` /
// `data-type` onto <html> from localStorage (falling back to THEME_DEFAULTS) and
// whose `matchMedia` subscription re-stamps `data-theme` on every OS
// colour-scheme change. motir.co's `/design` page (MOTIR-7724) had its own
// appearance overwritten on mount and had to order its effects around it.

// RTL's act() wraps render + the OS-change dispatch; flag the environment so
// React flushes the effects inside each scope (motir-core's actEnvironment.ts).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (e: { matches: boolean }) => void;

function stubMatchMedia(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return query.includes('dark') ? dark : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, l: Listener) => listeners.add(l),
      removeEventListener: (_: string, l: Listener) => listeners.delete(l),
      addListener: (l: Listener) => listeners.add(l),
      removeListener: (l: Listener) => listeners.delete(l),
      dispatchEvent: () => true,
    })),
  );
  return {
    setDark(next: boolean) {
      dark = next;
      for (const l of listeners) l({ matches: next });
    },
  };
}

const HOST_APPEARANCE = {
  'data-theme': 'light',
  'data-style': 'glassmorphism',
  'data-palette': 'cobalt',
  'data-type': 'host-type',
} as const;

function htmlAppearance() {
  const el = document.documentElement;
  return Object.fromEntries(
    Object.keys(HOST_APPEARANCE).map((name) => [name, el.getAttribute(name)]),
  );
}

describe('TokensSpecimen leaves the host page’s appearance alone (MOTIR-7725)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    for (const [name, value] of Object.entries(HOST_APPEARANCE)) {
      document.documentElement.setAttribute(name, value);
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    for (const name of Object.keys(HOST_APPEARANCE)) {
      document.documentElement.removeAttribute(name);
    }
  });

  it('changes nothing on <html> when it mounts, even with an OS dark preference', () => {
    stubMatchMedia(true);
    render(<TokensSpecimen />);
    expect(htmlAppearance()).toEqual(HOST_APPEARANCE);
  });

  it('ignores a stored appearance choice', () => {
    stubMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEYS.pattern, 'dark');
    window.localStorage.setItem(THEME_STORAGE_KEYS.style, 'hand-drawn-indie');
    window.localStorage.setItem(THEME_STORAGE_KEYS.type, 'motir');
    render(<TokensSpecimen />);
    expect(htmlAppearance()).toEqual(HOST_APPEARANCE);
  });

  it('does not re-stamp data-theme when the OS colour scheme changes', () => {
    const media = stubMatchMedia(false);
    render(<TokensSpecimen />);
    act(() => media.setDark(true));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
