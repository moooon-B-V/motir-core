import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as Sentry from '@sentry/nextjs';
import { sentryIsInitialised } from '@/lib/monitoring/transactionSpan';
import type { McpRequestExtra } from './context';

// EVERY MCP `tools/call` IS A SPAN NAMED FOR ITS TOOL (MOTIR-8551).
//
// To a tracer every MCP request is the same `POST /api/mcp`: one route, ninety-six
// tools, from a cheap read to a write that moves a subtree. On 2026-10-13 a burst
// of 189 calls made readers fail (MOTIR-8259) and nothing could say which tool held
// the connections. This wrapper names the call's span — and the request's root —
// after the tool, so `move_to_parent` is a filter in Sentry's trace search, with
// whatever the call did (its transactions, MOTIR-8550) nested beneath it.
//
// ⚠️ IT IS A `registerTool` PROXY, THE SAME SEAM AS `heartbeatingServer`, because the
// registry's wrapper chain is the one place that knows the tool name with
// certainty. Parsing the JSON-RPC body in the route would duplicate the SDK's
// dispatch and miss batching. `registerMcpTools` places it INNERMOST so that it is
// OUTERMOST at call time: the span covers the scope gate, the rate-limit gate, the
// body and the run heartbeat.
//
// ⚠️ NOTHING FROM THE CALL IS RECORDED BUT ITS NAME AND ITS OUTCOME. No argument,
// no result content, no project key, no actor — `sendDefaultPii: false` holds here
// as everywhere. The attribute names match Sentry's own MCP integration
// (`mcp.method.name`, `mcp.tool.name`, `mcp.tool.result.is_error`), so a saved
// search works whichever drew the span.
//
// With no DSN (`Sentry.init` never ran) the call runs bare — no span, no rename,
// no tag — and only `currentMcpToolName()` is set. The wrapper adds no init and
// no transport.

/** A tool callback as the SDK invokes it (args validated, actor in `extra`). */
type McpToolCallback = (
  args: unknown,
  extra: McpRequestExtra,
) => CallToolResult | Promise<CallToolResult>;

/** How a traced tool call ended. */
export type McpToolOutcome = 'ok' | 'tool_error' | 'thrown';

export const MCP_TOOL_SPAN = {
  op: 'mcp.server',
  method: 'tools/call',
  /** The root span's name when one request carries more than one tool call. */
  batchRootName: 'MCP tools/call (batch)',
} as const;

export const MCP_TOOL_ATTR = {
  method: 'mcp.method.name',
  tool: 'mcp.tool.name',
  outcome: 'mcp.tool.outcome',
  isError: 'mcp.tool.result.is_error',
} as const;

/** The scope tag a trace is searched by: `mcp.tool:<tool>`. */
export const MCP_TOOL_TAG = 'mcp.tool';

export function mcpToolSpanName(tool: string): string {
  return `${MCP_TOOL_SPAN.method} ${tool}`;
}

export function mcpToolRootName(tool: string): string {
  return `MCP ${MCP_TOOL_SPAN.method} ${tool}`;
}

const currentTool = new AsyncLocalStorage<string>();

/**
 * The name of the MCP tool whose call this code is running inside, or null
 * outside any call — so the every-request recorder (MOTIR-8553) can attribute its
 * numbers to a tool without parsing the request.
 */
export function currentMcpToolName(): string | null {
  return currentTool.getStore() ?? null;
}

/** How many tool calls each request's root span has carried — the batch case. */
const callsPerRoot = new WeakMap<object, number>();

function nameTheRoot(tool: string): void {
  const active = Sentry.getActiveSpan();
  if (!active) return;
  const root = Sentry.getRootSpan(active);
  const calls = (callsPerRoot.get(root) ?? 0) + 1;
  callsPerRoot.set(root, calls);
  Sentry.updateSpanName(root, calls > 1 ? MCP_TOOL_SPAN.batchRootName : mcpToolRootName(tool));
}

/** Run one tool call inside its named span. */
export async function traceMcpToolCall(
  tool: string,
  call: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  if (!sentryIsInitialised()) return currentTool.run(tool, call);
  // Named BEFORE the tool span opens: with no request span, the tool span is the
  // root, and it already carries the tool's name.
  nameTheRoot(tool);
  Sentry.setTag(MCP_TOOL_TAG, tool);
  return Sentry.startSpan(
    {
      name: mcpToolSpanName(tool),
      op: MCP_TOOL_SPAN.op,
      attributes: { [MCP_TOOL_ATTR.method]: MCP_TOOL_SPAN.method, [MCP_TOOL_ATTR.tool]: tool },
    },
    async (span) => {
      let result: CallToolResult;
      try {
        result = await currentTool.run(tool, call);
      } catch (err) {
        recordOutcome(span, 'thrown');
        throw err;
      }
      recordOutcome(span, result.isError === true ? 'tool_error' : 'ok');
      return result;
    },
  );
}

function recordOutcome(span: Sentry.Span, outcome: McpToolOutcome): void {
  span.setAttributes({
    [MCP_TOOL_ATTR.outcome]: outcome,
    [MCP_TOOL_ATTR.isError]: outcome !== 'ok',
  });
  if (outcome !== 'ok') span.setStatus({ code: 2, message: outcome });
}

/**
 * Wrap `server` so every registered tool's callback runs inside
 * {@link traceMcpToolCall}. Every other `McpServer` member passes through.
 */
export function tracedServer(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'registerTool' || typeof value !== 'function') return value;
      const register = value as (...registerArgs: unknown[]) => unknown;
      return (...registerArgs: unknown[]) => {
        const tool = String(registerArgs[0]);
        const callback = registerArgs[registerArgs.length - 1] as McpToolCallback;
        const traced: McpToolCallback = (args, extra) =>
          traceMcpToolCall(tool, () => callback(args, extra));
        return register.apply(target, [...registerArgs.slice(0, -1), traced]);
      };
    },
  });
}
