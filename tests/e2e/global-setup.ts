import type { FullConfig } from '@playwright/test';
import { assertHarnessReady } from './_helpers/readiness';

/**
 * Playwright globalSetup (MOTIR-1565) — the E2E harness readiness gate.
 *
 * Playwright starts the two webServers (`pnpm dev` + `inngest-cli dev`) and
 * waits for each `webServer.url` to respond BEFORE this runs (the webServer
 * plugin's setup is ordered ahead of globalSetup in the runner's task list).
 * But that built-in check treats any status < 404 as "ready", so a redirecting
 * root URL is "up" the instant the socket binds — while `/sign-up` still 404s
 * and the inngest dev server's `PUT /api/inngest` sync 404-cascades. The suite
 * then ran against a half-started server and the entire shell-flows suite red
 * at once (MOTIR-1565: PR #1517, bulk-4 — 8 red specs from one bad shard start,
 * not a product regression).
 *
 * This gate closes that window: it polls the authoritative app auth route, the
 * app's inngest serve route, and the inngest dev server's sync, with bounded
 * retry/backoff, before the first spec. On a genuine startup failure it THROWS
 * here — so the shard fails its own global-setup step with one clear error
 * instead of reddening the whole suite as if the PR under test had regressed.
 *
 * Tunable via `E2E_READINESS_ATTEMPTS` (total probe attempts per check) for a
 * CI runner that needs a longer cold-start budget.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseUrl =
    config.projects[0]?.use?.baseURL ??
    process.env['E2E_BASE_URL'] ??
    `http://localhost:${process.env['PORT'] ?? '3000'}`;
  // playwright.config.ts sets process.env.INNGEST_BASE_URL at module scope
  // (before globalSetup runs); fall back to deriving it the same way it does.
  const inngestBaseUrl =
    process.env['INNGEST_BASE_URL'] ?? `http://localhost:${process.env['INNGEST_PORT'] ?? '8288'}`;

  const attemptsEnv = Number(process.env['E2E_READINESS_ATTEMPTS'] ?? '');
  const attempts = Number.isFinite(attemptsEnv) && attemptsEnv > 0 ? attemptsEnv : undefined;

  console.warn(`[e2e-readiness] gating harness startup — app=${baseUrl} inngest=${inngestBaseUrl}`);
  await assertHarnessReady({
    baseUrl,
    inngestBaseUrl,
    poll: attempts ? { attempts } : {},
  });
  console.warn('[e2e-readiness] harness fully ready — starting specs.');
}
