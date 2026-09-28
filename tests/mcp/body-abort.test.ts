import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from 'mcp-handler';
import { NextRequest } from 'next/server';
import { signalFromNodeResponse } from 'next/dist/server/web/spec-extension/adapters/next-request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerClientAbort } from '@/lib/mcp/clientAbort';

// MOTIR-6853 — `POST /api/mcp` surfaced `Error: aborted` in production, grouped by
// the monitor into the same issue as MOTIR-6256's webhook event (every frame is
// inside `node:_http_server`: `abortIncoming` ← `socketOnClose`) but reported
// through `auto.node.onunhandledrejection`, not `onRequestError`.
//
// ⚠️ THE DEFECT, as it reproduces. `mcp-handler@1.1.0` reads a POST's body
// (`await req.json()`) inside a handler its route adapter fires and never awaits
// (`createMcpRouteHandler` → `createServerResponseAdapter`: `void fn(res)`, and
// `fn` drops the handler's promise). When the client closes the connection
// before the body has arrived, Node destroys the request stream with
// `Error: aborted` / `ECONNRESET`, the read rejects, and nothing is listening:
// an UNHANDLED REJECTION with no application frame — and the route's own promise
// never settles, because the response head it waits for is never written.
//
// A `Request` built over a string can never abort, so this drives a REAL socket,
// wired the way Next's `NextRequestAdapter.fromNodeNextRequest` builds a route
// handler's request (the Node request as the body, `duplex: 'half'`, the signal
// derived from the response) — the MOTIR-6256 harness. No database and no auth:
// the library's transport under the options the route passes it, plus the
// route's abort wrapper, which is what `app/api/mcp/route.ts` composes.

type Handler = (req: Request) => Promise<Response>;
type Outcome = { threw: unknown } | { status: number } | { pending: true };

/** How long a handler may take to settle before the test calls it hung. */
const SETTLE_MS = 1500;

function libraryHandler(): Handler {
  return createMcpHandler(
    (server) => {
      server.tool('echo', 'Returns a fixed string', async () => ({
        content: [{ type: 'text', text: 'echo' }],
      }));
    },
    { serverInfo: { name: 'body-abort-test', version: '0.0.0' } },
    { basePath: '/api', disableSse: true },
  );
}

/** Serve ONE request through `handler` the way Next's Node server does, and
 *  resolve with what the handler did — or `pending` if it never settled. */
function serveOnce(
  handler: Handler,
): Promise<{ port: number; outcome: Promise<Outcome>; close: () => void }> {
  let settle!: (o: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  const server = http.createServer((req, res) => {
    const signal = signalFromNodeResponse(res);
    const nextReq = new NextRequest(`http://localhost${req.url ?? '/'}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      duplex: 'half',
      signal,
      body: req as unknown as ReadableStream,
    } as ConstructorParameters<typeof NextRequest>[1]);
    const timer = setTimeout(() => settle({ pending: true }), SETTLE_MS);
    handler(nextReq).then(
      (response) => {
        clearTimeout(timer);
        settle({ status: response.status });
        if (!res.destroyed) res.end();
      },
      (err: unknown) => {
        clearTimeout(timer);
        settle({ threw: err });
      },
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        outcome,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

const TOOL_CALL = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'echo', arguments: {} },
});

/** Send the headers for a `declaredLength`-byte body, write `sent` of it, and
 *  close the socket after `closeAfterMs` (or never, for a well-behaved client). */
function send(
  port: number,
  {
    sent,
    declaredLength,
    closeAfterMs,
  }: { sent: string; declaredLength: number; closeAfterMs?: number },
): void {
  const socket = net.connect(port, '127.0.0.1', () => {
    socket.write(
      [
        'POST /api/mcp HTTP/1.1',
        'Host: localhost',
        'Content-Type: application/json',
        'Accept: application/json, text/event-stream',
        `Content-Length: ${declaredLength}`,
        '',
        '',
      ].join('\r\n') + sent,
    );
    if (closeAfterMs !== undefined) setTimeout(() => socket.destroy(), closeAfterMs);
  });
  socket.on('error', () => {});
  socket.on('data', () => {});
}

/** Let any rejection nobody handled reach `unhandledRejection`. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 10));
}

describe('MCP transport — a client that closes the connection before its body is read (MOTIR-6853)', () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };

  beforeEach(() => {
    rejections.length = 0;
    process.on('unhandledRejection', onRejection);
  });
  afterEach(() => {
    process.off('unhandledRejection', onRejection);
    vi.restoreAllMocks();
  });

  it('the library hands the abort back to its caller: no unhandled rejection, and the route promise settles', async () => {
    const { port, outcome, close } = await serveOnce(libraryHandler());
    send(port, {
      sent: TOOL_CALL.slice(0, 20),
      declaredLength: TOOL_CALL.length,
      closeAfterMs: 50,
    });
    const result = await outcome;
    await drain();
    close();

    expect(rejections.map(String)).toEqual([]);
    expect(result).toHaveProperty('threw');
    const err = (result as { threw: NodeJS.ErrnoException }).threw;
    expect(err.message).toBe('aborted');
    expect(err.code).toBe('ECONNRESET');
  });

  it('a body that is not JSON is ALSO handed back — a read failure that is not an abort still reaches the caller', async () => {
    // Before the fix this was the same floating rejection (a `SyntaxError`) plus a
    // request that never answered; now the route's caller — Next — reports it.
    const { port, outcome, close } = await serveOnce(libraryHandler());
    send(port, { sent: '{not json', declaredLength: '{not json'.length });
    const result = await outcome;
    await drain();
    close();

    expect(rejections.map(String)).toEqual([]);
    expect(result).toHaveProperty('threw');
    expect((result as { threw: unknown }).threw).toBeInstanceOf(SyntaxError);
  });

  it('through the route wrapper, the abort answers 499 and says so at warn level — never an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { port, outcome, close } = await serveOnce(answerClientAbort(libraryHandler()));
    send(port, {
      sent: TOOL_CALL.slice(0, 20),
      declaredLength: TOOL_CALL.length,
      closeAfterMs: 50,
    });
    const result = await outcome;
    await drain();
    close();

    expect(rejections.map(String)).toEqual([]);
    expect(result).toEqual({ status: 499 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('closed the connection'));
  });

  it('through the route wrapper, a read failure that is NOT an abort is re-thrown, not answered 499', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { port, outcome, close } = await serveOnce(answerClientAbort(libraryHandler()));
    send(port, { sent: '{not json', declaredLength: '{not json'.length });
    const result = await outcome;
    await drain();
    close();

    expect(rejections.map(String)).toEqual([]);
    expect((result as { threw: unknown }).threw).toBeInstanceOf(SyntaxError);
  });

  it('a client that stays receives the whole result — the wrapper and the patch change nothing it should get', async () => {
    const { port, outcome, close } = await serveOnce(answerClientAbort(libraryHandler()));
    send(port, { sent: TOOL_CALL, declaredLength: TOOL_CALL.length });
    const result = await outcome;
    await drain();
    close();

    expect(result).toEqual({ status: 200 });
    expect(rejections).toEqual([]);
  });
});
