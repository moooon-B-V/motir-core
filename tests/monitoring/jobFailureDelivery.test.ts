import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ⚠️ THE DEMONSTRATION, NOT A MOCK (MOTIR-3606).
//
// `jobFailureAlert.test.ts` asserts what the alert SAYS, with the SDK stubbed.
// This file asserts that something actually goes out over a socket: the REAL
// `@sentry/nextjs` Node SDK, initialised through the SAME
// `serverSentryInitOptions()` the app and the worker use, pointed at a DSN whose
// host is a throwaway HTTP server in this process. A terminal job failure is
// reported, the client is flushed, and the envelope is read off the wire.
//
// It exists because the card's acceptance criterion is *"a red daily health check
// produces a signal outside `job_run` that a person actually receives; the
// mechanism is named and demonstrated once"* — and a test that only proves
// `captureException` was called demonstrates the call, not the delivery. The
// thing that failed for 23 days was never the call.
//
// WHAT IT DOES NOT PROVE, said plainly rather than left to be assumed: the last
// hop. Sentry mails a project member when an issue is created, and that is a
// setting in Sentry's own project, not in this repository — no test here can
// reach it. What this proves is everything up to and including Motir handing the
// event to the transport, over real HTTP, with the job id on it.

/** One envelope the SDK POSTed, as raw text (newline-delimited JSON). */
let received: string[] = [];
let server: Server;
let dsn: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"deadbeef"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // The DSN shape the SDK parses: <scheme>://<publicKey>@<host>:<port>/<projectId>.
  // `http` rather than `https` so the throwaway server needs no certificate.
  dsn = `http://publickey@127.0.0.1:${port}/1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  received = [];
  vi.unstubAllEnvs();
});

describe('a terminally failed job is DELIVERED, not merely captured', () => {
  it('sends NOTHING when there is no DSN — the self-host contract, over the wire', async () => {
    // The mirror assertion, and the one that has to be checked on a socket
    // rather than on a spy: "we tried it once and nothing happened" is an
    // anecdote (`sentry-init-gate.test.ts` says so about `init`); an empty
    // request log after a real capture is a measurement.
    vi.stubEnv('SENTRY_DSN', '');

    const { serverSentryInitOptions } = await import('@/lib/monitoring/serverInit');
    expect(serverSentryInitOptions()).toBeNull();

    const { alertTerminalJobFailure } = await import('@/lib/monitoring/jobFailureAlert');
    alertTerminalJobFailure({
      functionId: 'system.daily-health-check',
      eventName: 'scheduled.system.daily-health-check',
      workspaceId: null,
      attempts: 1,
      engine: 'engine',
      error: new Error('boom'),
    });

    const { flush } = await import('@sentry/nextjs');
    await flush(1_000);
    expect(received).toEqual([]);
  }, 30_000);

  it('POSTs an envelope naming the job and the fault, over real HTTP', async () => {
    vi.stubEnv('SENTRY_DSN', dsn);
    vi.stubEnv('SENTRY_ENVIRONMENT', 'test');

    const Sentry = await import('@sentry/nextjs');
    const { serverSentryInitOptions } = await import('@/lib/monitoring/serverInit');
    const { alertTerminalJobFailure } = await import('@/lib/monitoring/jobFailureAlert');

    const options = serverSentryInitOptions();
    expect(options).not.toBeNull();
    Sentry.init({ ...options!, defaultIntegrations: false });

    const error = new Error(
      "The fleet's INDEXER image cannot be pulled: registry.fly.io/motir-index-runners@sha256:0b4d…",
    );
    error.name = 'IndexFleetImageUnpullableError';

    alertTerminalJobFailure({
      functionId: 'system.daily-health-check',
      eventName: 'scheduled.system.daily-health-check',
      workspaceId: null,
      attempts: 1,
      engine: 'engine',
      error,
    });

    // `flush` is what makes this deterministic: the SDK batches, and asserting
    // without it would race the transport — the exact shape the repo's
    // E2E-authoritative-signal rule forbids, one runtime down.
    await Sentry.flush(5_000);

    expect(received.length).toBeGreaterThan(0);
    const envelope = received.join('\n');
    // The three things a person needs off the wire: WHICH job, WHAT broke, and
    // the routing tag an alert rule filters on.
    expect(envelope).toContain('system.daily-health-check');
    expect(envelope).toContain('IndexFleetImageUnpullableError');
    expect(envelope).toContain('job_terminal_failure');
    await Sentry.close(2_000);
  }, 30_000);
});
