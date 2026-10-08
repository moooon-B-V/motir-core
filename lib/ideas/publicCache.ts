/**
 * The cache policy of the PUBLIC ideas routes (Story MOTIR-7662 · MOTIR-7676):
 * a CDN may serve a copy for five minutes and keep serving a stale one while it
 * revalidates, so no reader sees a copy much more than an hour old — the same
 * horizon as motir.co's hourly page revalidate. Errors are never cached.
 */
export const PUBLIC_IDEAS_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=3300';
