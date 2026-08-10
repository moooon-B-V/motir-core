import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { MCP_SERVER_INFO, registerMcpTools } from '@/lib/mcp/registry';
import { contextFromAuthInfo, contextFromExtra, scopesFromExtra } from '@/lib/mcp/context';
import { verifyMcpToken } from '@/lib/mcp/auth';
import { enforceMcpRateLimit } from '@/lib/rateLimit/mcpGuard';
import { stampRateLimitHeaders } from '@/lib/rateLimit/guard';

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
//
// ── Rate limiting: TWO layers, because one address carries two costs (2610). ─
// `withMcpAuth` → `limitedHandler` → the JSON-RPC dispatch, in that order. The
// transport layer here spends `mcp:call` on EVERY authenticated request — a
// VOLUME ceiling covering reads, writes, an agent's polling loop, and the
// `initialize` / `tools/list` traffic no tool callback ever sees — and refuses
// with a 429 carrying a JSON-RPC error envelope. The MONEY ceiling on the two
// tools that submit a model job lives one layer in, at the dispatch seam
// (`registerMcpTools(…, meterBillableTools)` → `lib/mcp/rateLimitGate.ts`), so
// spend is metered per TOOL rather than per request. Both use the shared store
// and the shipped guards; `lib/rateLimit/mcpGuard.ts` carries the key-axis
// reasoning (user + workspace, like `/api/ai/*` — NOT the PAT fingerprint).

export const runtime = 'nodejs';
// Readiness + work-item state flip constantly; never serve a cached MCP body.
export const dynamic = 'force-dynamic';

const baseHandler = createMcpHandler(
  // Register the tool surface on the per-request server, wiring each tool to the
  // production context resolver (reads the bearer-resolved actor off authInfo)
  // and the per-token scope gate (reads the token's granted scopes off the same
  // authInfo) — so every tool call is narrowed to the scopes the token holds
  // (Subtask 7.7.17) before the unchanged 6.4 role checks run in the service.
  // The trailing `true` turns on the billable-tool gate (MOTIR-2610): the two
  // job-submitting tools spend the `ai:generate` budget — the browser's own —
  // before they run.
  (server) => registerMcpTools(server, contextFromExtra, scopesFromExtra, true),
  { serverInfo: MCP_SERVER_INFO },
  { basePath: '/api', disableSse: true },
);

/**
 * The transport rate limiter, between the auth gate and the JSON-RPC dispatch.
 *
 * It sits INSIDE `withMcpAuth` deliberately: `req.auth` is what the key is built
 * from, and an unauthenticated caller must never be able to spend a real
 * tenant's budget (the ordering `/api/v1` pins for the same reason — a 401 exits
 * without touching the limiter).
 *
 * Headers ride EVERY response, not only the refusals, so a client can pace
 * itself before it hits the wall rather than discovering the ceiling by being
 * refused at it.
 */
async function limitedHandler(req: Request): Promise<Response> {
  const { refusal, headers } = await enforceMcpRateLimit(contextFromAuthInfo(req.auth));
  if (refusal) return refusal;
  return stampRateLimitHeaders(await baseHandler(req), headers);
}

const handler = withMcpAuth(limitedHandler, verifyMcpToken, { required: true });

export { handler as GET, handler as POST, handler as DELETE };
