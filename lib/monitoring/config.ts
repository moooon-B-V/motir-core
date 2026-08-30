// The monitoring seam — ONE place that answers "is error monitoring on, and
// what is this build?" for all four Sentry entry points (server, edge, client,
// `next.config.ts`) — and, as of MOTIR-3606, for the job WORKER, which is a
// fifth and is not a Next entry point at all.
//
// ⚠️ THIS FILE IS IMPORTED BY `next.config.ts`, SO IT MAY IMPORT ALMOST NOTHING.
// Next transpiles the config with a plain Node resolver that does not understand
// the `@/` path alias, so a transitive import reaching one fails the BUILD with
// `MODULE_NOT_FOUND` — pointing at a file several hops away, which is a long way
// from the line that caused it. MOTIR-3606 hit exactly that by adding a
// `dropExpectedDomainErrors` import here; the options builder that needs it
// lives in `./serverInit` instead, which no Next config touches. Keep this
// module free of anything but `process.env` reads.
//
// Subtask 8.5.6 / MOTIR-1162. The provisioned values and which of the two homes
// each belongs in are recorded on MOTIR-1161; this file is the code side of
// that split, and the split is the whole reason the file exists:
//
//   SERVER / EDGE  `SENTRY_DSN`, `SENTRY_ENVIRONMENT`  → Fly RUNTIME secrets,
//                  read from `process.env` when the process boots.
//   CLIENT         `NEXT_PUBLIC_SENTRY_DSN`            → a Docker BUILD
//                  ARGUMENT, inlined into the browser bundle by `next build`.
//
// ⚠️ THE CLIENT HALF CANNOT BE A RUNTIME SECRET, AND GETTING THAT WRONG FAILS
// SILENTLY. A `NEXT_PUBLIC_*` value is substituted into the JavaScript at BUILD
// time, so a Fly secret set afterwards is invisible to the browser: the
// integration reviews cleanly, its tests pass, and not one client-side error is
// ever reported. That is why the `Dockerfile` declares an `ARG` for it and
// `ci.yml`'s deploy step passes `--build-arg` — see both, and MOTIR-1161's
// warning table.
//
// ⚠️ AND THE LITERAL MATTERS. `process.env['NEXT_PUBLIC_SENTRY_DSN']` is
// replaced by the bundler because the key is written out here as a literal. A
// dynamic lookup (`process.env[name]`) is NOT replaced and yields `undefined`
// in the browser — the same silent failure one step further in. Every read
// below is a literal on purpose.

/**
 * The same-origin path browser events are relayed through, instead of being
 * posted straight at `*.ingest.sentry.io`.
 *
 * Ad blockers and tracking-protection lists match on the vendor host, so a
 * direct post is dropped for a large minority of real users — silently, and
 * disproportionately among the technical ones. `withSentryConfig`'s
 * `tunnelRoute` turns this path into a Next REWRITE (not a route handler) that
 * forwards the envelope on, so the request the browser makes is same-origin and
 * indistinguishable from any other.
 *
 * ⚠️ It is a REWRITE, which is why nothing in `app/api/**` implements it and why
 * no route-level guard sees it. It is nevertheless listed in
 * `RATE_LIMIT_EXCLUDED_PATHS` (`lib/rateLimit/guard.ts`, added by Subtask 8.5.9
 * naming this card) so the exclusion holds if the path ever DOES become a
 * handler. `tests/monitoring/sentry-wiring.test.ts` asserts the two agree —
 * a constant and a string literal in another file are exactly the pair that
 * drifts.
 */
export const MONITORING_TUNNEL_ROUTE = '/monitoring';

/**
 * The DSN the SERVER and EDGE runtimes report with — a Fly runtime secret.
 *
 * Empty / unset ⇒ monitoring is OFF and `Sentry.init` is never called. That is
 * the self-hoster path: a build with no DSN anywhere phones nowhere, and the
 * property falls out of the mechanism rather than needing a flag to enforce it.
 */
export function serverSentryDsn(): string | undefined {
  return nonEmpty(process.env['SENTRY_DSN']);
}

/**
 * The DSN the BROWSER reports with — inlined at build time. See the header.
 */
export function clientSentryDsn(): string | undefined {
  return nonEmpty(process.env['NEXT_PUBLIC_SENTRY_DSN']);
}

/**
 * Which BUILD this is — the 40-char commit SHA, passed as a build argument
 * (`--build-arg MOTIR_RELEASE=${{ github.sha }}`), per MOTIR-1161's release /
 * environment convention and `production-service-stack.md` §4.
 *
 * ⚠️ It has to be a build argument, and the reason is not stylistic: source maps
 * are uploaded DURING the image build and must be tagged with the same string
 * the running code reports. Fly injects `FLY_APP_NAME` / `FLY_MACHINE_ID` at
 * runtime, which identify the machine, not the build — and `.git` is in
 * `.dockerignore`, so the SDK's own `git rev-parse HEAD` fallback finds nothing
 * inside the image. Without this argument a release is simply never named.
 *
 * Read by `next.config.ts` — the SDKs then read the value back out of
 * `process.env._sentryRelease`, which `withSentryConfig` writes into Next's
 * `env` config from this same string — and, since MOTIR-3760, by
 * `/api/health/release`, which is how a monitor OUTSIDE the deployment learns
 * which commit is running and compares it against `main`. That second reader is
 * why the `Dockerfile`'s RUNNER stage now declares the argument as well as the
 * builder: the builder's `ENV` is scoped to its own stage, so until then this
 * accessor returned `undefined` in the running server.
 */
export function monitoringRelease(): string | undefined {
  return nonEmpty(process.env['MOTIR_RELEASE']);
}

/**
 * Which DEPLOYMENT this is, for the SERVER and EDGE runtimes — a Fly runtime
 * secret (`SENTRY_ENVIRONMENT=production`, already staged by MOTIR-1161).
 *
 * Deliberately NOT baked in: it is the one thing that distinguishes two
 * deployments of the SAME image, so a future staging app must be able to say so
 * without a rebuild. Baking it in surfaces as staging errors labelled
 * `production` — invisible until it matters.
 */
export function serverMonitoringEnvironment(): string | undefined {
  return nonEmpty(process.env['SENTRY_ENVIRONMENT']);
}

/**
 * Which DEPLOYMENT this is, for the BROWSER.
 *
 * ⚠️ THE RUNTIME RULE ABOVE CANNOT HOLD ON THIS SIDE, and saying so is better
 * than pretending it does. A browser bundle is a build artifact: there is no
 * `process.env` in it to read at runtime, so the environment is either compiled
 * in or shipped in the HTML. This card compiles it in, defaulting to
 * `production`, with `NEXT_PUBLIC_SENTRY_ENVIRONMENT` as the override a
 * non-production image can pass through the same build-argument seam.
 *
 * The consequence is bounded and worth naming: if a staging app is ever run
 * from the SAME image as production, its SERVER events will be labelled
 * `staging` (runtime secret) and its BROWSER events `production`. The fix at
 * that point is one more `--build-arg` on the staging build, not a code change.
 */
export function clientMonitoringEnvironment(): string {
  return nonEmpty(process.env['NEXT_PUBLIC_SENTRY_ENVIRONMENT']) ?? 'production';
}

/**
 * The share of transactions sampled for performance tracing.
 *
 * Zero, deliberately: this card buys ERROR monitoring, and performance tracing
 * on a pre-launch app with no traffic baseline is cost with nothing to compare
 * it against. Raising it is a decision with a bill attached, so it is a
 * constant with a comment rather than a silent default.
 */
export const MONITORING_TRACES_SAMPLE_RATE = 0;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
