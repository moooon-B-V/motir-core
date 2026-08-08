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
// What it deliberately is NOT: a stand-in for `next dev`. It serves the routes it
// is asked for and 404s everything else, which keeps a test that accidentally
// depends on some other route honest instead of silently passing against a
// hand-built fake. By default that is exactly ONE path — the MCP endpoint —
// because that is the entire surface the CLI talks to once it holds a credential
// (packages/cli/src/client.ts: "the ONE place the CLI talks to a Motir server").
//
// `cliDeviceRoutes: true` adds the second surface, and the ONLY other one: the
// two `/api/cli/device/*` endpoints `motir login` speaks BEFORE a credential
// exists — `start` and `token` (packages/cli/src/deviceAuth.ts). Real route
// modules, so the device-login suite drives the shipped grant → mint → bearer
// chain over a socket with nothing stubbed (MOTIR-1870).
//
// The grant's BROWSER half (`/api/cli/device/grant` + `/approve`) is deliberately
// NOT served: both are cookie-session routes gated by `getSession()`, which reads
// `next/headers` and therefore only resolves inside a real Next request. A test
// approves out-of-band through the service (with a real signed-in session's
// headers, as `cliDeviceService.test.ts` does); the browser path over HTTP is
// Playwright's subject, not this adapter's.

/** Requests the MCP handler owns. `mcp-handler` derives this from
 *  `basePath: '/api'` (see app/api/mcp/route.ts) and matches the request pathname
 *  against it, so the path has to arrive exactly as the CLI sends it. */
const MCP_PATHNAME = '/api/mcp';

/** One route module, as the App Router exports it. */
interface RouteModule {
  GET?: RouteHandler;
  POST?: RouteHandler;
  PATCH?: RouteHandler;
  DELETE?: RouteHandler;
}

/**
 * A handler as Next.js calls it: the request, plus the resolved dynamic params.
 * The second argument became load-bearing with Story 11.2, whose routes are all
 * parameterised (`/work-items/[key]`).
 */
// Deliberately loose in its ARGS: a static route is typed
// `NextRouteArgs<Record<string, never>>` and a parameterised one
// `NextRouteArgs<{ key: string }>`, and the harness must accept both. It is the
// dispatcher's job to hand each the params it declares.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (req: Request, args?: any) => Promise<Response>;

/** The HTTP verbs this harness dispatches. */
const SERVED_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
type ServedMethod = (typeof SERVED_METHODS)[number];

/**
 * Match a request pathname against the registered route pathnames, resolving
 * Next.js DYNAMIC SEGMENTS (`/api/v1/work-items/[key]`).
 *
 * ⚠️ Added by Story 11.2 · Subtask 11.2.12 (MOTIR-2054). Story 11.1's endpoints
 * were all static, so an exact `Map.get` sufficed; every endpoint in 11.2 is
 * parameterised, and without this the conformance suite would 404 on the whole
 * resource surface — i.e. it would silently test nothing.
 *
 * A LITERAL segment beats a dynamic one at the same position, which is what
 * keeps `/work-items/[key]/archive` from swallowing a key called "archive" and
 * matches Next.js's own precedence.
 */
function matchRoute(
  routes: Map<string, RouteModule>,
  pathname: string,
): { mod: RouteModule; params: Record<string, string> } | undefined {
  const exact = routes.get(pathname);
  if (exact) return { mod: exact, params: {} };

  const wanted = pathname.split('/').filter(Boolean);
  let best: { mod: RouteModule; params: Record<string, string>; literals: number } | undefined;

  for (const [registered, mod] of routes) {
    const parts = registered.split('/').filter(Boolean);
    if (parts.length !== wanted.length) continue;

    const params: Record<string, string> = {};
    let literals = 0;
    let ok = true;
    for (const [i, part] of parts.entries()) {
      const segment = wanted[i] as string;
      const dynamic = /^\[(\w+)\]$/.exec(part);
      if (dynamic) {
        params[dynamic[1] as string] = decodeURIComponent(segment);
      } else if (part === segment) {
        literals += 1;
      } else {
        ok = false;
        break;
      }
    }
    if (ok && (best === undefined || literals > best.literals)) {
      best = { mod, params, literals };
    }
  }
  return best ? { mod: best.mod, params: best.params } : undefined;
}

export interface McpTestServerOptions {
  /**
   * Also serve Motir's CLI device-authorization routes (`/api/cli/device/*`) —
   * what `motir login` posts to before it has a bearer. Off by default: a suite
   * that only drives MCP should still 404 on everything else.
   */
  cliDeviceRoutes?: boolean;
  /**
   * Also serve the PUBLIC API (`/api/v1/**`) — Story 11.1 · Subtask 11.1.6
   * (MOTIR-1862). The conformance suite drives v1 as an EXTERNAL client would:
   * a real socket, a real PAT, the real route modules, real Postgres.
   *
   * The tree is DISCOVERED, not listed, so an endpoint Stories 11.2 / 11.3 add
   * is served the moment its file exists — the extensibility the card requires,
   * so those stories add cases rather than a second harness.
   */
  v1Routes?: boolean;
  /**
   * Extra handlers mounted at exact pathnames. Lets a suite put a FIXTURE route
   * behind the same socket — used to drive an envelope behaviour end to end
   * (e.g. the cross-tenant 404) that no shipped endpoint can raise yet.
   */
  extraRoutes?: Record<string, RouteModule>;
}

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
export async function startMcpHttpServer(
  options: McpTestServerOptions = {},
): Promise<McpTestServer> {
  const requests: McpTestServer['requests'] = [];
  const routes = new Map<string, RouteModule>([[MCP_PATHNAME, route as RouteModule]]);
  if (options.cliDeviceRoutes) {
    // Imported lazily so a suite that does not ask for them never pulls
    // Better-Auth's device plugin into its module graph.
    const [start, token] = await Promise.all([
      import('@/app/api/cli/device/start/route'),
      import('@/app/api/cli/device/token/route'),
    ]);
    routes.set('/api/cli/device/start', start as RouteModule);
    routes.set('/api/cli/device/token', token as RouteModule);
  }
  if (options.v1Routes) {
    // DISCOVERED, not listed, so the harness never goes stale: every
    // `app/api/v1/**/route.ts` is mounted at the pathname Next.js would serve
    // it from. Imported lazily, for the same reason as the device routes.
    const { loadV1RouteModules } = await import('./v1RouteAudit');
    for (const [pathname, mod] of await loadV1RouteModules()) {
      routes.set(pathname, mod as RouteModule);
    }
  }
  for (const [pathname, mod] of Object.entries(options.extraRoutes ?? {})) {
    routes.set(pathname, mod);
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({
        method: req.method ?? 'GET',
        pathname: url.pathname,
        authorization: req.headers.authorization ?? null,
      });
      const matched = matchRoute(routes, url.pathname);
      if (!matched) {
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
        const verb = (req.method ?? 'GET').toUpperCase();
        const method: ServedMethod = (SERVED_METHODS as readonly string[]).includes(verb)
          ? (verb as ServedMethod)
          : 'POST';
        const handler = matched.mod[method];
        if (!handler) {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'METHOD_NOT_ALLOWED' }));
          return;
        }
        await writeResponse(
          await handler(request as never, { params: Promise.resolve(matched.params) }),
          res,
        );
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
