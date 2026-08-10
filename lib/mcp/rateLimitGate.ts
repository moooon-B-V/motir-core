import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';
import { RATE_LIMITED_CODE } from '@/lib/rateLimit/guard';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver, McpRequestExtra } from './context';
import type { McpToolName } from './registry';
import { toolError } from './toolResult';

// The BILLABLE-TOOL gate at the MCP dispatch seam (MOTIR-2610) — the money half
// of the MCP surface's limiting. The volume half is the transport guard
// (`lib/rateLimit/mcpGuard.ts`); read that file's header for why the surface is
// metered in two places at all.
//
// ── What this gate exists to stop ───────────────────────────────────────────
// MOTIR-2597 gave the job-submitting `/api/ai/*` routes their own `ai:generate`
// ceiling because a generation costs many chat turns. `expand_item` reaches
// `aiPlanEditsService.submitExpand` — the SAME service call `POST /api/ai/expand`
// makes — so before this gate the browser door to an expansion was capped and
// the agent door to the identical job was not. A ceiling with a second, looser
// entrance is not a ceiling.
//
// ── It spends the SAME bucket, through the SAME guard ───────────────────────
// It calls `enforceAiRateLimit(ctx, 'ai:generate')` — the browser route's own
// function, not a copy — and the MCP actor resolves to the `{ userId,
// workspaceId }` that guard already keys on. So the two doors share ONE counter
// per user+workspace by construction: an agent that has spent the allowance
// cannot then spend it again from a browser tab, and neither can be widened
// without widening the other. No new store, no new limiter, no second budget.
//
// ── AFTER the scope gate, deliberately ──────────────────────────────────────
// `registerMcpTools` composes this OUTSIDE `scopeGatedServer`, which — because
// each wrapper registers the callback the NEXT one wraps — makes the scope check
// run FIRST at dispatch. That ordering is the point: a token that may not call
// `expand_item` must not be able to drain its owner's generation budget by
// calling it anyway. The refusal is not free, though — the transport guard has
// already spent an `mcp:call` on the request, which is the same "a refusal still
// costs something" rule `/api/v1` applies to its 403s.

/**
 * The tools that SUBMIT a model job, and therefore spend real provider tokens.
 *
 * ⚠️ This list is the whole finding, so it was ENUMERATED rather than assumed
 * (`notes.html` #194 — "write the list of every path that can incur the thing
 * being capped, not the paths you built"). Both entries reach `submitJob`:
 *
 *   - `expand_item` → `aiPlanEditsService.submitExpand`
 *   - `submit_plan_session` → `planChangeSessionsService.submit` →
 *     `aiPlanEditsService.submitAugment` / `submitContextual`
 *
 * The card named only the first; the second is the same defect one hop further
 * out, and its browser twin (`POST /api/ai/plan-change/session/submit`) is in
 * MOTIR-2597's LIMITED set for exactly this reason.
 *
 * Everything else on the surface is a database read or write. `get_plan_status`
 * and `get_plan` READ a job's outcome — work already paid for, where a ceiling
 * would only refuse a caller the answer they have been charged for, the same
 * call the `/api/ai/**` `/stream` and `jobs/[jobId]` routes are unlimited on.
 *
 * `tests/rateLimit/surfaceGuards.test.ts` re-derives the membership from the
 * FILESYSTEM and asserts it tight in both directions, so a future tool that
 * submits a job — or one of these that stops — fails the build rather than
 * quietly reopening the hole.
 */
export const MCP_BILLABLE_TOOLS: readonly McpToolName[] = ['expand_item', 'submit_plan_session'];

/** True when calling `toolName` causes motir-ai to run a model job. */
export function isBillableTool(toolName: string): boolean {
  return (MCP_BILLABLE_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Decide whether `ctx` may call `toolName` right now. Returns the rate-limited
 * tool result to short-circuit with, or `null` to proceed.
 *
 * Exported and PURE-ish (its only effect is spending the budget) so the tests
 * exercise the same decision the wired gate makes, rather than a re-statement of
 * it — the shape `scopeDenial` established.
 *
 * The refusal is an `isError` {@link CallToolResult}, NOT an HTTP 429: by the
 * time a tool callback runs, the JSON-RPC response is already committed to
 * status 200, and a tool-level error is the MCP-legal way to say no — every
 * client parses it, and it carries the retry seconds in the message the agent
 * reads. (The transport's own refusal is the 429; `lib/rateLimit/mcpGuard.ts`.)
 */
export async function billableToolDenial(
  toolName: string,
  ctx: ServiceContext,
): Promise<CallToolResult | null> {
  if (!isBillableTool(toolName)) return null;
  const refusal = await enforceAiRateLimit(ctx, 'ai:generate');
  if (!refusal) return null;
  const retryAfter = refusal.headers.get('Retry-After');
  return toolError(
    RATE_LIMITED_CODE,
    `Too many AI generation requests. "${toolName}" submits a model job and draws the same ` +
      `generation budget as Motir's own expand/plan buttons. Retry in ${retryAfter} seconds.`,
  );
}

/** A tool callback as the SDK invokes it (args validated, actor in `extra`). */
type McpToolCallback = (
  args: unknown,
  extra: McpRequestExtra,
) => CallToolResult | Promise<CallToolResult>;

/**
 * Wrap `server` so every `registerTool` call is metered by
 * {@link billableToolDenial}: a job-submitting tool spends `ai:generate` before
 * its runner (and thus before the provider is called) and is refused with a
 * typed tool error when the caller is over budget. Refusing BEFORE the submit is
 * the whole point — a 429 after the job has been accepted has already spent the
 * money it exists to protect.
 *
 * Every other `McpServer` member passes through untouched, and a non-billable
 * tool costs one `includes` — mirroring `scopeGatedServer`, which is the same
 * Proxy over the same seam. A server built WITHOUT this wrapper meters nothing
 * (the in-process tool tests, which have no request behind them).
 */
export function rateLimitedServer(
  server: McpServer,
  resolveContext: McpContextResolver,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'registerTool' || typeof value !== 'function') return value;
      const register = value as (...registerArgs: unknown[]) => unknown;
      return (...registerArgs: unknown[]) => {
        const toolName = registerArgs[0] as string;
        const callback = registerArgs[registerArgs.length - 1] as McpToolCallback;
        // Only the billable tools are wrapped at all, so the non-billable 37
        // keep the exact callback identity they registered with.
        if (!isBillableTool(toolName)) return register.apply(target, registerArgs);
        const metered: McpToolCallback = async (args, extra) => {
          const refused = await billableToolDenial(toolName, resolveContext(extra));
          if (refused) return refused;
          return callback(args, extra);
        };
        return register.apply(target, [...registerArgs.slice(0, -1), metered]);
      };
    },
  });
}
