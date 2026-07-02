// Cross-origin allowlist for the public `POST /api/idea-draft` endpoint (Subtask
// 7.22.2 / MOTIR-1458). This is the ONE internet-facing, cross-origin-callable
// route in motir-core: the standalone motir-marketing site (motir.co, a DIFFERENT
// origin) forwards a visitor's hero idea here. Every OTHER API is same-origin, so
// the repo has no global CORS layer — this allowlist is deliberately scoped to
// this endpoint rather than opened app-wide.
//
// Allowed origins come from `MOTIR_MARKETING_ORIGIN` (comma-separated, exact
// origin match, e.g. `https://motir.co,https://www.motir.co`). Unset ⇒ empty
// allowlist ⇒ fail CLOSED (no cross-origin caller permitted); a same-origin call
// carries no `Origin` header and never needs CORS, so leaving it unset only
// blocks cross-origin abuse, never same-origin use.

/** Parse the configured allowlist (exact-match origins), trimmed + de-duped. */
export function allowedMarketingOrigins(): string[] {
  const raw = process.env['MOTIR_MARKETING_ORIGIN'] ?? '';
  return [
    ...new Set(
      raw
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Resolve the `Origin` of an incoming request against the allowlist. Returns the
 * exact allowed origin to echo in `Access-Control-Allow-Origin`, or `null` if the
 * origin is absent (same-origin / server-to-server) or not allowlisted.
 */
export function resolveAllowedOrigin(req: Request): string | null {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  return allowedMarketingOrigins().includes(origin) ? origin : null;
}

/** True when a cross-origin `Origin` header is present but NOT allowlisted. */
export function isForbiddenCrossOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  return origin !== null && !allowedMarketingOrigins().includes(origin);
}

/**
 * CORS response headers for an allowed origin. `Vary: Origin` so a cache never
 * serves one origin's ACAO to another. Only the origin we intend to allow is
 * echoed (never a wildcard) — the endpoint accepts a small POST body only.
 */
export function corsHeaders(allowedOrigin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
