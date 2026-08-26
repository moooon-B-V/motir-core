// Sentry for the Node.js server runtime (Subtask 8.5.6 / MOTIR-1162).
//
// Imported by `instrumentation.ts`'s `register()` when `NEXT_RUNTIME` is
// `nodejs`, which is the earliest point in a server boot at which anything runs
// — so an error thrown while a route module is being evaluated is still caught.
//
// ⚠️ `Sentry.init` IS NOT CALLED WHEN THERE IS NO DSN, and that is the
// self-host contract rather than an optimisation: a build with no
// `SENTRY_DSN` installs no integrations, patches no globals, opens no
// transport and phones nowhere. `tests/monitoring/sentry-wiring.test.ts`
// asserts it, because "we tried it once and nothing happened" is not a
// property — it is an anecdote.
import * as Sentry from '@sentry/nextjs';
import {
  MONITORING_TRACES_SAMPLE_RATE,
  serverMonitoringEnvironment,
  serverSentryDsn,
} from '@/lib/monitoring/config';
import { dropExpectedDomainErrors } from '@/lib/monitoring/expectedDomainErrors';

const dsn = serverSentryDsn();

if (dsn) {
  Sentry.init({
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
  });
}
