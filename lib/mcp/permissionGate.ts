import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolName } from './registry';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { grantAllows, type TokenGrant } from '@/lib/tokens/grant';
import { TOOL_PERMISSIONS } from './toolPermissions';
import type { McpRequestExtra, McpGrantResolver } from './context';
import { toolError } from './toolResult';

// The per-token PERMISSION GATE at the MCP dispatch seam (Story 7.7 · Subtask
// 7.7.17, re-pointed onto the permission vocabulary by MOTIR-2576). Every tool
// call is gated by the GRANT the bearer token resolved with: if the permission
// the tool's own service asserts (`TOOL_PERMISSIONS`) is not in the token's
// grant, the call returns a typed permission-denied tool error BEFORE the
// tool's runner (and thus before any service call) runs.
//
// ── The grant NARROWS; it does NOT replace the role check. ─────────────────
// The existing 6.4 workspace/project access checks still run inside every
// service (the 404-not-403 cross-tenant contract is unchanged). The grant is an
// ADDITIONAL gate layered in FRONT: a call must pass BOTH (grant ∩ role). A
// token whose owner is an admin but whose `work_item:delete` is not granted
// still cannot delete; a token holding it still cannot delete in a workspace
// its owner can't reach. The two vocabularies are now the SAME vocabulary —
// which is what makes the composition legible rather than merely true.
//
// ── One seam, all tools. ───────────────────────────────────────────────────
// The gate wraps the `server.registerTool` CALLBACK uniformly (a Proxy over the
// McpServer), so it covers all tools without each tool re-checking — and returns
// a clean `toolError` regardless of whether a given tool's handler funnels its
// own throws through `toToolError`. Because the decision keys off
// `TOOL_PERMISSIONS` (typed `Record<McpToolName, PermissionKey>`), it inherits
// the totality guard: a future tool added to the registry without a permission
// is a COMPILE error in `toolPermissions.ts`, and {@link permissionDenial} fails
// CLOSED at runtime if a name ever resolves to no permission — a tool nothing
// governs cannot be dispatched.

/**
 * The stable code carried by the permission-denied tool error (the 403
 * analogue).
 *
 * It REPLACES `SCOPE_NOT_GRANTED` rather than keeping it as a compatibility
 * surface (`docs/decisions/token-permissions.md` §9): this is a tool-error code
 * an agent's operator READS, and its whole job is to be readable. A code naming
 * a vocabulary the product no longer has would preserve exactly the confusion
 * this story removes.
 */
export const PERMISSION_NOT_GRANTED_CODE = 'PERMISSION_NOT_GRANTED' as const;

/** A tool callback as the SDK invokes it (args validated, actor in `extra`). */
type McpToolCallback = (
  args: unknown,
  extra: McpRequestExtra,
) => CallToolResult | Promise<CallToolResult>;

/**
 * Decide whether `grant` may call `toolName`. Returns the permission-denied tool
 * result to short-circuit with, or `null` to proceed. PURE — the registry-loop
 * test exercises this exact function over `MCP_TOOL_NAMES`, so the wired gate
 * and the test share one decision. Fails CLOSED on an unmapped tool.
 *
 * The denial NAMES THE MISSING KEY, in the same `resource:action` form the
 * token screen shows, so an agent's error text tells its operator which switch
 * to turn on rather than which vocabulary to go and learn.
 */
export function permissionDenial(toolName: string, grant: TokenGrant): CallToolResult | null {
  const required = TOOL_PERMISSIONS[toolName as McpToolName] as PermissionKey | undefined;
  if (!required) {
    return toolError(
      PERMISSION_NOT_GRANTED_CODE,
      `Tool "${toolName}" has no registered permission and cannot be dispatched.`,
    );
  }
  if (!grantAllows(grant, required)) {
    return toolError(
      PERMISSION_NOT_GRANTED_CODE,
      `This API token is not granted the "${required}" permission required to call "${toolName}".`,
    );
  }
  return null;
}

/**
 * Wrap `server` so every `registerTool` call is gated by `resolveGrant`: the
 * gate runs at the dispatch seam, BEFORE the tool's runner, and returns the
 * typed permission-denied result when the token's grant lacks the tool's
 * permission. Every other `McpServer` member passes through untouched.
 * Production passes `grantFromExtra`; a server built without a grant resolver
 * isn't wrapped at all (no narrowing).
 */
export function permissionGatedServer(
  server: McpServer,
  resolveGrant: McpGrantResolver,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'registerTool' || typeof value !== 'function') return value;
      const register = value as (...registerArgs: unknown[]) => unknown;
      // `registerTool(name, config, callback)` — gate the callback (the last
      // argument), keyed by the tool name (the first).
      return (...registerArgs: unknown[]) => {
        const toolName = registerArgs[0] as string;
        const callback = registerArgs[registerArgs.length - 1] as McpToolCallback;
        const gated: McpToolCallback = async (args, extra) => {
          const denied = permissionDenial(toolName, resolveGrant(extra));
          if (denied) return denied;
          return callback(args, extra);
        };
        return register.apply(target, [...registerArgs.slice(0, -1), gated]);
      };
    },
  });
}
