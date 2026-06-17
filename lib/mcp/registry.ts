import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContextResolver, McpScopesResolver } from './context';
import { scopeGatedServer } from './scopeGate';
import { GET_WORK_ITEM_TOOL_NAME, registerGetWorkItem } from './tools/getWorkItem';
import { LIST_READY_TOOL_NAME, registerListReady } from './tools/listReady';
import { NEXT_READY_TOOL_NAME, registerNextReady } from './tools/nextReady';
import { CREATE_WORK_ITEM_TOOL_NAME, registerCreateWorkItem } from './tools/createWorkItem';
import { TRANSITION_STATUS_TOOL_NAME, registerTransitionStatus } from './tools/transitionStatus';
import { ADD_COMMENT_TOOL_NAME, registerAddComment } from './tools/addComment';
import { SEARCH_WORK_ITEMS_TOOL_NAME, registerSearchWorkItems } from './tools/searchWorkItems';
import { WHOAMI_TOOL_NAME, registerWhoami } from './tools/whoami';
import { LIST_SPRINTS_TOOL_NAME, registerListSprints } from './tools/listSprints';
import { CREATE_SPRINT_TOOL_NAME, registerCreateSprint } from './tools/createSprint';
import { UPDATE_SPRINT_TOOL_NAME, registerUpdateSprint } from './tools/updateSprint';
import { DELETE_SPRINT_TOOL_NAME, registerDeleteSprint } from './tools/deleteSprint';
import { MOVE_TO_SPRINT_TOOL_NAME, registerMoveToSprint } from './tools/moveToSprint';
import { MOVE_TO_BACKLOG_TOOL_NAME, registerMoveToBacklog } from './tools/moveToBacklog';
import { MOVE_TO_PARENT_TOOL_NAME, registerMoveToParent } from './tools/moveToParent';
import { START_SPRINT_TOOL_NAME, registerStartSprint } from './tools/startSprint';
import { COMPLETE_SPRINT_TOOL_NAME, registerCompleteSprint } from './tools/completeSprint';
import { MARK_INTEGRATED_TOOL_NAME, registerMarkIntegrated } from './tools/markIntegrated';
import { COMPLETE_SESSION_TOOL_NAME, registerCompleteSession } from './tools/completeSession';
import {
  LINK_WORK_ITEMS_TOOL_NAME,
  UNLINK_WORK_ITEMS_TOOL_NAME,
  registerLinkWorkItems,
} from './tools/linkWorkItems';
import { UPDATE_WORK_ITEM_TOOL_NAME, registerUpdateWorkItem } from './tools/updateWorkItem';
import {
  ARCHIVE_WORK_ITEM_TOOL_NAME,
  UNARCHIVE_WORK_ITEM_TOOL_NAME,
  registerArchiveWorkItem,
} from './tools/archiveWorkItem';
import { DELETE_WORK_ITEM_TOOL_NAME, registerDeleteWorkItem } from './tools/deleteWorkItem';

// The MCP tool registry (Story 7.8 · Subtask 7.8.4, extended by 7.8.5 / 7.8.6 /
// 7.8.10 / 7.8.11 / 7.8.13 / 7.8.14 / 2.8.5) — the single place that assembles
// the server's tool surface.
// This is the SEAM each later subtask extends: add the tool module under
// `tools/`, import its `register*`, and add one line to `registerMcpTools` —
// without touching the transport (`app/api/mcp/route.ts`) or the auth gate
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
  WHOAMI_TOOL_NAME,
  LIST_SPRINTS_TOOL_NAME,
  CREATE_SPRINT_TOOL_NAME,
  UPDATE_SPRINT_TOOL_NAME,
  DELETE_SPRINT_TOOL_NAME,
  MOVE_TO_SPRINT_TOOL_NAME,
  MOVE_TO_BACKLOG_TOOL_NAME,
  MOVE_TO_PARENT_TOOL_NAME,
  START_SPRINT_TOOL_NAME,
  COMPLETE_SPRINT_TOOL_NAME,
  MARK_INTEGRATED_TOOL_NAME,
  COMPLETE_SESSION_TOOL_NAME,
  LINK_WORK_ITEMS_TOOL_NAME,
  UNLINK_WORK_ITEMS_TOOL_NAME,
  UPDATE_WORK_ITEM_TOOL_NAME,
  ARCHIVE_WORK_ITEM_TOOL_NAME,
  UNARCHIVE_WORK_ITEM_TOOL_NAME,
  DELETE_WORK_ITEM_TOOL_NAME,
] as const;

/** One of the server's stable tool names — the union over {@link MCP_TOOL_NAMES}.
 * The token-scope map (`lib/mcp/scopes.ts`) is keyed by this, so the map stays
 * total over the registry by construction (a tool added without a scope is a
 * compile error). */
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * Register every MCP tool, wiring each to `resolveContext`.
 *
 * When `resolveScopes` is supplied (production passes `scopesFromExtra`), the
 * server is wrapped in the per-token SCOPE GATE (Subtask 7.7.17): every tool
 * call is rejected with a typed scope-denied error unless the token's granted
 * scopes include the tool's scope — an ADDITIONAL gate in front of the
 * unchanged 6.4 role checks. Omitting it (the tool round-trip tests) applies no
 * scope narrowing, preserving the pre-7.7.17 behaviour.
 */
export function registerMcpTools(
  server: McpServer,
  resolveContext: McpContextResolver,
  resolveScopes?: McpScopesResolver,
): void {
  const target = resolveScopes ? scopeGatedServer(server, resolveScopes) : server;
  // Read + dispatch tools (7.8.4).
  registerGetWorkItem(target, resolveContext);
  registerListReady(target, resolveContext);
  registerNextReady(target, resolveContext);
  // Write tools (7.8.5).
  registerCreateWorkItem(target, resolveContext);
  registerTransitionStatus(target, resolveContext);
  registerAddComment(target, resolveContext);
  // Query tool (7.8.6).
  registerSearchWorkItems(target, resolveContext);
  // Identity (added by 7.9.1, consumed by the CLI's auth commands).
  registerWhoami(target, resolveContext);
  // Sprint tools (7.8.10) — the Scrum cadence over the shipped Epic-4 services.
  registerListSprints(target, resolveContext);
  registerCreateSprint(target, resolveContext);
  registerUpdateSprint(target, resolveContext);
  registerDeleteSprint(target, resolveContext);
  registerMoveToSprint(target, resolveContext);
  registerMoveToBacklog(target, resolveContext);
  // Re-parent (bug MOTIR-1017) — the structural move create/update can't do:
  // move a work item under a new parent or promote it to a top-level root.
  registerMoveToParent(target, resolveContext);
  registerStartSprint(target, resolveContext);
  registerCompleteSprint(target, resolveContext);
  // Integration-state tools (7.8.11) — the 7.9 CLI session loop's write surface.
  registerMarkIntegrated(target, resolveContext);
  registerCompleteSession(target, resolveContext);
  // Link tools (7.8.13) — the dependency-edge primitive over the Epic-2 link service.
  registerLinkWorkItems(target, resolveContext);
  // Edit + soft-remove tools (7.8.14) — patch fields create can't set, and the
  // archive/restore pair over the shipped work-item services.
  registerUpdateWorkItem(target, resolveContext);
  registerArchiveWorkItem(target, resolveContext);
  // Permanent delete (2.8.5) — the irreversible subtree-cascade counterpart of
  // archive, over the shipped 2.8.2 deleteWorkItem service.
  registerDeleteWorkItem(target, resolveContext);
}

/**
 * Build a fully-registered {@link McpServer}. The transport creates one per
 * request (stateless streamable HTTP); tests build one and connect it to an
 * in-memory client. `resolveContext` supplies each tool's actor — production
 * passes `contextFromExtra` (reads the bearer-resolved `AuthInfo`); tests pass a
 * fixed-context resolver. `resolveScopes`, when given, enables the per-token
 * scope gate (Subtask 7.7.17) — production passes `scopesFromExtra`; a test
 * passes a fixed-scope resolver to exercise scope narrowing, and omits it to run
 * a tool unnarrowed.
 */
export function buildMcpServer(
  resolveContext: McpContextResolver,
  resolveScopes?: McpScopesResolver,
): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);
  registerMcpTools(server, resolveContext, resolveScopes);
  return server;
}
