import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { MCP_SERVER_INFO, registerMcpTools } from '@/lib/mcp/registry';
import { contextFromExtra, scopesFromExtra } from '@/lib/mcp/context';
import { verifyMcpToken } from '@/lib/mcp/auth';

// The Motir MCP server (Story 7.8 · Subtask 7.8.4) — one streamable-HTTP
// endpoint exposing the PM core to AI agents and the CLI (7.9), all of which
// speak Model Context Protocol to this single URL.
//
// ── Transport pick (the card asked to evaluate + record). ──────────────────
// We use Vercel's `mcp-handler` (the maintained App-Router adapter) rather than
// wiring `@modelcontextprotocol/sdk`'s transport by hand: the SDK's server
// transport is Node-`req/res`-shaped, and mcp-handler is the piece that bridges
// the Next.js Web `Request`/`Response` to it (creating a fresh stateless
// `WebStandardStreamableHTTPServerTransport` per POST). It also threads the
// resolved `req.auth` straight into each tool handler's `extra.authInfo`, which
// is exactly the actor seam this server needs.
//
// ── Path: a static `/api/mcp` (not the `[transport]` layout). ──────────────
// We serve streamable HTTP ONLY (no legacy SSE), so we don't need the
// `[transport]` dynamic segment that multiplexes `/mcp` vs `/sse`. A static
// `app/api/mcp/route.ts` gives the clean client-facing URL the docs use
// (`/api/mcp`) AND avoids a dynamic catch-all at the `/api` root that an
// `app/api/[transport]/route.ts` would introduce. `mcp-handler` matches the
// request pathname against the endpoint derived from `basePath`, so
// `basePath: '/api'` derives the streamable endpoint to exactly `/api/mcp`;
// `disableSse` turns off the SSE/redis path entirely (stateless, no redis).
//
// ── Auth: transport-level bearer PAT, gated BEFORE any tool dispatch. ───────
// `withMcpAuth(..., { required: true })` runs `verifyMcpToken` on every request
// and rejects an absent/invalid/revoked/expired token with a 401 before a tool
// ever executes. On success the resolved `{ userId, workspaceId }` rides
// `AuthInfo.extra`; `contextFromExtra` lifts it into the `ServiceContext` every
// tool passes to the SAME permission-scoped services the HTTP routes call (6.4
// roles + the 404-not-403 cross-tenant contract). No tool re-checks auth.

export const runtime = 'nodejs';
// Readiness + work-item state flip constantly; never serve a cached MCP body.
export const dynamic = 'force-dynamic';

const baseHandler = createMcpHandler(
  // Register the tool surface on the per-request server, wiring each tool to the
  // production context resolver (reads the bearer-resolved actor off authInfo)
  // and the per-token scope gate (reads the token's granted scopes off the same
  // authInfo) — so every tool call is narrowed to the scopes the token holds
  // (Subtask 7.7.17) before the unchanged 6.4 role checks run in the service.
  (server) => registerMcpTools(server, contextFromExtra, scopesFromExtra),
  { serverInfo: MCP_SERVER_INFO },
  { basePath: '/api', disableSse: true },
);

const handler = withMcpAuth(baseHandler, verifyMcpToken, { required: true });

export { handler as GET, handler as POST, handler as DELETE };
