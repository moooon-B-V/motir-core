// A RUNNER-LOCAL SSE server that writes frames ONE AT A TIME (Story MOTIR-7974 ·
// MOTIR-7982).
//
// This lane's motir-ai is a mock whose job stream is one fixed body, and both
// `route.fulfill` and the undici intercept answer with a WHOLE body — every frame
// lands in one chunk, so no spec could show a line appearing while its stream is
// still open. This server holds each connection open and writes a frame only
// when the spec says so. A spec points the browser's own stream request at it
// with `page.route(…, (r) => r.continue({ url: server.url }))`, so the page's
// `consumeStream` reads a real, incremental `text/event-stream` response.
//
// It is a test seam, not a planner: what it writes is exactly what the spec
// hands it, in the shape of `lib/planning/planChangeFrames.ts`'s contract.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SseFrameServer {
  /** The address a re-targeted request is sent to. */
  readonly url: string;
  /** Resolves with the NEXT connection the browser opens (armed before the
   *  action that opens it, like any `waitForResponse`). */
  nextConnection(): Promise<void>;
  /** Write one frame to the current connection. */
  write(event: string, data: unknown): void;
  /** Write `done` and close the current connection. */
  done(): void;
  close(): Promise<void>;
}

export async function startSseFrameServer(): Promise<SseFrameServer> {
  let current: ServerResponse | null = null;
  const waiters: (() => void)[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A re-targeted request is CROSS-origin to the browser even though the page
    // asked its own origin, and a same-origin `fetch` sends no `Origin` header —
    // so the wildcard is the case that matters (the stream is uncredentialed).
    const origin = req.headers.origin;
    const cors: Record<string, string> = origin
      ? {
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true',
          vary: 'origin',
        }
      : { 'access-control-allow-origin': '*' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET',
      });
      res.end();
      return;
    }
    res.writeHead(200, {
      ...cors,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    // Headers out NOW, so the page's `fetch` resolves while nothing is written.
    res.flushHeaders();
    current = res;
    for (const wake of waiters.splice(0)) wake();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const live = (): ServerResponse => {
    if (!current || current.writableEnded) throw new Error('no open stream to write to');
    return current;
  };

  return {
    url: `http://127.0.0.1:${port}/stream`,
    nextConnection: () => new Promise<void>((resolve) => waiters.push(resolve)),
    write(event, data) {
      live().write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    done() {
      const res = live();
      res.write('event: done\ndata: {}\n\n');
      res.end();
      current = null;
    },
    async close() {
      current?.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
