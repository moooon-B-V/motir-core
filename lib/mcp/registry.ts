import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContextResolver } from './context';
import { GET_WORK_ITEM_TOOL_NAME, registerGetWorkItem } from './tools/getWorkItem';
import { LIST_READY_TOOL_NAME, registerListReady } from './tools/listReady';
import { NEXT_READY_TOOL_NAME, registerNextReady } from './tools/nextReady';
import { CREATE_WORK_ITEM_TOOL_NAME, registerCreateWorkItem } from './tools/createWorkItem';
import { TRANSITION_STATUS_TOOL_NAME, registerTransitionStatus } from './tools/transitionStatus';
import { ADD_COMMENT_TOOL_NAME, registerAddComment } from './tools/addComment';
import { SEARCH_WORK_ITEMS_TOOL_NAME, registerSearchWorkItems } from './tools/searchWorkItems';
import { LIST_SPRINTS_TOOL_NAME, registerListSprints } from './tools/listSprints';
import { CREATE_SPRINT_TOOL_NAME, registerCreateSprint } from './tools/createSprint';
import { UPDATE_SPRINT_TOOL_NAME, registerUpdateSprint } from './tools/updateSprint';
import { DELETE_SPRINT_TOOL_NAME, registerDeleteSprint } from './tools/deleteSprint';
import { MOVE_TO_SPRINT_TOOL_NAME, registerMoveToSprint } from './tools/moveToSprint';
import { MOVE_TO_BACKLOG_TOOL_NAME, registerMoveToBacklog } from './tools/moveToBacklog';
import { START_SPRINT_TOOL_NAME, registerStartSprint } from './tools/startSprint';
import { COMPLETE_SPRINT_TOOL_NAME, registerCompleteSprint } from './tools/completeSprint';

// The MCP tool registry (Story 7.8 · Subtask 7.8.4, extended by 7.8.5 / 7.8.6 /
// 7.8.10) — the single place that assembles the server's tool surface. This is
// the SEAM each later subtask extends: add the tool module under `tools/`,
// import its `register*`, and add one line to `registerMcpTools` — without
// touching the transport (`app/api/mcp/route.ts`) or the auth gate
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
  CREATE_WORK_ITEM_TOOL_NAME,
  TRANSITION_STATUS_TOOL_NAME,
  ADD_COMMENT_TOOL_NAME,
  SEARCH_WORK_ITEMS_TOOL_NAME,
  LIST_SPRINTS_TOOL_NAME,
  CREATE_SPRINT_TOOL_NAME,
  UPDATE_SPRINT_TOOL_NAME,
  DELETE_SPRINT_TOOL_NAME,
  MOVE_TO_SPRINT_TOOL_NAME,
  MOVE_TO_BACKLOG_TOOL_NAME,
  START_SPRINT_TOOL_NAME,
  COMPLETE_SPRINT_TOOL_NAME,
] as const;

/** Register every MCP tool on `server`, wiring each to `resolveContext`. */
export function registerMcpTools(server: McpServer, resolveContext: McpContextResolver): void {
  // Read + dispatch tools (7.8.4).
  registerGetWorkItem(server, resolveContext);
  registerListReady(server, resolveContext);
  registerNextReady(server, resolveContext);
  // Write tools (7.8.5).
  registerCreateWorkItem(server, resolveContext);
  registerTransitionStatus(server, resolveContext);
  registerAddComment(server, resolveContext);
  // Query tool (7.8.6).
  registerSearchWorkItems(server, resolveContext);
  // Sprint tools (7.8.10) — the Scrum cadence over the shipped Epic-4 services.
  registerListSprints(server, resolveContext);
  registerCreateSprint(server, resolveContext);
  registerUpdateSprint(server, resolveContext);
  registerDeleteSprint(server, resolveContext);
  registerMoveToSprint(server, resolveContext);
  registerMoveToBacklog(server, resolveContext);
  registerStartSprint(server, resolveContext);
  registerCompleteSprint(server, resolveContext);
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
