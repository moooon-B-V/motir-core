import { STYLE_IDS, STYLE_DEFAULT_TYPE } from './styles';
import { PALETTE_IDS } from './palettes';
import { TYPE_IDS } from './typography';
import {
  PALETTE_ID_MIGRATION,
  PALETTE_IDS_VERSION,
  THEME_DEFAULTS,
  THEME_STORAGE_KEYS,
} from './types';
import type { AppliedAppearanceDto } from '../appearance';

/**
 * How the init script handles the per-language font picks (MOTIR-7896):
 *
 * - `server` — a signed-in render: cache `byLocale` on this device and set the
 *   page language's `data-font-set-*` attributes.
 * - `clear` — a signed-out render: drop the cache and every such attribute, so
 *   a signed-out page never draws a pick.
 * - `cached` — the error page, which cannot read the database: re-apply the
 *   page language's entry from this device's cache.
 */
export type ThemeInitFontSets =
  | { mode: 'server'; byLocale: Partial<Record<string, Partial<Record<string, string>>>> }
  | { mode: 'clear' }
  | { mode: 'cached' };

/**
 * The font-set half of the script. Only the three `data-font-set-*` names and
 * values in `[a-z0-9-]` ever reach `setAttribute`, whatever the cache holds: a
 * device's localStorage is not trusted to be what this script wrote.
 */
function fontSetsScript(fontSets: ThemeInitFontSets): string {
  const apply = `var fsNames=['data-font-set-sans','data-font-set-serif','data-font-set-mono'];
  var fsApply=function(m){
    var p=((d.getAttribute('lang')||'').split(/[-_]/)[0]||'').toLowerCase();
    var a=m&&typeof m==='object'&&Object.prototype.hasOwnProperty.call(m,p)?m[p]:null;
    if(!a||typeof a!=='object'){return;}
    for(var i=0;i<fsNames.length;i++){var v=a[fsNames[i]];if(typeof v==='string'&&/^[a-z0-9-]+$/.test(v)){d.setAttribute(fsNames[i],v);}}
  };`;
  if (fontSets.mode === 'server') {
    return `  ${apply}
  var fsServer=${safeJson(fontSets.byLocale)};
  try{ls.setItem(K.fontPicks,JSON.stringify(fsServer));}catch(e){}
  fsApply(fsServer);
`;
  }
  if (fontSets.mode === 'clear') {
    return `  try{ls.removeItem(K.fontPicks);}catch(e){}
  d.removeAttribute('data-font-set-sans');d.removeAttribute('data-font-set-serif');d.removeAttribute('data-font-set-mono');
`;
  }
  return `  ${apply}
  var fsCached=null;
  try{fsCached=JSON.parse(ls.getItem(K.fontPicks)||'null');}catch(e){}
  fsApply(fsCached);
`;
}

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
 *   A stored palette id written before MOTIR-6471's rename is read through
 *   `PALETTE_ID_MIGRATION` ONCE — keyed on the `paletteIds` version marker,
 *   never on the value, since `motir` is a valid id both before and after — and
 *   the migrated value and the marker are written back. (The signed-in branch
 *   writes the marker with the server's already-migrated id.)
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
 *
 * `fontSets` (MOTIR-7896) adds the per-language font picks; see
 * {@link ThemeInitFontSets}. Omitted, the script is exactly what it was before.
 * Its per-request data is `byLocale`, whose keys are locales and whose values
 * are registry member ids — closed vocabulary, embedded with the same escape.
 */
export function buildThemeInitScript(
  serverPref: AppliedAppearanceDto | null,
  fontSets?: ThemeInitFontSets,
): string {
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
  var paletteMigration=${JSON.stringify(PALETTE_ID_MIGRATION)};
  var paletteIdsVersion=${JSON.stringify(PALETTE_IDS_VERSION)};
  var pattern,style,palette,type;
  if(server){
    pattern=server.pattern;style=server.styleId;palette=server.paletteId;type=server.typeId;
    try{
      ls.setItem(K.pattern,pattern);ls.setItem(K.style,style);ls.setItem(K.palette,palette);
      ls.setItem(K.paletteIds,paletteIdsVersion);
      if(server.typePinned){ls.setItem(K.type,type);}else{ls.removeItem(K.type);}
    }catch(e){}
  }else{
    pattern=ls.getItem(K.pattern)||${JSON.stringify(THEME_DEFAULTS.pattern)};
    style=ls.getItem(K.style);
    if(styleIds.indexOf(style)===-1){style=${JSON.stringify(THEME_DEFAULTS.style)};}
    palette=ls.getItem(K.palette);
    if(ls.getItem(K.paletteIds)!==paletteIdsVersion){
      if(palette!==null&&Object.prototype.hasOwnProperty.call(paletteMigration,palette)){palette=paletteMigration[palette];}
      try{
        if(palette!==null){ls.setItem(K.palette,palette);}
        ls.setItem(K.paletteIds,paletteIdsVersion);
      }catch(e){}
    }
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
${fontSets ? fontSetsScript(fontSets) : ''}}catch(e){}})();`;
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

/**
 * The error page's script (MOTIR-7896): the anonymous baseline plus the font
 * picks this device last cached, since `app/global-error.tsx` cannot read the
 * database whose read may be what failed.
 */
export const globalErrorInitScript = buildThemeInitScript(null, { mode: 'cached' });
