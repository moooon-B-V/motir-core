import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMcpHttpServer, type McpTestServer } from '../helpers/mcpHttpServer';
import {
  pendingServerWork,
  settleServerWork,
  SETTLE_DEADLINE_MS,
  trackServerWork,
} from '../helpers/serverWork';

/**
 * The settle the in-flight probe runs before every DB-backed test's database
 * check is BOUNDED (MOTIR-6496).
 *
 * Before this, `settleServerWork()` waited for ever: one tracked request that
 * never settled stayed in the pending set, so EVERY later test's `afterEach`
 * waited on it and failed at the 30 s hook budget, naming nothing — the
 * cascade that red `two-surface-conformance.test.ts` on an unrelated PR (8
 * tests passed in seconds, the last 3 each failed at ~31 s).
 *
 * The tests below are ORDERED on purpose: the first plants a never-settling
 * request, and the ones after it are the "next test in the file", which the
 * pre-fix settle turned into hook timeouts.
 */

const NEVER = new Promise<never>(() => {});
const SHORT_DEADLINE_MS = 200;

describe('settleServerWork has a deadline (MOTIR-6496)', () => {
  it('fails within the deadline, naming the unsettled request, and drops it', async () => {
    void trackServerWork(NEVER, 'POST /api/mcp');
    expect(pendingServerWork()).toBe(1);

    const started = Date.now();
    const error = await settleServerWork(SHORT_DEADLINE_MS).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('POST /api/mcp');
    // …and the test that STARTED it, so the report lands on the right test
    // even when read from a CI log.
    expect(message).toContain('fails within the deadline, naming the unsettled request');
    expect(Date.now() - started).toBeLessThan(SHORT_DEADLINE_MS + 2_000);
    // Dropped, so the next test starts clean.
    expect(pendingServerWork()).toBe(0);
  });

  it('the NEXT test in the file starts clean and settles instantly', async () => {
    expect(pendingServerWork()).toBe(0);
    let resolved = false;
    void trackServerWork(
      new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => {
        resolved = true;
      }),
      'GET /api/mcp',
    );
    await settleServerWork(SHORT_DEADLINE_MS);
    expect(resolved).toBe(true);
    expect(pendingServerWork()).toBe(0);
  });

  it('still waits for work a settling request registers on its way out', async () => {
    let inner = false;
    void trackServerWork(
      Promise.resolve().then(() => {
        void trackServerWork(
          new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => {
            inner = true;
          }),
          'GET /inner',
        );
      }),
      'POST /outer',
    );
    await settleServerWork(SHORT_DEADLINE_MS);
    expect(inner).toBe(true);
    expect(pendingServerWork()).toBe(0);
  });

  it('the default deadline sits well under the 30 s hook budget the probe runs in', () => {
    // vitest.config.ts `hookTimeout: 30_000`. The settle and the database read
    // after it share that one hook, so the settle must leave the read room.
    expect(SETTLE_DEADLINE_MS).toBeLessThanOrEqual(15_000);
  });
});

describe('the socket harness settles a request whose client hung up mid-stream (MOTIR-6496)', () => {
  let server: McpTestServer;
  let cancelled = false;

  beforeAll(async () => {
    server = await startMcpHttpServer({
      extraRoutes: {
        // An event stream that sends one event and then never ends — the shape
        // of the streamable-HTTP transport's answer while a client still reads.
        '/test/endless-stream': {
          GET: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('event: message\ndata: {}\n\n'));
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            ),
        },
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('a client that closes before the stream ends leaves no tracked work pending', async () => {
    const { hostname, port } = new URL(server.url);
    await new Promise<void>((resolve, reject) => {
      const req = request(
        { hostname, port, path: '/test/endless-stream', method: 'GET' },
        (res) => {
          res.once('data', () => {
            // The first event arrived; hang up while the server is mid-stream.
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
      req.end();
    });

    await settleServerWork(SHORT_DEADLINE_MS * 10);

    expect(pendingServerWork()).toBe(0);
    // The route's stream was told the reader went away, rather than left paused.
    expect(cancelled).toBe(true);
  });
});

describe('the socket harness settles a request whose client hung up BEFORE the route answered (MOTIR-7855)', () => {
  let server: McpTestServer;
  let entered!: () => void;
  const handlerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let cancelled = false;

  beforeAll(async () => {
    server = await startMcpHttpServer({
      extraRoutes: {
        // The MCP SDK client's un-awaited SSE GET: the route is still inside its
        // auth + rate-limit transactions when the test's `client.close()` hangs
        // up, and only THEN answers 405. The gate stands in for those
        // transactions, so the hang-up lands before the answer every time.
        '/test/slow-refusal': {
          GET: async () => {
            entered();
            await gate;
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"error":"Method not allowed."}'));
                  controller.close();
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { status: 405, headers: { 'content-type': 'application/json' } },
            );
          },
        },
      },
    });
  });

  afterAll(async () => {
    release();
    await server.close();
  });

  it('a client that closes while the route is still working leaves no tracked work pending', async () => {
    const { hostname, port } = new URL(server.url);
    const req = request({ hostname, port, path: '/test/slow-refusal', method: 'GET' });
    req.on('error', () => {
      // The hang-up below is the point; a reset on the client side is expected.
    });
    req.end();

    await handlerEntered;
    req.destroy();
    // The authoritative signal that the SERVER has seen the hang-up: it no longer
    // holds the socket, so the response's 'close' has already been emitted.
    await expect.poll(() => server.openConnections()).toBe(0);
    release();

    await settleServerWork(SHORT_DEADLINE_MS * 10);

    expect(pendingServerWork()).toBe(0);
    // The route's answer was cancelled rather than left paused with no reader.
    expect(cancelled).toBe(true);
  });
});
