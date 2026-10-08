import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CodeGraphReadDTO, CodeGraphReadTool } from '@/lib/dto/codeGraphRead';
import { codeGraphReadService, type CodeGraphReadArgs } from '@/lib/services/codeGraphReadService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `code_explore` and `code_search` (Story MOTIR-7858 · Subtask MOTIR-7862) — the
// hosted code graph, for an agent planning over the MCP. Each is a thin adapter
// over `codeGraphReadService.read`, which runs the hosted planner's OWN executor
// in motir-ai: an `ok` answer's text is those bytes, verbatim — the *page k of N*
// line, the cursor and the pending footer included — so this agent reads what the
// hosted planner reads for the same query, repository set and graph commit.
//
// Every other answer is a NAMED state with one sentence saying what to do next.
// Only the door's refusals (no `ai:plan`; project not found) are errors.

export const CODE_EXPLORE_TOOL_NAME = 'code_explore';
export const CODE_SEARCH_TOOL_NAME = 'code_search';

const queryField = z
  .string()
  .min(1)
  .describe('What to look for: a symbol, a concept, or a few words naming the code you want.');
const repoField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'OPTIONAL. Limit the read to ONE repository in the project’s set — its bare name ("motir-core") ' +
      'or `owner/name`, case-insensitively. Omit to read every indexed repository in the set.',
  );
const cursorField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'OPTIONAL. Fetch the NEXT PAGE of an earlier result: pass the `cursor` printed on that ' +
      'result’s page line, exactly as printed, with the same other arguments. Omit for page 1.',
  );

const exploreSchema = {
  projectKey: projectKeyField,
  query: queryField,
  repo: repoField,
  cursor: cursorField,
};
const searchSchema = {
  ...exploreSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('OPTIONAL. The page size — how many symbols to return per page.'),
};

/** The one-line summary for a non-`ok` state: the state, then what to do next. */
export function summarizeCodeGraphRead(dto: CodeGraphReadDTO): string {
  switch (dto.state) {
    case 'ok':
      return dto.text;
    case 'no_repositories':
      return 'This project has no repository in its set, so there is no code graph to read. Plan without code facts, and do not assert any.';
    case 'repo_not_in_set':
      return `The repo "${dto.repo}" is not in this project's set — only ${dto.available.map((r) => `"${r}"`).join(', ')} can be read. No read was made.`;
    case 'not_indexed': {
      const facts = [
        dto.indexState,
        dto.commitsBehind !== null ? `${dto.commitsBehind} commits behind` : null,
        dto.refreshFailing ? 'refresh failing' : null,
        dto.graphTooLarge ? 'graph over the size cap' : null,
      ].filter((f): f is string => Boolean(f));
      return `${dto.repoRef} is not indexed yet${facts.length ? ` (${facts.join(', ')})` : ''} — read its files with \`read_file\` instead.`;
    }
    case 'no_graph':
      return 'No code graph exists for this project yet. Read files with `read_file` instead, and do not conclude the code is absent.';
    case 'stale_cursor':
      return 'The cursor is stale: the code changed since that page. Re-run the query without `cursor` to start from page 1.';
    case 'invalid_cursor':
      return 'That cursor was not issued for this read. Re-run the query without `cursor`, or pass a cursor exactly as a page line printed it.';
    case 'graph_unavailable':
      return `The code graph could not be read right now (${dto.reason}). This is a failure to ASK, not an answer — retry later, or read files with \`read_file\`.`;
  }
}

async function run(
  tool: CodeGraphReadTool,
  args: { projectKey: string } & CodeGraphReadArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const dto = await codeGraphReadService.read(
      tool,
      args.projectKey.trim().toUpperCase(),
      {
        query: args.query,
        ...(args.repo !== undefined ? { repo: args.repo } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      },
      ctx,
    );
    return toolOk(summarizeCodeGraphRead(dto), exempt(tool, { ...dto }));
  } catch (err) {
    return toToolError(err);
  }
}

export const runCodeExplore = (
  args: { projectKey: string } & CodeGraphReadArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> => run('code_explore', args, ctx);
export const runCodeSearch = (
  args: { projectKey: string } & CodeGraphReadArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> => run('code_search', args, ctx);

const STATES =
  'Every answer carries a `state`: `ok` (the text), `no_repositories`, `repo_not_in_set` (with ' +
  '`available`), `not_indexed` (with the repo’s index state and commits behind), `no_graph`, ' +
  '`stale_cursor`, `invalid_cursor`, or `graph_unavailable` (with a `reason`) — none of them an ' +
  'error, and none means the project has no code.';

export function registerCodeGraphRead(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    CODE_EXPLORE_TOOL_NAME,
    {
      title: 'Explore the code graph',
      description:
        "Explore a project's hosted code graph around a query: the matching symbols with their " +
        'files and lines, and how they connect (calls, imports). It is the hosted planner’s own ' +
        '`code_explore` (motir-ai), so the answer is the same text that planner reads for the same ' +
        'query, repository set and graph commit. Results PAGE: a result with more than one page ' +
        'prints `page k of N` and a `cursor` to pass back for the next. ' +
        STATES +
        ' Read-only; gated on the planning permission. The project key resolves inside the ' +
        'token’s own workspace.',
      inputSchema: exploreSchema,
    },
    async (args, extra) => {
      try {
        return await runCodeExplore(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
  server.registerTool(
    CODE_SEARCH_TOOL_NAME,
    {
      title: 'Search the code graph',
      description:
        "Search a project's hosted code graph for symbols by name: each match with its kind, file " +
        'and line, and a qualified id. It is the hosted planner’s own `code_search` (motir-ai), so ' +
        'the answer is the text that planner reads. `limit` sets the page size; a result with more ' +
        'than one page prints `page k of N` and a `cursor` to pass back for the next. ' +
        STATES +
        ' Read-only; gated on the planning permission. The project key resolves inside the ' +
        'token’s own workspace.',
      inputSchema: searchSchema,
    },
    async (args, extra) => {
      try {
        return await runCodeSearch(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
