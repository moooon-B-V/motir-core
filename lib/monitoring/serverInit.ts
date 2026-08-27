import {
  MONITORING_TRACES_SAMPLE_RATE,
  serverMonitoringEnvironment,
  serverSentryDsn,
} from './config';
import { dropExpectedDomainErrors } from './expectedDomainErrors';

// THE NODE RUNTIMES' `Sentry.init` OPTIONS, IN ONE PLACE (MOTIR-3606).
//
// ⚠️ IT EXISTS BECAUSE THERE ARE TWO NODE PROCESSES, NOT ONE. The Next server
// initialises through `sentry.server.config.ts`, which `instrumentation.ts`
// imports; the job WORKER (`fly.toml`'s `worker` process group, entrypoint
// `scripts/worker.ts`) is a plain esbuild bundle that never executes a Next
// hook, so it initialised nothing. Every scheduled job in production — the daily
// health check included — therefore ran in a process with no error monitoring,
// which is half of why a red check reached nobody for 23 days.
//
// ⚠️ AND IT IS A SEPARATE FILE FROM `./config` FOR A BUILD REASON, NOT A TIDINESS
// ONE. `next.config.ts` imports `./config`, and Next transpiles its config with a
// plain Node resolver that does not understand the `@/` path alias. This module
// reaches `dropExpectedDomainErrors` → `@/lib/api/v1/errors`, so putting the
// builder in `config.ts` failed `next build` outright with `MODULE_NOT_FOUND`,
// reported against a file two hops from the import that caused it. Nothing that
// a Next config touches may import this file.
//
// The EDGE runtime is deliberately not a consumer: it resolves `@sentry/nextjs`
// through its `edge-light` export condition to a different SDK build, which is
// why `sentry.edge.config.ts` keeps its own init and why
// `tests/monitoring/sentry-init-gate.test.ts` asserts the gate per surface
// rather than once.

/** The `Sentry.init` options a Node runtime should use, or null when monitoring
 *  is off.
 *
 *  Returning null rather than an object with an empty DSN is what preserves the
 *  self-host contract: a build with no DSN must not call `init` at all, so it
 *  installs no integrations, patches no globals and opens no transport. The
 *  caller's `if` is the gate. */
export function serverSentryInitOptions(): {
  dsn: string;
  environment: string | undefined;
  tracesSampleRate: number;
  beforeSend: typeof dropExpectedDomainErrors;
  sendDefaultPii: false;
} | null {
  const dsn = serverSentryDsn();
  if (!dsn) return null;
  return {
    dsn,
    environment: serverMonitoringEnvironment(),
    tracesSampleRate: MONITORING_TRACES_SAMPLE_RATE,
    // Expected typed domain 4xx are the product refusing on purpose, not
    // faults — see the module this comes from for why the discriminator is the
    // shipped status map and not an error-shape heuristic.
    beforeSend: dropExpectedDomainErrors,
    // No request bodies, no headers, no cookies, no IP. An error report is a
    // subset of what the database already holds ONLY if we keep it that way,
    // and `sendDefaultPii` is the switch that decides. MOTIR-1161's transfer
    // basis (DPF + SCCs) was recorded for error payloads, not for session
    // cookies.
    sendDefaultPii: false,
  };
}
