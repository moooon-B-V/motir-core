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
