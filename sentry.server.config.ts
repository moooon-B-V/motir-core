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
import { serverSentryInitOptions } from '@/lib/monitoring/serverInit';

// ⚠️ THE OPTIONS MOVED, THE GATE DID NOT (MOTIR-3606). `serverSentryInitOptions()`
// returns null when there is no DSN, so this file still calls `init` exactly
// when it used to and never otherwise — which is what
// `tests/monitoring/sentry-init-gate.test.ts` asserts. What changed is that a
// SECOND Node process now needs the same options: the job WORKER
// (`scripts/worker.ts`) is a plain Node bundle that never runs
// `instrumentation.ts`, so every scheduled job in production was failing with no
// error monitoring behind it at all. Two Node runtimes reading one options
// builder is not the shared helper the gate test's header declines — that one is
// about the EDGE runtime, which resolves `@sentry/nextjs` to a different build
// and genuinely cannot share this.
const options = serverSentryInitOptions();
if (options) Sentry.init(options);
