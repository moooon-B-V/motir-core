import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { serverSentryInitOptions } from '@/lib/monitoring/serverInit';
import { digestOf, onRequestError } from '@/lib/monitoring/requestError';

// THE SERVER EVENT CARRIES THE DIGEST THE BROWSER WAS SHOWN (MOTIR-8214).
//
// The authed error boundary tags its redacted browser report with `digest`
// (`lib/monitoring/reportCaughtError.ts`). These tests assert the server half:
// that the event `onRequestError` sends — through the REAL SDK, over the wire —
// carries the same tag, so the two events join by searching one value. The
// CONTROL arm shows an error with no digest sends no `digest` tag, so a wrapper
// that always tagged something could not pass.

const request = { path: '/workbench', method: 'GET', headers: {} };
const context = {
  routerKind: 'App Router',
  routePath: '/workbench',
  routeType: 'render',
} as const;

describe('reading the digest Next stamped on the error', () => {
  it('returns a non-empty string digest and null for anything else', () => {
    expect(digestOf(Object.assign(new Error('x'), { digest: '3352963289' }))).toBe('3352963289');
    expect(digestOf(new Error('x'))).toBeNull();
    expect(digestOf(Object.assign(new Error('x'), { digest: '' }))).toBeNull();
    expect(digestOf(Object.assign(new Error('x'), { digest: 42 }))).toBeNull();
    expect(digestOf('a thrown string')).toBeNull();
    expect(digestOf(null)).toBeNull();
  });
});

describe('the request-error event reaches the monitor tagged with its digest', () => {
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
    dsn = `http://publickey@127.0.0.1:${port}/1`;
  });

  afterAll(async () => {
    const Sentry = await import('@sentry/nextjs');
    await Sentry.close(2_000);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    received = [];
    vi.unstubAllEnvs();
  });

  async function initSentry(): Promise<typeof import('@sentry/nextjs')> {
    vi.stubEnv('SENTRY_DSN', dsn);
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({ ...serverSentryInitOptions()!, defaultIntegrations: false });
    return Sentry;
  }

  it('an error carrying a digest is POSTed with `digest` as a tag', async () => {
    const Sentry = await initSentry();
    const err = Object.assign(new TypeError("Cannot read properties of null (reading 'owner')"), {
      digest: '3352963289',
    });

    await onRequestError(err, request, context);
    await Sentry.flush(5_000);

    const envelope = received.join('\n');
    expect(envelope).toContain("reading 'owner'");
    expect(envelope).toContain('"digest":"3352963289"');
    // The SDK's own request context still rides along — the wrapper adds, it
    // does not replace.
    expect(envelope).toContain('"router_path":"/workbench"');
  }, 30_000);

  it('CONTROL: an error with no digest is POSTed with no `digest` tag', async () => {
    const Sentry = await initSentry();

    await onRequestError(new Error('no digest here'), request, context);
    await Sentry.flush(5_000);

    const envelope = received.join('\n');
    expect(envelope).toContain('no digest here');
    expect(envelope).not.toContain('"digest":');
  }, 30_000);

  it('the tag does not leak onto a later event captured outside the hook', async () => {
    const Sentry = await initSentry();
    await onRequestError(Object.assign(new Error('tagged'), { digest: '111' }), request, context);
    await Sentry.flush(5_000);
    received = [];

    Sentry.captureException(new Error('after the hook'));
    await Sentry.flush(5_000);

    const envelope = received.join('\n');
    expect(envelope).toContain('after the hook');
    expect(envelope).not.toContain('"digest":"111"');
  }, 30_000);
});
