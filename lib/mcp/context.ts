import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The MCP layer's actor plumbing (Story 7.8 · Subtask 7.8.4).
//
// Every MCP tool calls the SAME permission-scoped services the HTTP routes
// call, so it needs the SAME `ServiceContext` ({ userId, workspaceId }) the
// routes thread through. The difference is WHERE the context comes from: an
// HTTP route reads it from the cookie session (`getWorkspaceContext()`); an
// MCP request has no cookie — the actor is resolved from the bearer PAT by the
// transport-level auth gate (`verifyMcpToken`, lib/mcp/auth.ts), which stashes
// the resolved `{ userId, workspaceId }` in `AuthInfo.extra`. By the time a
// tool handler runs, that gate has ALREADY accepted the request (mcp-handler's
// `withMcpAuth({ required: true })` rejects an absent/invalid token with a 401
// BEFORE any tool dispatch), so the handler can trust `extra.authInfo` to be
// present — `contextFromExtra` only re-validates defensively.
//
// `McpContextResolver` is the seam that makes the tools testable without the
// transport: the registry takes a resolver, production passes
// `contextFromExtra` (reads the real AuthInfo), and tests pass a resolver that
// returns a fixed context. Tools never read `AuthInfo` directly — they call the
// resolver — so the auth wiring stays in exactly one place.

/** The per-request handler `extra` an MCP tool callback receives. */
export type McpRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Resolves the acting {@link ServiceContext} for one MCP tool call from the
 * request `extra`. Production wiring: {@link contextFromExtra}. Tests inject a
 * fixed-context resolver so a tool's service-wrapping can be exercised without
 * the auth transport.
 */
export type McpContextResolver = (extra: McpRequestExtra) => ServiceContext;

/**
 * The shape `verifyMcpToken` writes into `AuthInfo.extra` — the resolved actor
 * for the request. Kept as its own type so the auth gate (writer) and the tool
 * resolver (reader) agree on the keys.
 */
export interface McpAuthExtra {
  userId: string;
  workspaceId: string;
  /** The token owner's display name — carried for log/diagnostic context only. */
  userName: string | null;
  /** The token's granted capability scopes (Story 7.7 · Subtask 7.7.16) —
   * carried so the dispatch gate (7.7.17) can narrow the owner's 6.4 role to
   * the operations these scopes permit. Each entry is a `TokenScope`
   * (`lib/mcp/scopes.ts`); validated at mint time. */
  scopes: string[];
}

/**
 * Thrown when a tool handler runs without a resolved actor in `extra.authInfo`.
 * This should be unreachable in production (the `withMcpAuth` gate rejects
 * unauthenticated requests before dispatch); it exists so a misconfiguration
 * fails loudly rather than calling a service with an undefined actor.
 */
export class McpMissingContextError extends Error {
  readonly code = 'MCP_MISSING_CONTEXT' as const;
  constructor() {
    super('MCP tool dispatched without a resolved actor context.');
    this.name = 'McpMissingContextError';
  }
}

/** Narrow `AuthInfo.extra` to the {@link McpAuthExtra} we wrote into it. */
function readAuthExtra(authInfo: AuthInfo | undefined): McpAuthExtra | null {
  const extra = authInfo?.extra;
  if (!extra || typeof extra !== 'object') return null;
  const { userId, workspaceId } = extra as Record<string, unknown>;
  if (typeof userId !== 'string' || typeof workspaceId !== 'string') return null;
  const userName = (extra as Record<string, unknown>).userName;
  const rawScopes = (extra as Record<string, unknown>).scopes;
  const scopes = Array.isArray(rawScopes)
    ? rawScopes.filter((s): s is string => typeof s === 'string')
    : [];
  return {
    userId,
    workspaceId,
    userName: typeof userName === 'string' ? userName : null,
    scopes,
  };
}

/**
 * Production {@link McpContextResolver}: lift the actor the auth gate resolved
 * out of `extra.authInfo` into a `ServiceContext`. Throws
 * {@link McpMissingContextError} if it's absent (a gate misconfiguration).
 */
export function contextFromExtra(extra: McpRequestExtra): ServiceContext {
  const authExtra = readAuthExtra(extra.authInfo);
  if (!authExtra) throw new McpMissingContextError();
  return { userId: authExtra.userId, workspaceId: authExtra.workspaceId };
}
