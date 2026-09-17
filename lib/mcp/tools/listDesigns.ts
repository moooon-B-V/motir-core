import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { designAccessService } from '@/lib/services/designAccessService';
import type { ApprovedDesignDto, DesignVerdictDto } from '@/lib/dto/designAccess';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { listDesignsPayload } from '../payloads/designs';

// `list_designs` (Story MOTIR-5553 · Subtask MOTIR-5561) — the designs a card
// WAITS ON, or a page of a project's approved designs.
//
// Two questions, one tool, because they are the same question at two scopes and
// an agent asks the first far more often: *what am I supposed to be building
// against?* (`blockersOf`) and *what else has been designed?* (the project
// listing). Splitting them would make the common case the one with the longer
// name.
//
// ⚠️ NO DOWNLOAD LINKS, on either arm. A presign lives 300 seconds, so a page of
// designs would mint links that begin expiring before the agent has read the
// list, almost none of which it wants. The agent finds the design here and asks
// `get_design` for it — which mints links at the moment it has decided to fetch.

export const LIST_DESIGNS_TOOL_NAME = 'list_designs';

const inputSchema = {
  projectKey: z
    .string()
    .min(1)
    .describe(
      'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a ' +
        'reserved value. Case-insensitive.',
    ),
  blockersOf: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A work item key (e.g. "ACME-7"). When given, the answer is ONE VERDICT PER DESIGN CARD ' +
        'that work item is `blocked_by` — the designs it is supposed to be built against — ' +
        'instead of a page of the project’s designs. The other filters do not apply.',
    ),
  pathPrefix: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Return only designs holding a file whose repository path starts with this prefix — how a ' +
        'delta mock’s amended BASE is found (e.g. `design/work-items/`). Ignored with `blockersOf`.',
    ),
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A case-insensitive substring of the design card’s TITLE. Ignored with `blockersOf`.',
    ),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe('Opaque page cursor from a previous call’s `nextCursor`. Ignored with `blockersOf`.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Page size (1–100, default 25). Ignored with `blockersOf`.'),
};

interface ListDesignsArgs {
  projectKey: string;
  blockersOf?: string;
  pathPrefix?: string;
  query?: string;
  cursor?: string;
  limit?: number;
}

function summarizeVerdicts(verdicts: DesignVerdictDto[], ofKey: string): string {
  if (verdicts.length === 0) {
    return `${ofKey} waits on no design cards. If it builds a surface, the plan has not said which design it is built against.`;
  }
  const lines = [`${ofKey} waits on ${verdicts.length} design card(s):`, ''];
  for (const verdict of verdicts) {
    if (verdict.verdict !== 'approved') {
      lines.push(
        `  ${verdict.designCardKey}  NO APPROVED DESIGN (${verdict.reason})  ${verdict.designCardTitle}`,
      );
      continue;
    }
    lines.push(
      `  ${verdict.designCardKey}  APPROVED  ${verdict.designCardTitle}`,
      `      version ${verdict.design.evidenceId}, ${verdict.design.assets.length} file(s): ` +
        verdict.design.assets.map((a) => a.sourcePath).join(', '),
    );
  }
  lines.push(
    '',
    'Call `get_design` on a design card key for links to its files. ⚠️ A card with NO approved ' +
      'design is one you must not improvise a surface for: stop, and propose a design card ' +
      'beside the card you are running.',
  );
  return lines.join('\n');
}

function summarizeDesigns(designs: ApprovedDesignDto[], nextCursor: string | null): string {
  if (designs.length === 0) {
    return 'No approved designs matched. A design still under review is not listed — it is not something to build against.';
  }
  const lines = [`${designs.length} approved design(s), newest first:`, ''];
  for (const design of designs) {
    lines.push(
      `  ${design.designCardKey}  ${design.designCardTitle}`,
      `      version ${design.evidenceId}, ${design.assets.length} file(s): ` +
        design.assets.map((a) => a.sourcePath).join(', '),
    );
  }
  lines.push('', 'Call `get_design` on one of these keys for links to its files.');
  if (nextCursor) lines.push(`More: pass cursor "${nextCursor}".`);
  return lines.join('\n');
}

export async function runListDesigns(
  args: ListDesignsArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  if (args.blockersOf) {
    const designs = await designAccessService.designsForWorkItem(args.blockersOf, ctx);
    return toolOk(
      summarizeVerdicts(designs, args.blockersOf),
      derived(listDesignsPayload, { designs: designs.map((d) => ({ ...d })) }),
    );
  }

  const page = await designAccessService.listApprovedDesigns(
    args.projectKey,
    {
      ...(args.pathPrefix ? { pathPrefix: args.pathPrefix } : {}),
      ...(args.query ? { query: args.query } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    },
    ctx,
  );
  return toolOk(
    summarizeDesigns(page.designs, page.nextCursor),
    derived(listDesignsPayload, {
      items: page.designs.map((d) => ({ ...d })),
      nextCursor: page.nextCursor,
    }),
  );
}

export function registerListDesigns(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    LIST_DESIGNS_TOOL_NAME,
    {
      title: 'List designs',
      description:
        'WHAT AM I BUILDING AGAINST? With `blockersOf: "<work item key>"` this returns one ' +
        'verdict per design card that work item is `blocked_by` — the designs it is supposed to ' +
        'be built against — and that is the question to ask before you draw or change any ' +
        'surface. Without it, a cursor-paged page of the PROJECT’s approved designs, newest ' +
        'first, narrowed by `pathPrefix` (a repository path prefix — how a delta mock’s amended ' +
        'BASE is found) and `query` (a substring of the design card’s title). ⚠️ ONLY APPROVED ' +
        'DESIGNS are listed: a design still under review is not something to build against. A ' +
        'verdict that is not `approved` names one of five reasons — `not_done`, `cancelled`, ' +
        '`withdrawn`, `no_result`, `not_a_design_card` — and a card with no approved design is ' +
        'one you must NOT improvise a surface for: stop, and propose a design card beside the ' +
        'card you are running. ⚠️ NO DOWNLOAD LINKS here, on either arm, and that is deliberate: ' +
        'a link lives minutes, so a page of them would expire before you read the list. Find the ' +
        'design here, then call `get_design` on its key for links minted at the moment you ' +
        'actually fetch. Read-only: it creates nothing and persists nothing.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runListDesigns(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
