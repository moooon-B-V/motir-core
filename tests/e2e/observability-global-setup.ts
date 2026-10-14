import type { FullConfig } from '@playwright/test';
import globalSetup from './global-setup';
import {
  OBSERVABILITY_CAPTURE_FILE,
  OBSERVABILITY_CAPTURE_PORT,
} from './_helpers/observability-const';
import { startSentryCapture } from './_helpers/sentry-capture';

// The observability lane's globalSetup (MOTIR-8557): start the local Sentry
// ingest, then run the main lane's readiness gate and job worker unchanged.
//
// ⚠️ ORDER. Playwright starts the webServer BEFORE globalSetup, so the server is
// already up when this runs. That costs nothing: the SDK sends an envelope only
// when a request finishes, and the only requests before this point are
// Playwright's own readiness probes. Their envelopes go to a closed port and are
// dropped, which no case reads. The ingest is up before the readiness gate below
// and before the first spec.
//
// The server lives in the runner process for the whole run, kept on
// `globalThis` so `observability-global-teardown.ts` can close it.

export const CAPTURE_SERVER_KEY = Symbol.for('motir.e2e.sentryCapture');

export default async function observabilityGlobalSetup(config: FullConfig): Promise<void> {
  const server = await startSentryCapture(OBSERVABILITY_CAPTURE_PORT, OBSERVABILITY_CAPTURE_FILE);
  (globalThis as Record<symbol, unknown>)[CAPTURE_SERVER_KEY] = server;
  console.warn(
    `[e2e-observability] Sentry capture on 127.0.0.1:${OBSERVABILITY_CAPTURE_PORT} → ${OBSERVABILITY_CAPTURE_FILE}`,
  );
  await globalSetup(config);
}
