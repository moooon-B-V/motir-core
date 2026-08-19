import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SemanticSearchResponse } from '@/lib/dto/ai';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { projectsService } from '@/lib/services/projectsService';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';
import { RATE_LIMITED_CODE } from '@/lib/rateLimit/guard';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `search_work_items_semantic` (Story MOTIR-3098 · Subtask MOTIR-3101) — the
// HAS-THIS-SHIPPED gate an agent can actually answer.
//
// `search_work_items` is a `contains` SUBSTRING predicate, and that is a KNOWN
// failure with a receipt in this project: MOTIR-3079 records a story written to
// build a capability that had shipped six days earlier under a name the search
// never used. The vector store, the ranking query and the tenancy policy all
// shipped with MOTIR-2694; this is the surface over them.
//
// ── The shape follows the DECISION, not this file ──────────────────────────
// `docs/decisions/plan-tree-embeddings.md` **Amendment 2** decided Option B: the
// tool takes TEXT and `motir-core` embeds it through the `POST /v1/embeddings`
// seam §6.2 already mandates for the write path. So there is deliberately NO
// `model` argument and no `queryEmbedding` argument. Both were on the table
// (Option A) and were rejected: `model` is a HARD ranking filter, so a caller
// that guessed it wrong would receive an empty result indistinguishable from
// "nothing similar exists" — which is the MOTIR-3079 failure, shipped as a
// feature. Embedding the row and the query through one seam makes that
// mismatch impossible rather than merely unlikely.
//
// ── It sits BESIDE `search_work_items`, not over it ────────────────────────
// Two tools, exactly as `motir-ai` has two. The substring search is not
// deprecated, its behaviour is unchanged, and the two answer different
// questions: one finds a STRING, this one finds a MEANING.
//
// ── The §2 invariant binds here ────────────────────────────────────────────
// `key`, `title`, `score` — and nothing else. No `descriptionMd`, no
// `explanationMd`, no comment, no acceptance criterion. This tool NAMES
// candidates; the agent then reads each one through `get_work_item` against the
// real record. Returning prose would make it a retrieval channel, which the ADR
// forbids in §2 and this surface does not get to relax.
//
// ── The spend, and what bounds it ──────────────────────────────────────────
// A semantic search costs a provider call in a way `search_work_items` does not,
// so Amendment 2 pins the bound: the existing `ai:chat` allowance, keyed on
// user + workspace, sharing ONE counter with the browser's planning chat. It is
// applied HERE rather than by `rateLimitGate`'s billable-tool wrapper, because
// that list is derived from calls reaching `submitJob` and this reaches none —
// see the amendment for why the two mechanisms bound two different costs.
// It runs AFTER the project resolves, so a caller who cannot browse the project
// never spends the owner's budget on a refusal.

export const SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME = 'search_work_items_semantic';

/** ADR §6.1's page bound, unchanged: 1–50, default 10. */
export const SEMANTIC_LIMIT_DEFAULT = 10;
export const SEMANTIC_LIMIT_MIN = 1;
export const SEMANTIC_LIMIT_MAX = 50;

const inputSchema = {
  projectKey: projectKeyField,
  query: z
    .string()
    .min(1)
    .describe(
      'What you are looking for, in your own words — a phrase or a sentence, NOT a keyword. ' +
        'Motir embeds it for you: there is no model to pick and no vector to supply. ' +
        'Describe the CAPABILITY ("cards remember which columns are collapsed"), not a term you ' +
        'hope somebody used.',
    ),
  limit: z
    .number()
    .int()
    .min(SEMANTIC_LIMIT_MIN)
    .max(SEMANTIC_LIMIT_MAX)
    .optional()
    .describe(`Candidates to return; 1–${SEMANTIC_LIMIT_MAX}, default ${SEMANTIC_LIMIT_DEFAULT}.`),
  minScore: z
    .number()
    .min(-1)
    .max(1)
    .optional()
    .describe(
      'Optional cosine-similarity floor in [-1, 1]. NO default, deliberately (ADR Amendment 1): ' +
        'a spurious candidate costs one keyed read, a suppressed one costs a duplicate branch of ' +
        'the plan. Filter here only when you know what you asked.',
    ),
};

/** Compact human summary — the state, then the candidates. */
export function summarizeSemanticSearch(result: SemanticSearchResponse): string {
  if (result.results.length === 0) return result.message;
  const rows = result.results.map((r) => `${r.key} · ${r.score.toFixed(4)} · ${r.title}`);
  return [result.message, ...rows].join('\n');
}

/** The adapter: resolve the project, spend the AI allowance, then search. */
export async function runSearchWorkItemsSemantic(
  args: { projectKey: string; query: string; limit?: number; minScore?: number },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);

    // The money gate, AFTER the browse gate the line above applies and BEFORE
    // the embed. A refusal is a tool error rather than a 429: by the time a tool
    // callback runs the JSON-RPC response is already committed to 200, and a
    // tool-level error is the MCP-legal way to say no (the shape
    // `billableToolDenial` established).
    const refusal = await enforceAiRateLimit(ctx, 'ai:chat');
    if (refusal) {
      const retryAfter = refusal.headers.get('Retry-After');
      return toolError(
        RATE_LIMITED_CODE,
        `Too many AI requests. "${SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME}" embeds your query ` +
          "through Motir's AI backend and draws the same allowance as the planning chat. " +
          `Retry in ${retryAfter} seconds, or use \`search_work_items\` (substring) meanwhile.`,
      );
    }

    const result = await aiBoundaryService.searchSimilarWorkItemsByText(
      project.id,
      {
        query: args.query,
        limit: args.limit ?? SEMANTIC_LIMIT_DEFAULT,
        ...(args.minScore !== undefined ? { minScore: args.minScore } : {}),
      },
      ctx,
    );
    return toolOk(
      summarizeSemanticSearch(result),
      exempt(SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME, { ...result }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerSearchWorkItemsSemantic(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME,
    {
      title: 'Search work items by meaning',
      description:
        'HAS THIS ALREADY BEEN BUILT? Search a project by MEANING rather than by substring — ' +
        'ask in your own words and Motir embeds the query for you (no model to pick, no vector ' +
        'to supply). Use it BEFORE proposing anything: `search_work_items` matches ' +
        'substrings, so a query for "persist UI preferences" cannot see a card titled "Board ' +
        'columns remember their collapsed state", and a capability rebuilt because of that is ' +
        'the most expensive planning mistake there is. It sits BESIDE `search_work_items`, ' +
        'which is unchanged — one finds a string, this finds a meaning. Returns `key`, `title` ' +
        'and `score` ONLY: it NAMES candidates, so read each one through `get_work_item` ' +
        'before concluding anything about it. ⚠️ An empty result is not one thing — read ' +
        '`outcome`: `nothing-similar` means the project is indexed and nothing is close (an ' +
        'answer), while `not-indexed` and `unavailable` mean the search could not tell you ' +
        'anything and are NOT evidence that nothing exists. ⚠️ COSTS AN AI CALL: it embeds ' +
        "your query through Motir's AI backend and draws the same per-minute allowance as the " +
        'planning chat, so do not call it in a tight loop. Honors the same access checks as ' +
        "the UI; the project key resolves inside the token's own workspace.",
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runSearchWorkItemsSemantic(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
