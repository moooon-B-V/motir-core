import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContextResolver } from './context';
import { GET_WORK_ITEM_TOOL_NAME, registerGetWorkItem } from './tools/getWorkItem';
import { LIST_READY_TOOL_NAME, registerListReady } from './tools/listReady';
import { NEXT_READY_TOOL_NAME, registerNextReady } from './tools/nextReady';
import { WHOAMI_TOOL_NAME, registerWhoami } from './tools/whoami';

// The MCP tool registry (Story 7.8 · Subtask 7.8.4) — the single place that
// assembles the server's tool surface. This is the SEAM the write tools (7.8.5),
// search (7.8.6), and the sprint tools (7.8.10) extend: add the tool module
// under `tools/`, import its `register*`, and add one line to `registerMcpTools`
// — without touching the transport (`app/api/mcp/route.ts`) or the auth gate
// (`lib/mcp/auth.ts`). Every tool resolves its acting `ServiceContext` through
// the injected `resolveContext`, so auth lives in exactly one place and the
// tools stay testable with a fixed-context resolver.

/** Identifying info the MCP `initialize` handshake reports to clients. */
export const MCP_SERVER_INFO = { name: 'motir', version: '0.1.0' } as const;

/** Stable tool names — exported so consumers/tests reference them by constant. */
export const MCP_TOOL_NAMES = [
  GET_WORK_ITEM_TOOL_NAME,
  LIST_READY_TOOL_NAME,
  NEXT_READY_TOOL_NAME,
  WHOAMI_TOOL_NAME,
] as const;

/** Register every MCP tool on `server`, wiring each to `resolveContext`. */
export function registerMcpTools(server: McpServer, resolveContext: McpContextResolver): void {
  registerGetWorkItem(server, resolveContext);
  registerListReady(server, resolveContext);
  registerNextReady(server, resolveContext);
  registerWhoami(server, resolveContext);
}

/**
 * Build a fully-registered {@link McpServer}. The transport creates one per
 * request (stateless streamable HTTP); tests build one and connect it to an
 * in-memory client. `resolveContext` supplies each tool's actor — production
 * passes `contextFromExtra` (reads the bearer-resolved `AuthInfo`); tests pass a
 * fixed-context resolver.
 */
export function buildMcpServer(resolveContext: McpContextResolver): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);
  registerMcpTools(server, resolveContext);
  return server;
}
