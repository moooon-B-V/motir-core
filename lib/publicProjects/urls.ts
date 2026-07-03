// Public-project URL helpers (Story 6.12 · Subtask 6.12.4) — the canonical /
// OpenGraph / sitemap absolute-URL base for the crawlable public surface.
//
// SEO requires ABSOLUTE URLs (canonical, og:url, sitemap entries), so we resolve
// a site origin once here. `BETTER_AUTH_URL` is the deployed app origin already
// configured for auth; we reuse it (no new env). A local/CI checkout whose .env
// omits it falls back to the dev origin — harmless for crawling (no bot reads a
// localhost canonical), and the routes still render.

const FALLBACK_ORIGIN = 'http://localhost:3000';

/** The site origin (no trailing slash) for absolute public URLs. */
export function publicSiteOrigin(): string {
  const raw = process.env['BETTER_AUTH_URL'] ?? FALLBACK_ORIGIN;
  return raw.replace(/\/+$/, '');
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
