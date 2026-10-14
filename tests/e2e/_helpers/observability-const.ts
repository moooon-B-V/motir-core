import path from 'node:path';

// The observability lane's fixed values (MOTIR-8557), shared by
// `playwright.observability.config.ts`, its global setup and its spec so the
// three cannot drift.

/** The local Sentry ingest (`./sentry-capture.ts`) the server's DSN points at. */
export const OBSERVABILITY_CAPTURE_PORT = 9393;
/** The file the ingest writes and the spec reads. Under `out/` so CI uploads it. */
export const OBSERVABILITY_CAPTURE_FILE = path.resolve('out', 'e2e-sentry-capture.jsonl');
/** The server's private metrics port (`MONITORING_METRICS_PORT`). */
export const OBSERVABILITY_METRICS_PORT = 9191;

/** The instance the lane's server says it is — its `FLY_*` env. */
export const OBSERVABILITY_FLY_ENV = {
  FLY_MACHINE_ID: 'e2e-machine-1',
  FLY_PROCESS_GROUP: 'app',
  FLY_REGION: 'iad',
} as const;
