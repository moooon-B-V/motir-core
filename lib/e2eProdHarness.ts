/**
 * The E2E production-harness flag (MOTIR-1679).
 *
 * Set ONLY by the E2E webServer (playwright.config.ts) when it runs the suite
 * against a `next build` + `next start` PRODUCTION server instead of `next dev`.
 * We moved off `next dev` because its resident on-demand compiler stalled and
 * dropped connections under bulk-shard load (`net::ERR_CONNECTION_RESET` on a
 * random `page.goto` each run) — a production server has no compiler and is
 * stable under load.
 *
 * A production server forces `NODE_ENV=production`, which trips guards written
 * for a REAL production deployment: `Secure` cookies (which the browser will not
 * send back over Playwright's plain `http://localhost`), the `/api/_test` 404
 * gate, and the dev-only 'file' email sink. This flag re-relaxes ONLY those
 * test seams — exactly as `E2E_TEST_OAUTH` / `E2E_DISABLE_RATE_LIMIT` /
 * `E2E_TEST_BLOB` already relax production behaviour for the test server.
 *
 * It is NEVER set in any real deployment. Like those sibling E2E flags, setting
 * it in production would be a misconfiguration — it carries the same bounded
 * risk class they already do (and the `/api/_test` routes remain auth-gated +
 * service-only + RLS-backed regardless of this gate).
 *
 * Read dynamically (not destructured at module load) so unit tests can flip the
 * env var at runtime, mirroring how `productionGate()` reads `NODE_ENV`.
 */
export function isE2EProdHarness(): boolean {
  return process.env['E2E_PROD_HARNESS'] === '1';
}

/**
 * True when a cookie's `Secure` attribute should be set: in real production,
 * but NOT when the E2E production harness is driving the app over plain
 * `http://localhost` (a `Secure` cookie is never returned over http, which would
 * break every signed-in spec). Centralises the `NODE_ENV`/harness check so every
 * cookie site stays consistent.
 */
export function shouldUseSecureCookies(): boolean {
  return process.env['NODE_ENV'] === 'production' && !isE2EProdHarness();
}
