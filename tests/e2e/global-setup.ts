import type { FullConfig } from '@playwright/test';
import { assertHarnessReady } from './_helpers/readiness';
import { ensureAppRoleCanLogIn, isAppRoleE2E } from './_helpers/appRoleServer';
import { jobWorkerEnabled, startJobWorker } from './_helpers/job-worker-process';

/**
 * Playwright globalSetup (MOTIR-1565) — the E2E harness readiness gate.
 *
 * Playwright starts the webServer (`next build && next start`) and waits for its
 * `webServer.url` to respond BEFORE this runs (the webServer plugin's setup is
 * ordered ahead of globalSetup in the runner's task list). But that built-in
 * check treats any status < 404 as "ready", so a redirecting root URL is "up"
 * the instant the socket binds — while `/sign-up` still 404s. The suite then ran
 * against a half-started server and the entire shell-flows suite red at once
 * (MOTIR-1565: PR #1517, bulk-4 — 8 red specs from one bad shard start, not a
 * product regression).
 *
 * This gate closes that window: it polls the authoritative app auth route, with
 * bounded retry/backoff, before the first spec. On a genuine startup failure it
 * THROWS here — so the shard fails its own global-setup step with one clear
 * error instead of reddening the whole suite as if the PR under test had
 * regressed.
 *
 * Tunable via `E2E_READINESS_ATTEMPTS` (total probe attempts per check) for a
 * CI runner that needs a longer cold-start budget.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  // MOTIR-2816 — give `motir_app` a login before the webServer tries to use it.
  //
  // ⚠️ Ordering looks wrong and is not: Playwright starts the webServers BEFORE
  // globalSetup, so this cannot run first. It does not need to. `next build`
  // occupies the first minutes of that command and the server does not open a
  // pool until it serves a request, which cannot happen before the readiness
  // gate below — which runs after this. If that ever changes, the symptom is a
  // clear auth error from the server, not a silent wrong-role run, because
  // `assertServerIsAppRole` refuses to let the spec proceed.
  if (isAppRoleE2E()) {
    const ownerUrl = process.env['DATABASE_URL'];
    if (!ownerUrl) throw new Error('[e2e-app-role] E2E_APP_ROLE=1 needs DATABASE_URL (the owner).');
    await ensureAppRoleCanLogIn(ownerUrl);
    console.warn('[e2e-app-role] provisioned the non-bypass role — the webServer runs as it.');
  }

  const baseUrl =
    config.projects[0]?.use?.baseURL ??
    process.env['E2E_BASE_URL'] ??
    `http://localhost:${process.env['PORT'] ?? '3000'}`;
  const attemptsEnv = Number(process.env['E2E_READINESS_ATTEMPTS'] ?? '');
  const attempts = Number.isFinite(attemptsEnv) && attemptsEnv > 0 ? attemptsEnv : undefined;

  console.warn(`[e2e-readiness] gating harness startup — app=${baseUrl}`);
  await assertHarnessReady({
    baseUrl,
    poll: attempts ? { attempts } : {},
  });
  console.warn('[e2e-readiness] harness fully ready — starting specs.');

  // Story MOTIR-3414 · Subtask MOTIR-3427 — the Postgres job engine's worker.
  //
  // Started HERE rather than as a `webServer` entry because it binds no port:
  // Playwright's webServer plugin polls a url/port for readiness and the worker
  // is a claim loop, not a server. After the readiness gate, so it connects to a
  // database the app has already proven reachable.
  //
  // ⚠️ IT IS THE LANE'S ONLY EXECUTOR NOW (MOTIR-3418). It used to run beside the
  // vendor dev server, which was the `webServer` entry that actually delivered
  // `email.send`; without this the outbox never fills and every `waitForEmail`
  // hangs.
  if (jobWorkerEnabled()) {
    console.warn('[e2e-job-worker] starting the Postgres job engine worker…');
    await startJobWorker();
    console.warn('[e2e-job-worker] worker ready.');
  }
}
