// Sentry for the Edge runtime (Subtask 8.5.6 / MOTIR-1162).
//
// A sibling of `sentry.server.config.ts` rather than a share of it: the Edge
// runtime resolves `@sentry/nextjs` through the `edge-light` export condition
// to a different build with a different integration set, so the two inits are
// two calls even where the options look alike. `proxy.ts` and any
// `runtime = 'edge'` route are what run here.
//
// The DSN is the SERVER one — the Edge runtime is server-side code, so it reads
// the Fly runtime secret, not the build-time browser copy. Unset ⇒ no init.
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
    beforeSend: dropExpectedDomainErrors,
    sendDefaultPii: false,
  });
}
