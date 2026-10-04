import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import type { McpContextResolver, McpRequestExtra } from './context';

// EVERY MOTIR MCP CALL IS A HEARTBEAT (Story MOTIR-7446 · MOTIR-7451,
// `docs/decisions/agent-reported-runs.md` §5).
//
// An agent-reported run stays alive only while its agent is heard from, and an
// agent cannot be trusted to REMEMBER a heartbeat — a model forgets, a harness has
// no timer, and Codex, Kimi and the rest have no hook to lean on. What every agent
// that is working does do is call Motir: it reads its card, links its pull
// request, moves a status. So the server refreshes the caller's open
// agent-reported runs on every tool call it handles, and a working agent keeps its
// run alive in any harness without a line of instruction.
//
// ⚠️ IT NEVER FAILS THE CALL IT RIDES ON. It runs AFTER the tool has answered,
// and a failure here is logged and swallowed: a heartbeat is a liveness hint, and
// an agent must never lose a write it made because a timestamp could not be bumped.
//
// ⚠️ IT IS CHEAP, AND A READ ON THE ORDINARY CALL. One `SELECT` per call;
// only a caller with an open run last beaten over a minute ago is written to, so
// an agent's burst of reads writes once a minute and a caller with no agent run —
// almost every call — writes nothing. That is what keeps a `readOnlyHint` tool
// measured at zero writes (`tests/mcp/tool-hints-integration.test.ts`): the one
// write it can cause is a liveness stamp on the caller's own run, never data.
// A CLI run is not touched (`reportedBy: 'agent'`): the CLI beats from its own
// timer. A run token (an agent instance's credential) touches nothing.

/** A tool callback as the SDK invokes it (args validated, actor in `extra`). */
type McpToolCallback = (
  args: unknown,
  extra: McpRequestExtra,
) => CallToolResult | Promise<CallToolResult>;

/** Refresh the caller's open agent-reported runs, swallowing any failure. */
export async function heartbeatAfterCall(
  resolveContext: McpContextResolver,
  extra: McpRequestExtra,
): Promise<void> {
  try {
    await dispatchRunService.heartbeatCallerRuns(resolveContext(extra));
  } catch (err) {
    console.error('[mcp] run heartbeat failed; the call it rode on is unaffected', err);
  }
}

/**
 * Wrap `server` so every registered tool's callback is followed by
 * {@link heartbeatAfterCall}. Every other `McpServer` member passes through — the
 * same Proxy over the same seam as `rateLimitedServer`.
 */
export function heartbeatingServer(
  server: McpServer,
  resolveContext: McpContextResolver,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'registerTool' || typeof value !== 'function') return value;
      const register = value as (...registerArgs: unknown[]) => unknown;
      return (...registerArgs: unknown[]) => {
        const callback = registerArgs[registerArgs.length - 1] as McpToolCallback;
        const beating: McpToolCallback = async (args, extra) => {
          try {
            return await callback(args, extra);
          } finally {
            await heartbeatAfterCall(resolveContext, extra);
          }
        };
        return register.apply(target, [...registerArgs.slice(0, -1), beating]);
      };
    },
  });
}
