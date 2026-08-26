// Sentry for the BROWSER (Subtask 8.5.6 / MOTIR-1162).
//
// Next runs this file — by this exact name, at the project root — before the
// app hydrates, which is what makes it the client's equivalent of
// `instrumentation.ts`. Two things depend on the name rather than on the
// contents, so do not rename it:
//
//   1. Next only loads `instrumentation-client.*`.
//   2. `withSentryConfig`'s Turbopack value-injection rule matches
//      `**/instrumentation-client.*` and is how `_sentryRewritesTunnelPath`
//      (the `/monitoring` relay) reaches the browser bundle at all
//      (`@sentry/nextjs`'s `generateValueInjectionRules`). Move the init into a
//      module this file imports and the tunnel path is silently not injected —
//      events then go straight at `*.ingest.sentry.io` and an ad blocker eats
//      them, which is the exact failure the tunnel exists to prevent.
//
// ⚠️ THE DSN IS COMPILED IN, NOT READ. `NEXT_PUBLIC_SENTRY_DSN` is substituted
// by `next build`; a Fly runtime secret can never reach this file. See
// `lib/monitoring/config.ts`'s header and the `Dockerfile`'s `ARG` block.
import * as Sentry from '@sentry/nextjs';
import {
  clientMonitoringEnvironment,
  clientSentryDsn,
  MONITORING_TRACES_SAMPLE_RATE,
} from '@/lib/monitoring/config';

const dsn = clientSentryDsn();

if (dsn) {
  Sentry.init({
    dsn,
    environment: clientMonitoringEnvironment(),
    tracesSampleRate: MONITORING_TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
    // No session replay. It records the DOM, which on this product means work
    // item titles, comment bodies and customer names — a materially different
    // category of data from a stack trace, and one MOTIR-1161's subprocessor
    // record does not cover. Turning it on is a privacy decision with a DPA
    // consequence, so it is a deliberate `false` rather than an unset default.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}

// Navigation spans for the App Router. Exported unconditionally: it is a no-op
// when `Sentry.init` was never called, and Next warns about the missing hook if
// the export is absent — a warning on every self-hosted build would be noise
// about a working configuration.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
