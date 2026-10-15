import type { Server } from 'node:http';
import globalTeardown from './global-teardown';
import { CAPTURE_SERVER_KEY } from './observability-global-setup';
import { stopSentryCapture } from './_helpers/sentry-capture';

// The observability lane's globalTeardown (MOTIR-8557): drain the job worker as
// the main lane does, then close the Sentry ingest. The capture FILE is kept, so
// CI can upload it from a failed run.

export default async function observabilityGlobalTeardown(): Promise<void> {
  await globalTeardown();
  await stopSentryCapture((globalThis as Record<symbol, unknown>)[CAPTURE_SERVER_KEY] as Server);
}
