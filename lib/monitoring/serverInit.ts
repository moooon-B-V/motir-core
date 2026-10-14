import {
  monitoringInstanceTags,
  serverMonitoringEnvironment,
  serverSentryDsn,
  serverTracesSampleRate,
} from './config';
import { dropClientDisconnectAborts } from './clientDisconnect';
import { dropExpectedDomainErrors } from './expectedDomainErrors';
import { dropOrphanedSpanTransactions } from './orphanedSpans';
import { restoreChosenRootName } from './transactionName';
import { tagTransactionStall } from './transactionStall';

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

/**
 * The Node runtimes' `beforeSend`: drop React's abort for a client that left a
 * streaming page (MOTIR-8204, `./clientDisconnect`) and an expected domain 4xx,
 * then tag a Prisma transaction timeout (P2028) with what the process was
 * waiting on (MOTIR-6701, `./transactionStall`). The drops run first so nothing
 * is tagged that is not going to be sent.
 */
export function serverBeforeSend(
  ...args: Parameters<typeof dropExpectedDomainErrors>
): ReturnType<typeof dropExpectedDomainErrors> {
  const [event, hint] = args;
  const kept = dropClientDisconnectAborts(event, hint) && dropExpectedDomainErrors(event, hint);
  return kept ? tagTransactionStall(kept, hint) : null;
}

/**
 * The Node runtimes' `beforeSendTransaction`: drop a transaction made of spans
 * that outlived their already-sent request (MOTIR-8567, `./orphanedSpans`), then
 * put back a root name request code chose, which Next's own event-time rename
 * overwrote (MOTIR-8566, `./transactionName`). It runs after every
 * `preprocessEvent` hook, which is the only reason the rename is restored here
 * rather than at the rename.
 */
export function serverBeforeSendTransaction<E extends Parameters<typeof restoreChosenRootName>[0]>(
  event: E,
): E | null {
  const kept = dropOrphanedSpanTransactions(event);
  return kept ? restoreChosenRootName(kept) : null;
}

/** The SDK's own `pg` instrumentation, by the name `@sentry/node` registers it. */
export const SENTRY_AUTO_POSTGRES_INTEGRATION = 'Postgres';

/** The default integrations minus the `Postgres` auto-instrumentation. */
export function withoutAutoPostgresSpans<I extends { name: string }>(defaults: I[]): I[] {
  return defaults.filter((integration) => integration.name !== SENTRY_AUTO_POSTGRES_INTEGRATION);
}

/** The `Sentry.init` options a Node runtime should use, or null when monitoring
 *  is off.
 *
 *  Returning null rather than an object with an empty DSN is what preserves the
 *  self-host contract: a build with no DSN must not call `init` at all, so it
 *  installs no integrations, patches no globals and opens no transport. The
 *  caller's `if` is the gate.
 *
 *  `traces: true` is how a caller OPTS IN to performance tracing at the
 *  deployment's `SENTRY_TRACES_SAMPLE_RATE` (MOTIR-8549). Only the web server
 *  does. Everyone else gets an explicit `0` — never an omitted key, because an
 *  omitted `tracesSampleRate` lets the Node SDK read `SENTRY_TRACES_SAMPLE_RATE`
 *  itself, and a Fly secret reaches every process group of the app: the job
 *  worker and the terminal relay would start tracing the day production's rate
 *  is set. */
export function serverSentryInitOptions(opts?: { traces?: boolean }): {
  dsn: string;
  environment: string | undefined;
  tracesSampleRate: number;
  initialScope: { tags: Record<string, string> };
  integrations: typeof withoutAutoPostgresSpans;
  beforeSend: typeof serverBeforeSend;
  beforeSendTransaction: typeof serverBeforeSendTransaction;
  sendDefaultPii: false;
} | null {
  const dsn = serverSentryDsn();
  if (!dsn) return null;
  return {
    dsn,
    environment: serverMonitoringEnvironment(),
    tracesSampleRate: opts?.traces === true ? serverTracesSampleRate() : 0,
    // Which machine, process group and region sent the event — on the scope so
    // a transaction carries it too, not only an error (MOTIR-8549).
    initialScope: { tags: monitoringInstanceTags() },
    // Statement spans come from the SDK's `Prisma` integration (MOTIR-8550,
    // `./transactionSpan`). The `Postgres` one would draw every statement a
    // second time from inside `pg`, which Next leaves unbundled, so it is removed.
    integrations: withoutAutoPostgresSpans,
    // Expected typed domain 4xx are the product refusing on purpose, not
    // faults — see the module this comes from for why the discriminator is the
    // shipped status map and not an error-shape heuristic.
    // …and a P2028 that IS a fault carries the readings that say which stall
    // caused it (MOTIR-6701).
    beforeSend: serverBeforeSend,
    // A transaction never passes through `beforeSend`; this is its own hook.
    beforeSendTransaction: serverBeforeSendTransaction,
    // No request bodies, no headers, no cookies, no IP. An error report is a
    // subset of what the database already holds ONLY if we keep it that way,
    // and `sendDefaultPii` is the switch that decides. MOTIR-1161's transfer
    // basis (DPF + SCCs) was recorded for error payloads, not for session
    // cookies.
    sendDefaultPii: false,
  };
}
