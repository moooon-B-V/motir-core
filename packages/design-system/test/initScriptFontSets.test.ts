// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  THEME_STORAGE_KEYS,
  buildThemeInitScript,
  globalErrorInitScript,
  themeInitScript,
} from '../src/index';
import type { AppliedAppearanceDto } from '../src/appearance';

// MOTIR-7896 — the init script's font-pick modes. Each test evaluates the built
// string against the happy-dom document + localStorage exactly as the browser
// runs the inline <script>: `server` caches and applies, `clear` erases, and
// `cached` (the error page) re-applies only safe values for the page language.

const html = document.documentElement;
const NAMES = ['data-font-set-sans', 'data-font-set-serif', 'data-font-set-mono'] as const;
const run = (script: string) => new Function(script)();
const attrs = () => Object.fromEntries(NAMES.map((n) => [n, html.getAttribute(n)]));
const none = {
  'data-font-set-sans': null,
  'data-font-set-serif': null,
  'data-font-set-mono': null,
};

const BY_LOCALE = { ja: { 'data-font-set-sans': 'm-plus-rounded-1c' } };

beforeEach(() => {
  localStorage.clear();
  for (const n of NAMES) html.removeAttribute(n);
  html.setAttribute('lang', 'ja');
});

afterEach(() => {
  html.removeAttribute('lang');
});

describe('buildThemeInitScript — font picks', () => {
  it('server: caches the picks and sets the page language’s attributes', () => {
    run(buildThemeInitScript(null, { mode: 'server', byLocale: BY_LOCALE }));

    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEYS.fontPicks)!)).toEqual(BY_LOCALE);
    expect(attrs()).toEqual({ ...none, 'data-font-set-sans': 'm-plus-rounded-1c' });
  });

  it('cached: restores the cached entry on a fresh ja document, nothing on ko', () => {
    run(buildThemeInitScript(null, { mode: 'server', byLocale: BY_LOCALE }));
    for (const n of NAMES) html.removeAttribute(n);

    run(globalErrorInitScript);
    expect(attrs()).toEqual({ ...none, 'data-font-set-sans': 'm-plus-rounded-1c' });

    for (const n of NAMES) html.removeAttribute(n);
    html.setAttribute('lang', 'ko');
    run(globalErrorInitScript);
    expect(attrs()).toEqual(none);
  });

  it('cached: matches the primary subtag (ja-JP)', () => {
    localStorage.setItem(THEME_STORAGE_KEYS.fontPicks, JSON.stringify(BY_LOCALE));
    html.setAttribute('lang', 'ja-JP');

    run(globalErrorInitScript);

    expect(html.getAttribute('data-font-set-sans')).toBe('m-plus-rounded-1c');
  });

  it('clear: removes the cache and every font-set attribute', () => {
    run(buildThemeInitScript(null, { mode: 'server', byLocale: BY_LOCALE }));

    run(buildThemeInitScript(null, { mode: 'clear' }));

    expect(localStorage.getItem(THEME_STORAGE_KEYS.fontPicks)).toBeNull();
    expect(attrs()).toEqual(none);
  });

  it('cached: never applies an unsafe value or a name outside the three', () => {
    localStorage.setItem(
      THEME_STORAGE_KEYS.fontPicks,
      JSON.stringify({
        ja: {
          'data-font-set-sans': 'x" onload="alert(1)',
          'data-font-set-serif': '<script>',
          'data-font-set-mono': 'Upper-Case',
          onclick: 'evil',
        },
      }),
    );

    run(globalErrorInitScript);

    expect(attrs()).toEqual(none);
    expect(html.getAttribute('onclick')).toBeNull();
  });

  it('cached: survives a corrupt cache', () => {
    localStorage.setItem(THEME_STORAGE_KEYS.fontPicks, '{not json');

    expect(() => run(globalErrorInitScript)).not.toThrow();
    expect(attrs()).toEqual(none);
  });

  it('escapes < in the embedded picks', () => {
    const script = buildThemeInitScript(null, {
      mode: 'server',
      byLocale: { ja: { 'data-font-set-sans': '</script>' } },
    });
    expect(script).not.toContain('</script>');
  });

  it('is unchanged when no font-set mode is given', () => {
    const pref: AppliedAppearanceDto = {
      pattern: 'dark',
      styleId: 'soft-playful',
      paletteId: 'motir',
      typeId: 'motir',
      typePinned: false,
    };
    expect(buildThemeInitScript(null)).toBe(themeInitScript);
    expect(buildThemeInitScript(pref)).not.toContain('fsApply');
    expect(themeInitScript).not.toContain('fsApply');
  });
});
