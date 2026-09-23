import { createMcpHandler } from 'mcp-handler';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// A client that goes away mid-call must not crash the MCP endpoint (Bug MOTIR-5857).
//
// ⚠️ THE DEFECT, as it reproduces. `mcp-handler@1.1.0` answers a streamable-HTTP
// POST by pumping the SDK transport's SSE body, chunk by chunk, into a
// `ReadableStream` of its own (`createServerResponseAdapter`). That stream has no
// `cancel` callback and its `write` calls `controller.enqueue` unconditionally. When
// the consumer CANCELS the response body — the client disconnected, Next.js tears
// the response down — the stream is closed, and the next chunk the tool's result
// produces throws `TypeError: Invalid state: Controller is already closed`. The
// library fires its handler with `void`, so the throw is an UNHANDLED REJECTION with
// no application frame in it: exactly the production event, `POST /api/mcp`, whose
// stack showed only `mcp-handler/dist/index.mjs` and Node's web-streams internals.
//
// ⚠️ WHY IT NEEDS A SLOW TOOL. The Response resolves at `writeHead`, which the
// library calls as soon as the SDK hands back its SSE stream — BEFORE the tool has
// returned. A tool that finishes first leaves every chunk buffered, and a cancel
// after that is harmless. The window is the tool's own running time, which is why
// production saw it only twice: a long call whose caller gave up.
//
// No database and no route: this is the LIBRARY's transport under the options the
// route passes it (`basePath: '/api'`, `disableSse: true`), with one tool whose
// completion the test controls. The route's own wiring is `route.test.ts`'s.

const MCP_URL = 'http://localhost/api/mcp';

function slowToolHandler() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished!: () => void;
  const toolFinished = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const handler = createMcpHandler(
    (server) => {
      server.tool('slow', 'Resolves when the test releases it', async () => {
        await gate;
        finished();
        return { content: [{ type: 'text', text: 'done' }] };
      });
    },
    { serverInfo: { name: 'stream-cancel-test', version: '0.0.0' } },
    { basePath: '/api', disableSse: true },
  );
  return { handler, release, toolFinished };
}

function callTool(name: string, signal?: AbortSignal): Request {
  return new Request(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    }),
    signal,
  });
}

/** Let the pump read the tool's chunk and try to write it. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 10));
}

describe('MCP transport — a consumer that cancels mid-call (MOTIR-5857)', () => {
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
  });

  it('a body cancelled before the tool returns raises no unhandled "Controller is already closed"', async () => {
    const { handler, release, toolFinished } = slowToolHandler();

    const response = await handler(callTool('slow'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    await response.body!.cancel();
    release();
    await toolFinished;
    await drain();

    expect(rejections.map(String)).toEqual([]);
  });

  it('a request aborted (the client hung up) before the tool returns raises nothing either', async () => {
    const { handler, release, toolFinished } = slowToolHandler();
    const client = new AbortController();

    const response = await handler(callTool('slow', client.signal));
    client.abort();
    await response.body!.cancel();
    release();
    await toolFinished;
    await drain();

    expect(rejections.map(String)).toEqual([]);
  });

  it('a consumer that stays still receives the whole result — the guard drops nothing it should deliver', async () => {
    const { handler, release } = slowToolHandler();

    const response = await handler(callTool('slow'));
    release();
    const body = await response.text();

    expect(body).toContain('"result"');
    expect(body).toContain('done');
    expect(rejections).toEqual([]);
  });
});
