import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolName } from './registry';
import { TOOL_SCOPES, type TokenScope } from './scopes';
import type { McpRequestExtra, McpScopesResolver } from './context';
import { toolError } from './toolResult';

// The per-token SCOPE GATE at the MCP dispatch seam (Story 7.7 · Subtask
// 7.7.17). Every tool call is gated by the granted scopes the bearer token
// resolved with: if the tool's scope (`toolScope(name)` from `lib/mcp/scopes.ts`)
// is not in the token's granted set, the call returns a typed scope-denied tool
// error BEFORE the tool's runner (and thus before any service call) runs.
//
// ── Scope NARROWS; it does NOT replace the role check. ─────────────────────
// The existing 6.4 workspace/project access checks still run inside every
// service (the 404-not-403 cross-tenant contract is unchanged). Scope is an
// ADDITIONAL gate layered in FRONT: a call must pass BOTH (granted scope ∩
// role). A token whose owner is an admin but whose `work_items:delete` scope is
// off still cannot delete; a token holding the delete scope still cannot delete
// in a workspace its owner can't reach.
//
// ── One seam, all tools. ───────────────────────────────────────────────────
// The gate wraps the `server.registerTool` CALLBACK uniformly (a Proxy over the
// McpServer), so it covers all tools without each tool re-checking — and returns
// a clean `toolError` regardless of whether a given tool's handler funnels its
// own throws through `toToolError`. Because the decision keys off `TOOL_SCOPES`
// (typed `Record<McpToolName, TokenScope>`), it inherits 7.7.16's totality
// guard: a future tool added to the registry without a scope is a COMPILE error
// in `scopes.ts`, and {@link scopeDenial} fails CLOSED at runtime if a name ever
// resolves to no scope — a tool with no scope can't be dispatched.

/** The stable code carried by the scope-denied tool error (the 403 analogue). */
export const SCOPE_NOT_GRANTED_CODE = 'SCOPE_NOT_GRANTED' as const;

/** A tool callback as the SDK invokes it (args validated, actor in `extra`). */
type McpToolCallback = (
  args: unknown,
  extra: McpRequestExtra,
) => CallToolResult | Promise<CallToolResult>;

/**
 * Decide whether `granted` may call `toolName`. Returns the scope-denied tool
 * result to short-circuit with, or `null` to proceed. PURE — the registry-loop
 * test exercises this exact function over `MCP_TOOL_NAMES`, so the wired gate
 * and the test share one decision. Fails CLOSED on an unmapped tool.
 */
export function scopeDenial(
  toolName: string,
  granted: readonly TokenScope[],
): CallToolResult | null {
  const required = TOOL_SCOPES[toolName as McpToolName] as TokenScope | undefined;
  if (!required) {
    return toolError(
      SCOPE_NOT_GRANTED_CODE,
      `Tool "${toolName}" has no registered scope and cannot be dispatched.`,
    );
  }
  if (!granted.includes(required)) {
    return toolError(
      SCOPE_NOT_GRANTED_CODE,
      `This API token is not granted the "${required}" scope required to call "${toolName}".`,
    );
  }
  return null;
}

/**
 * Wrap `server` so every `registerTool` call is gated by `resolveScopes`: the
 * gate runs at the dispatch seam, BEFORE the tool's runner, and returns the
 * typed scope-denied result when the token lacks the tool's scope. Every other
 * `McpServer` member passes through untouched. Production passes
 * `scopesFromExtra`; a server built without a scope resolver isn't wrapped at
 * all (no narrowing).
 */
export function scopeGatedServer(server: McpServer, resolveScopes: McpScopesResolver): McpServer {
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
          const denied = scopeDenial(toolName, resolveScopes(extra));
          if (denied) return denied;
          return callback(args, extra);
        };
        return register.apply(target, [...registerArgs.slice(0, -1), gated]);
      };
    },
  });
}
