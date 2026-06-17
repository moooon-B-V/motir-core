import { STYLE_IDS } from './styles';
import { THEME_DEFAULTS, THEME_STORAGE_KEYS } from './types';

/**
 * Inline `<script>` content that runs BEFORE React hydrates.
 *
 * Reads theme preferences from localStorage (or system preference for
 * pattern='system') and sets `data-theme` + `data-style` on
 * `document.documentElement`. Without this, the user briefly sees the
 * server-rendered fallback theme before the client applies the real one
 * — a classic FOUC (Flash of Unstyled Content).
 *
 * Renders as a single-quoted IIFE string. Inserted via Next.js
 * `<Script strategy="beforeInteractive">` (or a plain inlined script tag)
 * in app/layout.tsx.
 *
 * Defensive: every operation is wrapped so a corrupted localStorage value,
 * a missing matchMedia API, or any other failure falls back gracefully
 * to the documented defaults rather than crashing the page load. The stored
 * style is validated against the registered style ids (baked in at build
 * time) so a stale / unknown value — e.g. a pre-7.3.32 `data-display-style`
 * leftover — resolves to the default instead of setting a dead attribute.
 */
export const themeInitScript = `(function(){try{
  var d=document.documentElement;
  var ls=window.localStorage;
  var pattern=ls.getItem(${JSON.stringify(THEME_STORAGE_KEYS.pattern)})||${JSON.stringify(THEME_DEFAULTS.pattern)};
  var styleIds=${JSON.stringify(STYLE_IDS)};
  var style=ls.getItem(${JSON.stringify(THEME_STORAGE_KEYS.style)});
  if(styleIds.indexOf(style)===-1){style=${JSON.stringify(THEME_DEFAULTS.style)};}
  var resolved=pattern;
  if(pattern==='system'){
    resolved=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
  }
  d.setAttribute('data-theme',resolved);
  d.setAttribute('data-style',style);
}catch(e){}})();`;
