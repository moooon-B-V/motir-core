import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  RELATIONSHIP_KINDS,
  relationshipLabel,
  relationshipToLink,
} from '@/lib/workItems/linkRelationships';
import { DuplicateLinkError } from '@/lib/workItems/linkErrors';
import type { RelationshipKind } from '@/lib/dto/workItemLinks';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { resolveWorkItemIdPair, workItemKeyField } from './workItemRef';

// `link_work_items` / `unlink_work_items` (Story 7.8 · Subtask 7.8.13) — the
// MCP primitive for the DEPENDENCY EDGES the plan is built on. Before this an
// agent (or the planner) could only record "A is_blocked_by B" as a free-text
// comment, not a real link the board / ready-set / relationships panel
// understand. Both tools are THIN adapters over the shipped Epic-2 work-item
// link service — `workItemsService.linkWorkItems` / `unlinkWorkItemsByEndpoints`
// — so EVERY existing invariant holds unchanged: the same-workspace + 6.4 edit
// gate, the DB-trigger self-link / cycle guards, and the `relates_to` reciprocal
// are the service's job, surfaced here as clean typed tool errors (the
// `transition_status` self-correcting pattern).
//
// Addressing matches the UI relationship model (`linkRelationships.ts`), not the
// raw storage kind: the FIVE user-facing relationships (`blocked_by`, `blocks`,
// `relates_to`, `duplicates`, `clones`) map to the four directed storage kinds —
// `blocks` is the inverse direction of `blocked_by`. The agent says
// "PROD-3 blocked_by PROD-1"; the tool resolves both keys to ids and maps the
// pair to the directed `LinkWorkItemsInput` the service consumes. Link targets
// may be cross-PROJECT within the workspace (a blocker can live in another
// project — the link model allows it, matching the UI), so each key is resolved
// against its OWN project prefix.

export const LINK_WORK_ITEMS_TOOL_NAME = 'link_work_items';
export const UNLINK_WORK_ITEMS_TOOL_NAME = 'unlink_work_items';

const RELATIONSHIP_IDS = RELATIONSHIP_KINDS.map((r) => r.kind) as [
  RelationshipKind,
  ...RelationshipKind[],
];

const relationshipDescription =
  'The relationship FROM the first item TO the second, read "fromKey <relationship> toKey": ' +
  '"blocked_by" (fromKey is blocked by toKey — the dependency edge that holds fromKey out of the ' +
  'ready set), "blocks" (the inverse — fromKey blocks toKey), "relates_to", "duplicates", or ' +
  '"clones".';

const inputSchema = {
  fromKey: workItemKeyField,
  toKey: workItemKeyField,
  relationship: z.enum(RELATIONSHIP_IDS).describe(relationshipDescription),
};

interface LinkArgs {
  fromKey: string;
  toKey: string;
  relationship: RelationshipKind;
}

/** `"PROD-3 blocked_by PROD-1"` — the human-readable edge for the text block. */
function edgeText(args: LinkArgs): string {
  return `${args.fromKey.trim().toUpperCase()} ${relationshipLabel(
    args.relationship,
  ).toLowerCase()} ${args.toKey.trim().toUpperCase()}`;
}

/** The adapter: resolve both keys (each by its own project prefix), map the UI
 *  relationship to the directed storage link, then create it. A duplicate is
 *  idempotent (success, not an error); the service's structural guards surface
 *  as clean tool errors. */
export async function runLinkWorkItems(
  args: LinkArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const [fromId, toId] = await resolveWorkItemIdPair(args.fromKey, args.toKey, ctx);
    const input = relationshipToLink(args.relationship, fromId, toId);
    const dto = await workItemsService.linkWorkItems(input, ctx);
    return toolOk(`Linked: ${edgeText(args)} (stored ${input.kind})`, {
      ...(dto as unknown as Record<string, unknown>),
      relationship: args.relationship,
    });
  } catch (err) {
    // Idempotency (acceptance): re-creating an existing link is a no-op success,
    // not a DUPLICATE_LINK error — the agent can safely retry.
    if (err instanceof DuplicateLinkError) {
      return toolOk(`Already linked: ${edgeText(args)} (idempotent no-op)`, {
        idempotent: true,
        relationship: args.relationship,
      });
    }
    return toToolError(err);
  }
}

/** The adapter: resolve both keys + relationship to the directed link, then
 *  remove it. Idempotent — removing an already-absent link is a success no-op. */
export async function runUnlinkWorkItems(
  args: LinkArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const [fromId, toId] = await resolveWorkItemIdPair(args.fromKey, args.toKey, ctx);
    const input = relationshipToLink(args.relationship, fromId, toId);
    const removed = await workItemsService.unlinkWorkItemsByEndpoints(input, ctx);
    const text = removed
      ? `Unlinked: ${edgeText(args)} (removed ${input.kind})`
      : `No such link: ${edgeText(args)} (already absent — no-op)`;
    return toolOk(text, { removed, relationship: args.relationship });
  } catch (err) {
    return toToolError(err);
  }
}

export function registerLinkWorkItems(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    LINK_WORK_ITEMS_TOOL_NAME,
    {
      title: 'Link work items',
      description:
        'Create a relationship between two work items (by identifier, e.g. "PROD-3" / "PROD-1"): ' +
        'use "blocked_by" to record a DEPENDENCY EDGE (the first item is blocked by the second, so ' +
        'it leaves the ready set until the second is done), or "blocks" / "relates_to" / ' +
        '"duplicates" / "clones". Targets may be in another project in the same workspace. ' +
        'Re-creating an existing link is idempotent; a self / cycle / cross-workspace link returns ' +
        'a typed error. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runLinkWorkItems(args, resolveContext(extra)),
  );
  server.registerTool(
    UNLINK_WORK_ITEMS_TOOL_NAME,
    {
      title: 'Unlink work items',
      description:
        'Remove a relationship between two work items (by identifier + the same relationship used ' +
        'to create it). Idempotent — removing a link that is already absent succeeds as a no-op. ' +
        'Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runUnlinkWorkItems(args, resolveContext(extra)),
  );
}
