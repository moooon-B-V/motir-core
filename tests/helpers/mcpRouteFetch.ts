import * as route from '@/app/api/mcp/route';
import { trackServerWork } from './serverWork';

/**
 * A `fetch` for the MCP SDK client that calls the REAL `/api/mcp` route handler
 * in-process — `withMcpAuth` + `verifyMcpToken`, the rate limiter, the
 * production resolvers and the tool registry — with `token` as the bearer.
 *
 * Every handler call is TRACKED (`serverWork.ts`), because the SDK client starts
 * one request it never awaits: the SSE-stream GET it opens after `initialize`.
 * The in-flight probe settles tracked work before it checks the database, so a
 * short test no longer ends while that GET is still inside its auth or
 * rate-limit transaction (MOTIR-6324).
 *
 * The one copy of what used to be a `routeFetch` in each transport test file.
 */
export function mcpRouteFetch(token?: string): typeof fetch {
  return (async (input: unknown, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers = new Headers(init.headers ?? {});
    if (token) headers.set('authorization', `Bearer ${token}`);
    const method = (init.method ?? 'GET').toUpperCase();
    const handler = method === 'GET' ? route.GET : method === 'DELETE' ? route.DELETE : route.POST;
    return trackServerWork(handler(new Request(url, { ...init, headers }) as never));
  }) as unknown as typeof fetch;
}
