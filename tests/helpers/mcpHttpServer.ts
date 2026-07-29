import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import * as route from '@/app/api/mcp/route';

// A real HTTP listener in FRONT of the real `/api/mcp` route handler (Story 7.9
// · Subtask 7.9.5 · MOTIR-883).
//
// The CLI integration suite spawns the BUILT `motir` binary as a CHILD PROCESS,
// so — unlike `tests/mcp/story-roundtrip.test.ts`, which hands the SDK client an
// in-process `fetch` that calls the route function directly — there has to be a
// socket to connect to. This adapts Node's `IncomingMessage`/`ServerResponse` to
// the Web `Request`/`Response` the App-Router handler speaks, and nothing else:
// the handler, `withMcpAuth` + `verifyMcpToken`, the production context/scope
// resolvers, the tool registry and the real Postgres underneath are all the
// shipped ones. No mocks, no stubbed transport (the repo's testing contract).
//
// What it deliberately is NOT: a stand-in for `next dev`. It serves exactly one
// path — the MCP endpoint — because that is the entire surface the CLI talks to
// (mcpClient.ts: "the ONE place the CLI talks to a Motir server"). Anything else
// 404s, which keeps a test that accidentally depends on some other route honest
// instead of silently passing against a hand-built fake.

/** Requests the handler owns. `mcp-handler` derives this from `basePath: '/api'`
 *  (see app/api/mcp/route.ts) and matches the request pathname against it, so the
 *  path has to arrive exactly as the CLI sends it. */
const MCP_PATHNAME = '/api/mcp';

export interface McpTestServer {
  /** Base URL to hand the CLI as `--server` (no trailing slash). */
  url: string;
  /** Every request the server saw, in order — lets a test assert that a command
   *  really did (or did not) go to the server. */
  requests: { method: string; pathname: string; authorization: string | null }[];
  close(): Promise<void>;
}

/** Collect a Node request body into one buffer (undefined for a bodiless verb),
 *  so the `Request` can be constructed without a `duplex` stream. */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Node's raw header list → a `Headers`. `rawHeaders` is a flat [k, v, k, v, …]
 *  array, which preserves repeats (`append`, not `set`). */
function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

/** Write a Web `Response` back onto the Node socket, streaming the body rather
 *  than buffering it: the streamable-HTTP transport answers a tool call with a
 *  `text/event-stream` the client reads incrementally. */
async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    const existing = headers[key];
    if (existing === undefined) headers[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[key] = [existing, value];
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      .on('error', reject)
      .on('end', resolve)
      .pipe(res);
  });
}

/**
 * Start the MCP endpoint on an ephemeral port and resolve once it is listening.
 * Every caller MUST `close()` it (an `afterAll`), or the vitest worker will not
 * exit.
 */
export async function startMcpHttpServer(): Promise<McpTestServer> {
  const requests: McpTestServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({
        method: req.method ?? 'GET',
        pathname: url.pathname,
        authorization: req.headers.authorization ?? null,
      });
      if (url.pathname !== MCP_PATHNAME) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'NOT_FOUND' }));
        return;
      }
      try {
        const body = await readBody(req);
        const request = new Request(`http://127.0.0.1${req.url ?? '/'}`, {
          method: req.method ?? 'GET',
          headers: toHeaders(req),
          // `Uint8Array`, not `Buffer`: the Web `RequestInit` body union does
          // not include Node's Buffer type.
          ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
        });
        const method = req.method === 'GET' ? 'GET' : req.method === 'DELETE' ? 'DELETE' : 'POST';
        const handler =
          method === 'GET' ? route.GET : method === 'DELETE' ? route.DELETE : route.POST;
        await writeResponse(await handler(request as never), res);
      } catch (err) {
        // A handler crash must surface as a 500 the CLI reports, never as an
        // unhandled rejection that takes the whole worker down mid-suite.
        console.error('MCP test server handler error:', err);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
