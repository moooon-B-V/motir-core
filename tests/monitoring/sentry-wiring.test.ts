import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MONITORING_TUNNEL_ROUTE } from '@/lib/monitoring/config';
import {
  dropExpectedDomainErrors,
  isExpectedDomainError,
} from '@/lib/monitoring/expectedDomainErrors';
import { ApiV1Error, DOMAIN_ERROR_STATUS } from '@/lib/api/v1/errors';
import { RATE_LIMIT_EXCLUDED_PATHS } from '@/lib/rateLimit/guard';
import type { ErrorEvent, EventHint } from '@sentry/nextjs';

// Error monitoring, wired end to end (Subtask 8.5.6 / MOTIR-1162).
//
// Everything this card ships is CONFIGURATION, and configuration is the thing
// that fails silently: an unset build argument, a `next.config` key the bundler
// never reads, a tunnel path in two files that drift apart. None of those is
// visible from a green build — which is why the assertions below are about
// wiring rather than behaviour, in the style `tests/ci-fly-deploy.test.ts`
// established for the deploy job.

const ROOT = process.cwd();
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const nextConfigSource = readFileSync(join(ROOT, 'next.config.ts'), 'utf8');

/** The `deploy` job's YAML, sliced out the way the fly-deploy guard does. */
function deployJob(): string {
  const start = ci.indexOf('\n  deploy:\n');
  expect(start).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = /\n {2}[a-z][a-z0-9-]*:\n/.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

describe('the tunnel route is ONE value, agreed on by both files that name it', () => {
  it('is excluded from rate limiting', () => {
    // Subtask 8.5.9 added `/monitoring` to the exclusion list BEFORE this card
    // existed, naming it in the comment — which is the right thing to do and
    // also exactly how two copies of a path start drifting. This is the
    // assertion that keeps them one value: rename the tunnel and this fails
    // rather than the exclusion quietly stopping to apply.
    expect(RATE_LIMIT_EXCLUDED_PATHS).toContain(MONITORING_TUNNEL_ROUTE);
  });

  it('is what `next.config.ts` hands to `withSentryConfig`', () => {
    // The tunnel is a Next REWRITE, so nothing in `app/api/**` implements it and
    // no route test can reach it. The wiring is the only thing there is to
    // assert, and asserting it on the CONSTANT rather than on the string is what
    // makes the exclusion above meaningful.
    expect(nextConfigSource).toContain('tunnelRoute: MONITORING_TUNNEL_ROUTE');
  });

  it('is not behind the auth proxy — a browser reporting an error may be signed out', () => {
    // The card asks for the tunnel to be added to "any CSP/route allowlist".
    // There is no Content-Security-Policy in this repo (nothing sets the header),
    // so the only gate that could swallow it is `proxy.ts`'s matcher — which
    // redirects a cookie-less request to `/sign-in`. An error report from a
    // signed-out visitor is exactly the report you most want, so this asserts the
    // ABSENCE rather than leaving it to be noticed when one goes missing.
    const proxySource = readFileSync(join(ROOT, 'proxy.ts'), 'utf8');
    const matcher = /matcher:\s*\[([^\]]*)\]/.exec(proxySource)?.[1] ?? '';
    expect(matcher).not.toBe('');
    expect(matcher).not.toContain(MONITORING_TUNNEL_ROUTE);
  });

  it('is a path, not a host or a full URL', () => {
    expect(MONITORING_TUNNEL_ROUTE.startsWith('/')).toBe(true);
    expect(MONITORING_TUNNEL_ROUTE).not.toContain('://');
  });
});

describe('the BUILD-ARGUMENT seam exists, because a NEXT_PUBLIC_* value cannot be a runtime secret', () => {
  it('the Dockerfile declares an ARG for every build-time monitoring value', () => {
    // `Dockerfile` on `origin/main` declared ZERO ARGs before this card — the
    // fact MOTIR-1161 recorded and the reason the browser half could not have
    // been configured at all. A regression here does not error: it produces a
    // client bundle with an empty DSN that reports nothing, for ever.
    for (const arg of [
      'NEXT_PUBLIC_SENTRY_DSN',
      'NEXT_PUBLIC_SENTRY_ENVIRONMENT',
      'MOTIR_RELEASE',
      'SENTRY_ORG',
      'SENTRY_PROJECT',
    ]) {
      expect(dockerfile).toMatch(new RegExp(`^ARG ${arg}=`, 'm'));
      expect(dockerfile).toMatch(new RegExp(`${arg}=\\$${arg}`));
    }
  });

  it('every ARG defaults to empty, so a build with no arguments still succeeds', () => {
    // The self-host path: `docker build` with no `--build-arg` must produce a
    // working image with monitoring off, not a build failure and not a hardcoded
    // vendor value.
    const args = [...dockerfile.matchAll(/^ARG (\w+)=(.*)$/gm)];
    expect(args.length).toBeGreaterThanOrEqual(5);
    for (const [, name, value] of args) expect([name, value]).toEqual([name, '""']);
  });

  it('the deploy step passes each one, and the RELEASE is the commit SHA', () => {
    const deploy = deployJob();
    expect(deploy).toContain('--build-arg "NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN"');
    expect(deploy).toContain('--build-arg "MOTIR_RELEASE=$GITHUB_SHA"');
    expect(deploy).toContain('--build-arg "SENTRY_ORG=$SENTRY_ORG"');
    expect(deploy).toContain('--build-arg "SENTRY_PROJECT=$SENTRY_PROJECT"');
  });

  it('carries the AUTH TOKEN as a build SECRET, never as a build argument', () => {
    // A `--build-arg` value is recorded in the build's own metadata. The
    // distinction is the whole reason the token is the one value that does not
    // appear in the ARG block above.
    const deploy = deployJob();
    expect(deploy).toContain('--build-secret "SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN"');
    expect(deploy).not.toContain('--build-arg "SENTRY_AUTH_TOKEN');
    expect(dockerfile).toContain('--mount=type=secret,id=SENTRY_AUTH_TOKEN');
    expect(dockerfile).not.toMatch(/^ARG SENTRY_AUTH_TOKEN/m);
  });

  it('refuses to release when a monitoring secret is missing', () => {
    // An unset secret degrades monitoring silently — an empty DSN builds a
    // bundle that reports nothing, an empty token ships unreadable stack
    // traces. Neither turns a check red on its own, so the deploy stops instead.
    const deploy = deployJob();
    expect(deploy).toContain('Missing monitoring secret(s)');
    expect(deploy).toMatch(/for name in NEXT_PUBLIC_SENTRY_DSN SENTRY_AUTH_TOKEN/);
  });

  it('asserts the source-map upload RAN, rather than that it was configured', () => {
    // The card's own warning: `outputFileTracingExcludes` is a live example of a
    // `next.config` key this build never reads (MOTIR-2403), so "configured" is
    // not evidence. The release existing in Sentry is, because the SDK's
    // Turbopack path creates it inside the same after-compile hook that uploads
    // the maps.
    const deploy = deployJob();
    expect(deploy).toContain('/releases/$GITHUB_SHA/');
    expect(deploy).toMatch(/::error::Sentry has no release named/);
    expect(deploy).toMatch(/exit 1/);
  });
});

describe("the source-map uploader's CLI binary is present without its postinstall", () => {
  it('resolves to a file on disk', () => {
    // `pnpm-workspace.yaml` sets `'@sentry/cli': false`, so its postinstall does
    // not run. That is correct — the script is a CDN FALLBACK that exits 0 the
    // moment the per-platform optional package resolves — but the failure mode
    // if it ever stops being correct is SILENT: no binary means source maps do
    // not upload, and a deploy with unreadable stack traces looks exactly like a
    // healthy one. `@sentry/bundler-plugin-core` even ships a
    // `sentryCliBinaryExists()` helper for this, whose comment says post-install
    // scripts "may not always run".
    //
    // Resolved the way the upload path resolves it — from the plugin's own
    // module — rather than from this test's directory, so a hoisting change
    // cannot make it pass against a copy the uploader never sees.
    const fromNextSdk = createRequire(require.resolve('@sentry/nextjs/package.json'));
    const fromPluginCore = createRequire(fromNextSdk.resolve('@sentry/bundler-plugin-core'));
    const SentryCli = fromPluginCore('@sentry/cli') as { getPath(): string };

    const binary = SentryCli.getPath();
    expect(binary).toContain('sentry-cli');
    expect(existsSync(binary), `sentry-cli is not at ${binary}`).toBe(true);
  });
});

describe('expected typed domain 4xx are not reported as errors', () => {
  it('drops a domain error the API answers with a 4xx', () => {
    const err = Object.assign(new Error('no such work item'), {
      code: 'WORK_ITEM_NOT_FOUND',
    });
    expect(DOMAIN_ERROR_STATUS['WORK_ITEM_NOT_FOUND']).toBe(404);
    expect(isExpectedDomainError(err)).toBe(true);
    expect(dropExpectedDomainErrors({} as ErrorEvent, { originalException: err })).toBeNull();
  });

  it('drops an `ApiV1Error` carrying a 4xx status', () => {
    expect(isExpectedDomainError(new ApiV1Error('RATE_LIMITED', 429, 'slow down'))).toBe(true);
  });

  it('KEEPS a domain error the API answers with a 5xx', () => {
    // The filter that would have been wrong: "in the map ⇒ drop". That map also
    // carries 503 rows, and a dependency being down is the thing you most want
    // to be paged about.
    const fiveHundreds = Object.entries(DOMAIN_ERROR_STATUS).filter(([, s]) => s >= 500);
    expect(fiveHundreds.length).toBeGreaterThan(0);
    for (const [code] of fiveHundreds) {
      const err = Object.assign(new Error('upstream down'), { code });
      expect(isExpectedDomainError(err)).toBe(false);
    }
  });

  it('KEEPS a real fault, and one wearing the same shape', () => {
    expect(isExpectedDomainError(new Error('boom'))).toBe(false);
    // `code: 'ECONNREFUSED'` is exactly the shape a naive heuristic would have
    // matched on. It is not in the vocabulary, so it is a fault.
    expect(
      isExpectedDomainError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })),
    ).toBe(false);
  });

  it('sees a domain error re-thrown as the CAUSE of something generic', () => {
    const inner = Object.assign(new Error('not a member'), { code: 'NOT_A_MEMBER' });
    const outer = new Error('handler failed', { cause: inner });
    expect(isExpectedDomainError(outer)).toBe(true);
  });

  it('returns the event untouched when it is kept', () => {
    const event = { event_id: 'abc' } as ErrorEvent;
    const hint: EventHint = { originalException: new Error('boom') };
    expect(dropExpectedDomainErrors(event, hint)).toBe(event);
  });

  it('terminates on a self-referential cause chain', () => {
    const err: Error & { cause?: unknown } = new Error('loop');
    err.cause = err;
    expect(isExpectedDomainError(err)).toBe(false);
  });
});

describe('the resolved Next config actually carries the tunnel (MOTIR-1162)', () => {
  it('registers a rewrite at the tunnel path, forwarding to Sentry ingest', async () => {
    // The strongest cheap assertion available: `tunnelRoute` is an OPTION until
    // `withSentryConfig` turns it into a rewrite, and an option that silently
    // stops taking effect is precisely this card's stated risk (the inert
    // `outputFileTracingExcludes` one file over). Resolving the real config and
    // asking it for its rewrites is the difference between "we passed the
    // option" and "the route exists".
    const { default: config } = (await import('../../next.config')) as {
      default: { rewrites?: () => Promise<unknown> };
    };
    expect(typeof config.rewrites).toBe('function');

    const rewrites = (await config.rewrites!()) as { source: string; destination: string }[];
    const tunnel = rewrites.filter((r) => r.source.startsWith(MONITORING_TUNNEL_ROUTE));

    // Two: one for the region-qualified ingest host and one for the bare one.
    expect(tunnel.length).toBeGreaterThanOrEqual(1);
    for (const rule of tunnel) expect(rule.destination).toContain('ingest');
  });
});
