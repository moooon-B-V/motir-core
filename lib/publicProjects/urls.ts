// Public-project URL helpers (Story 6.12 · Subtask 6.12.4) — the absolute-URL
// base for the PUBLIC SITE, which is no longer this application (MOTIR-3881).
//
// ── One variable per question ──────────────────────────────────────────────
//
// `lib/baseUrl.ts` owns *where is the APPLICATION?* — email links back into the
// product, Better-Auth's `baseURL` and `trustedOrigins`, OAuth callbacks. Until
// now it also answered *where does a reader find a PUBLIC PROJECT?*, because the
// two were the same host and this module delegated to it.
//
// `docs/decisions/public-surface-hosts.md` separates them: `motir.co` serves the
// public surface from `motir-marketing`, and `app.motir.co` serves this
// application and its anonymous read API. So the two questions get two
// variables, and this module is the SINGLE READER of the public one —
// `tests/hosting/appUrlSeam.test.ts` asserts that by grepping the tree.
//
// ── ⚠️ THE FALLBACK IS THE ORDERING GUARANTEE, AND IT IS LOAD-BEARING ──────
//
// `MOTIR_PUBLIC_SITE_URL` is UNSET everywhere today, and it must stay unset
// until `motir.co` actually renders these pages (MOTIR-3932 / MOTIR-3877).
// While it is unset this resolves to the APPLICATION origin, so every canonical,
// `og:url`, JSON-LD `@id` and sitemap entry keeps naming the host that is
// actually serving the page — which, right now, is still this one.
//
// Setting it early is the failure to avoid: it would point every canonical and
// every sitemap entry at a host that does not serve them yet, and nothing would
// throw. Deleting the pages is MOTIR-3951; this variable is turned on between
// those two events, not before.
//
// A local or CI checkout with neither variable set still lands on the dev origin
// through `lib/baseUrl`, so nothing here needs its own localhost fallback — the
// duplicate policy this module used to carry.

import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

/**
 * The PUBLIC SITE's origin (no trailing slash) for absolute public URLs.
 *
 * Falls back to the application's own origin while unconfigured — see the
 * ordering note above. An empty or whitespace-only value counts as unset, the
 * same rule `lib/baseUrl.ts` applies, because a secret cleared to `''` is a
 * misconfiguration rather than an origin.
 */
export function publicSiteOrigin(): string {
  const configured = process.env['MOTIR_PUBLIC_SITE_URL']?.trim();
  return configured ? configured.replace(/\/+$/, '') : resolveBaseUrlTrimmed();
}

/** The site-relative path for a public project (e.g. `/p/PROD`). */
export function publicProjectPath(identifier: string): string {
  return `/p/${encodeURIComponent(identifier)}`;
}

/** The absolute public URL for a project by its key (e.g. `/p/PROD`). */
export function publicProjectUrl(identifier: string): string {
  return `${publicSiteOrigin()}${publicProjectPath(identifier)}`;
}

const DESCRIPTION_MAX = 160;

/**
 * A plain-text, length-capped meta description from the authored README (strips
 * Markdown syntax) or a fallback when it's empty. Shared by `generateMetadata`
 * (the <meta> + OpenGraph) and the JSON-LD builder so the citable description is
 * identical across both.
 */
export function derivePublicDescription(md: string | null, fallback: string): string {
  if (!md) return fallback;
  const text = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : text;
}
