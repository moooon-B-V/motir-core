// Public-project URL helpers (Story 6.12 · Subtask 6.12.4) — the canonical /
// OpenGraph / sitemap absolute-URL base for the crawlable public surface.
//
// SEO requires ABSOLUTE URLs (canonical, og:url, sitemap entries), so we resolve
// a site origin once here — through `lib/baseUrl`, which owns the precedence for
// the whole app (MOTIR-2388). This module previously read the origin variable
// itself and carried its own localhost fallback: the same policy, written twice,
// and free to drift. A local/CI checkout with nothing configured still falls back
// to the dev origin — harmless for crawling (no bot reads a localhost canonical),
// and the routes still render.

import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

/** The site origin (no trailing slash) for absolute public URLs. */
export function publicSiteOrigin(): string {
  return resolveBaseUrlTrimmed();
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
