import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { commentsService } from '@/lib/services/commentsService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectedSearchDelta } from '@/lib/services/planProjectionService';
import type { ProjectedRowDto } from '@/lib/services/planProjectionService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDependencyEdgesDto, WorkItemListItemDto } from '@/lib/dto/workItems';
import {
  decodeFilterEnvelope,
  FILTER_PARAM_VERSION,
  FILTER_ROW_CAP,
  type FilterConditionValue,
  type FilterEnvelope,
  type FilterOperatorId,
} from '@/lib/filters/ast';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import type { McpContextResolver } from '../context';
import { toFilterDecodeToolError, toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { presentMcpWorkItemRow, searchWorkItemsPayload } from '../payloads/workItems';
import { decodeSearchCursor, encodeSearchCursor } from '../searchCursor';
import { edgeMarker, EDGE_BLOCK_DESCRIPTION } from '../dependencyEdges';
import { commentCountMarker, COMMENT_COUNT_DESCRIPTION } from '../commentCounts';
import { planIdField } from './planRef';

// `search_work_items` (Story 7.8 · Subtask 7.8.6) — the agent's arbitrary
// query tool, deliberately SECOND to the dispatch tools (7.8.4): the planner
// loop never needs it, but a real agent surface does (the Atlassian MCP ships
// JQL search first-class; Motir's structured equivalent is the 6.1 FilterAST).
//
// ONE codec, N carriers (the 6.1.1 contract): the URL `?filter=v1:…` param, the
// 6.2 saved-filter envelope, and now this tool ALL ride the same versioned
// FilterAST — never a parallel query grammar. The tool's input is the AST in
// its self-documenting expanded form (`{ version, combinator, conditions }`),
// so an agent reading `tools/list` learns the exact grammar — but it maps 1:1
// to the stored envelope `{ v, c, f }` and is decoded by the SAME
// `decodeFilterEnvelope` the saved-filter carrier uses. The decoded AST then
// rides `workItemsService.getProjectIssuesList` — the EXACT read the `/items`
// List view calls — so the agent and the page can never disagree on a result
// set, and the registry's safe (parameterized-only) compiler is the single
// place an AST becomes SQL (injection probes bind as parameters → match
// nothing, never escape).
//
// `planId` (MOTIR-3096) answers over the PROJECTION — the project's live tree ⊕
// that plan's proposals — so an agent can search the tree INCLUDING what it has
// already proposed, instead of merging `get_plan` against this call by hand
// every turn.
//
// ⚠️ THE FILTER DOES NOT REACH PROPOSALS, and that is the decision rather than a
// gap. The FilterAST compiles to parameterized SQL over `work_item` rows through
// the ONE registry that makes it injection-safe; a proposal is not such a row, so
// the choices were to reimplement the whole grammar in memory (a second
// compiler, guaranteed to drift from the one the /items page uses) or to say
// plainly what the filter covers. MOTIR-3096 says it: `items` is the FILTERED
// committed page, `proposals` is the plan's WHOLE `add` set, `filterAppliesTo`
// names which is which, and that answer is the same every time rather than an
// accident of which fields a given proposal happens to carry.
//
// Pagination wraps that read's 1-based LIMIT/OFFSET page in an opaque cursor
// (`searchCursor.ts`) so the surface matches the sibling read tools: paginated
// from day one, no load-everything path. The page size is the List's own
// server cap (`getProjectIssuesList` clamps to ISSUE_LIST_PAGE_SIZE = 50).

export const SEARCH_WORK_ITEMS_TOOL_NAME = 'search_work_items';

/**
 * Every FilterAST operator id (the closed grammar the registry validates
 * against — `FilterOperatorId` in lib/filters/ast.ts). Listed explicitly so
 * `tools/list` teaches an agent the operator vocabulary; the totality guard
 * below makes a future operator a COMPILE error here, never a silent gap.
 */
const FILTER_OPERATOR_IDS = [
  'is_any_of',
  'is_none_of',
  'is_empty',
  'is_not_empty',
  'contains',
  'not_contains',
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'on_or_before',
  'on_or_after',
  'between',
  'in_last_days',
  'in_next_days',
] as const satisfies readonly FilterOperatorId[];

// Totality guard: if `FilterOperatorId` gains a member the list omits, this
// line stops compiling (the registry-driven totality discipline, mistake #29).
type _UncoveredOperator = Exclude<FilterOperatorId, (typeof FILTER_OPERATOR_IDS)[number]>;
const _operatorsAreTotal: _UncoveredOperator extends never ? true : never = true;
void _operatorsAreTotal;

/** A condition's value by operator arity (the 6.1.1 `FilterConditionValue`):
 * a string list (enum ops), a string (text / single date), a number
 * (comparisons / day windows), a `[from, to]` date pair (a 2-element string
 * list, validated by the registry), or null (the zero-arity empty ops). */
const conditionValueSchema = z
  .union([z.array(z.string()), z.string(), z.number(), z.null()])
  .describe(
    'Value by operator arity: a string list for is_any_of/is_none_of (and a ' +
      '[from,to] pair for between), a string for contains/not_contains and single ' +
      'dates (YYYY-MM-DD), a number for comparisons and in_last_days/in_next_days, ' +
      'or null for is_empty/is_not_empty.',
  );

const conditionSchema = z.object({
  field: z
    .string()
    .describe(
      'Field id: a built-in (kind, status, priority, type, assignee, reporter, ' +
        'sprint, text, created, updated, due, storyPoints, estimate), a label/' +
        'component (lbl, cmp), or a custom field (cf:<fieldId>).',
    ),
  operator: z.enum(FILTER_OPERATOR_IDS).describe('The operator (must be in the field’s set).'),
  value: conditionValueSchema,
});

const filterSchema = z
  .object({
    version: z
      .string()
      .describe(
        `Envelope version — must be "${FILTER_PARAM_VERSION}" (the only supported version).`,
      ),
    combinator: z.enum(['and', 'or']).describe('Match all (and) or match any (or) of the rows.'),
    conditions: z
      .array(conditionSchema)
      .max(FILTER_ROW_CAP)
      .describe(
        `The filter rows (up to ${FILTER_ROW_CAP}). An empty list matches the whole project.`,
      ),
  })
  .describe(
    'A versioned FilterAST envelope — the SAME shape the /items ?filter= URL ' +
      'and saved filters carry. Omit to search the whole project.',
  );

const inputSchema = {
  projectKey: z
    .string()
    .min(1)
    .describe(
      'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
    ),
  filter: filterSchema.optional(),
  cursor: z.string().optional().describe('Opaque page cursor from a previous call’s nextCursor.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('Page size (1–50, default 50; the List’s server cap).'),
  planId: planIdField,
};

type SearchFilterArg = z.infer<typeof filterSchema>;

interface SearchArgs {
  projectKey: string;
  filter?: SearchFilterArg;
  cursor?: string;
  limit?: number;
  planId?: string;
}

/** One PROPOSAL as a compact line for the human-readable text block — spelled so
 *  a person watching the session cannot read it as a work item. */
function proposalLine(row: ProjectedRowDto): string {
  return `${row.tempRef} [${row.kind ?? '?'}/${row.priority ?? '—'}] ${row.title ?? '(untitled)'} — PROPOSED (no key until approved)`;
}

/** One result row as a compact line for the human-readable text block, with its
 *  dependency edges and comment count appended (the SAME markers `list_ready`
 *  renders, in the same order). */
function line(
  item: WorkItemListItemDto,
  edges: WorkItemDependencyEdgesDto | undefined,
  commentCount: number | undefined,
): string {
  return `${item.identifier} [${item.kind}/${item.priority}] ${item.title} — ${item.status}${edgeMarker(edges)}${commentCountMarker(commentCount)}`;
}

/** Map the agent-facing expanded filter to the 6.1.1 stored envelope `{ v, c, f }`. */
function toEnvelope(filter: SearchFilterArg): FilterEnvelope {
  return {
    v: filter.version,
    c: filter.combinator,
    f: filter.conditions.map(
      (c) => [c.field, c.operator, c.value as FilterConditionValue] as const,
    ) as FilterEnvelope['f'],
  };
}

export async function runSearchWorkItems(
  args: SearchArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  // Decode the envelope through the SHARED 6.1.1 codec — a foreign version or a
  // structurally-broken envelope yields the codec's typed failure, surfaced as
  // a clean tool error (NOT a thrown protocol error). Registry-level validation
  // (unknown field/operator, bad value arity) runs next inside the service.
  let ast;
  if (args.filter) {
    const decoded = decodeFilterEnvelope(toEnvelope(args.filter));
    if (!decoded.ok) return toFilterDecodeToolError(decoded);
    ast = decoded.ast;
  }

  // The opaque cursor carries the next 1-based page; absent → page 1.
  const requestedPage = args.cursor ? decodeSearchCursor(args.cursor).page : 1;

  const project = await projectsService.getByKey(args.projectKey, ctx);
  const result = await workItemsService.getProjectIssuesList(
    project.id,
    {
      sort: DEFAULT_SORT,
      filter: ast ? { ast } : undefined,
      page: requestedPage,
      pageSize: args.limit,
    },
    ctx,
  );

  // The service CLAMPS an over-the-end page to the last page. A cursor that
  // overshot the tail must read as an empty terminal page (parity with the
  // ready cursor), NOT a re-fetch of the clamped last page that would loop.
  const overshot = result.page < requestedPage;
  const items = overshot ? [] : result.items;
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const nextCursor =
    !overshot && result.page < totalPages ? encodeSearchCursor({ page: result.page + 1 }) : null;

  // The page's dependency edges in TWO batched queries (MOTIR-1842) — the SAME
  // service seam `list_ready` uses, so the two lists carry an identical
  // `dependencies` block and a client renders both with one renderer.
  const [edges, commentCounts] = await Promise.all([
    workItemsService.getDependencyEdgesForItems(
      items.map((i) => i.id),
      ctx,
    ),
    // The same DISCUSSION signal `list_ready` attaches (MOTIR-2001), from the
    // same batched service seam — one query for the page, so the two lists carry
    // an identical `commentCount` and a client renders both with one renderer.
    commentsService.getCommentCountsForItems(
      items.map((i) => i.id),
      ctx,
    ),
  ]);

  // The plan's delta, when one was named. Committed rows the plan REMOVES drop
  // out of the page — a projected search must not return a card the plan is
  // deleting — and the plan's `add`s ride their own array.
  const delta = args.planId === undefined ? null : await projectedSearchDelta(args.planId, ctx);
  const removed = new Set(delta?.removedIds ?? []);
  const modified = new Set(delta?.modifiedIds ?? []);
  const visible = delta === null ? items : items.filter((i) => !removed.has(i.id));

  const header =
    visible.length === 0
      ? 'No work items match.'
      : `${visible.length} of ${result.total} matching work item${result.total === 1 ? '' : 's'}:`;
  const body = visible.map((item) => line(item, edges[item.id], commentCounts[item.id])).join('\n');
  const projected =
    delta === null
      ? ''
      : '\n\n' +
        [
          delta.proposals.length === 0
            ? `Plan ${delta.planId} proposes nothing to add.`
            : `Plan ${delta.planId} additionally PROPOSES ${delta.proposals.length} item(s) — not work items, and NOT filtered by your query (the filter runs over committed rows only):`,
          ...delta.proposals.map(proposalLine),
          removed.size > 0
            ? `This plan REMOVES ${removed.size} committed item(s), which are omitted above.`
            : '',
          modified.size > 0 ? `This plan MODIFIES ${modified.size} committed item(s).` : '',
          'Nothing was created: approving the plan in Motir is the only path from a proposal to a work item.',
        ]
          .filter(Boolean)
          .join('\n');
  const footer = nextCursor ? `\n\nMore available — pass cursor: ${nextCursor}` : '';
  return toolOk(
    `${header}${body ? '\n' + body : ''}${projected}${footer}`,
    derived(searchWorkItemsPayload, {
      items: visible.map((item) =>
        presentMcpWorkItemRow(item, edges[item.id], commentCounts[item.id] ?? 0),
      ),
      total: result.total,
      nextCursor,
      // ⚠️ ONLY present when a plan was named, so a call without `planId` is
      // byte-identical to what it returned before this existed.
      ...(delta === null
        ? {}
        : {
            projection: {
              planId: delta.planId,
              // Named rather than assumed: `items` is the FILTERED committed
              // page and `proposals` is the plan's whole add set. A caller that
              // reads the two as one filtered list would be wrong, and this is
              // the field that stops it.
              filterAppliesTo: 'items' as const,
              removedIds: delta.removedIds,
              modifiedIds: delta.modifiedIds,
            },
            proposals: delta.proposals,
          }),
    }),
  );
}

export function registerSearchWorkItems(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    SEARCH_WORK_ITEMS_TOOL_NAME,
    {
      title: 'Search work items',
      description:
        'Search a project’s work items with a versioned FilterAST envelope (the same filter ' +
        'grammar the /items advanced filter and saved filters use), as a cursor-paginated page. ' +
        'Omit `filter` to page the whole project. Returns the matching items, the total count, ' +
        'and a nextCursor. Honors the same access checks as the UI. ' +
        EDGE_BLOCK_DESCRIPTION +
        ' ' +
        COMMENT_COUNT_DESCRIPTION +
        ' Pass `planId` to search the tree INCLUDING a plan you are authoring: `items` then holds ' +
        'the committed rows the plan does not remove, and a separate `proposals` array holds that ' +
        'plan’s proposed cards — each with `proposal: true` and a null `key`, because a proposal ' +
        'has no key until the plan is approved in Motir. ⚠️ The FILTER applies to `items` ONLY ' +
        '(`projection.filterAppliesTo` says so): it compiles to SQL over committed rows, so the ' +
        'proposals come back UNFILTERED rather than silently matched on whichever fields they ' +
        'happen to carry. Omit `planId` for the committed tree — that call is unchanged. ' +
        'Read-only either way: it creates nothing and persists nothing.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runSearchWorkItems(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
