import { STYLE_IDS, STYLE_DEFAULT_TYPE } from './styles';
import { PALETTE_IDS } from './palettes';
import { TYPE_IDS } from './typography';
import { THEME_DEFAULTS, THEME_STORAGE_KEYS } from './types';
import type { AppliedAppearanceDto } from '../appearance';

/**
 * Build the inline `<script>` content that runs BEFORE React hydrates, applying
 * the user's appearance to `<html>` (`data-theme` + `data-style` + `data-palette`
 * + `data-type`). Without this the page briefly flashes the SSR default before
 * the client applies the real preference — a classic FOUC.
 *
 * `serverPref` is the signed-in user's APPLIED appearance (Subtask 7.3.61); pass
 * `null` for an anonymous visitor. The precedence (the FOUC-critical rule):
 *
 * - **Signed-in (serverPref present)** → the SERVER preference is authoritative
 *   (it followed the user to this device). The script applies the server values
 *   and IGNORES localStorage for the applied value, so a stale localStorage from
 *   another device can never clobber a present server value. It then RECONCILES
 *   localStorage FROM the server pref — keeping it an accurate instant-apply
 *   cache and preserving the user's look if they later sign out. An unpinned
 *   type is reconciled by REMOVING the `type` key (so the anonymous path keeps
 *   following the style default); a pinned type is written.
 * - **Anonymous (serverPref null)** → unchanged from the original behaviour:
 *   read localStorage, resolve each axis through the registries (baked in at
 *   build time), and fall an unpinned type back to the active style's default.
 *
 * For `data-theme` the script still resolves `pattern==='system'` via
 * `matchMedia` at runtime — the one axis the server cannot know — so the root
 * layout renders `data-theme` server-side only for an explicit `light`/`dark`
 * and leaves `system` (and the anonymous case) to this script.
 *
 * Safety: the only per-request data embedded is `serverPref`, whose every field
 * is a CLOSED-ENUM registry id (`[a-z0-9-]`) / `system|light|dark` / a boolean —
 * never free user input. It is JSON-serialised with `<` escaped to `<` so
 * it cannot break out of the `<script>` element. The rest is a static,
 * compile-time string. This is the standard theme-init pattern (next-themes,
 * shadcn/ui, dooooWeb).
 */
export function buildThemeInitScript(serverPref: AppliedAppearanceDto | null): string {
  const server = serverPref === null ? 'null' : safeJson(serverPref);
  return `(function(){try{
  var d=document.documentElement;
  var ls=window.localStorage;
  var server=${server};
  var styleIds=${JSON.stringify(STYLE_IDS)};
  var paletteIds=${JSON.stringify(PALETTE_IDS)};
  var typeIds=${JSON.stringify(TYPE_IDS)};
  var styleDefaultType=${JSON.stringify(STYLE_DEFAULT_TYPE)};
  var K=${JSON.stringify(THEME_STORAGE_KEYS)};
  var pattern,style,palette,type;
  if(server){
    pattern=server.pattern;style=server.styleId;palette=server.paletteId;type=server.typeId;
    try{
      ls.setItem(K.pattern,pattern);ls.setItem(K.style,style);ls.setItem(K.palette,palette);
      if(server.typePinned){ls.setItem(K.type,type);}else{ls.removeItem(K.type);}
    }catch(e){}
  }else{
    pattern=ls.getItem(K.pattern)||${JSON.stringify(THEME_DEFAULTS.pattern)};
    style=ls.getItem(K.style);
    if(styleIds.indexOf(style)===-1){style=${JSON.stringify(THEME_DEFAULTS.style)};}
    palette=ls.getItem(K.palette);
    if(paletteIds.indexOf(palette)===-1){palette=${JSON.stringify(THEME_DEFAULTS.palette)};}
    type=ls.getItem(K.type);
    if(typeIds.indexOf(type)===-1){type=styleDefaultType[style]||${JSON.stringify(THEME_DEFAULTS.type)};}
  }
  var resolved=pattern;
  if(pattern==='system'){
    resolved=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
  }
  d.setAttribute('data-theme',resolved);
  d.setAttribute('data-style',style);
  d.setAttribute('data-palette',palette);
  d.setAttribute('data-type',type);
}catch(e){}})();`;
}

/** JSON for inline-script embedding — `<` escaped so it can't end the element. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * The anonymous baseline init script (no server preference). Kept as a named
 * export for callers / tests that don't need per-request data; the root layout
 * uses {@link buildThemeInitScript} with the signed-in user's applied pref.
 */
export const themeInitScript = buildThemeInitScript(null);
