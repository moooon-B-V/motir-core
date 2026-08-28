import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { resolveCoordinate } from './linkPullRequest';
import { resolveWorkItemByKey, workItemKeyField } from './workItemRef';

// `unlink_pull_request` (MOTIR-3756, ADR `docs/decisions/delivery-reader-migration.md`
// §6) — the correction door `link_pull_request` has never had.
//
// ── Why this exists NOW and did not before ────────────────────────────────
// While the association was a SINGULAR foreign key, a mis-link corrected itself:
// linking the pull request to the right card MOVED the column, and the wrong
// association ceased to exist because there was only ever one. `work_item_delivery`
// is a set, so a re-link ADDS and the mistaken row STAYS — holding the card open on
// a pull request that never delivered it, because the completion gate counts the
// card's delivering pull requests and one of them will never merge for it.
//
// That is why the tool ships in THIS card and not in MOTIR-3721: the hazard begins
// the moment the readers move to the set, which is the moment the picker's readers
// move. One card earlier it would have been a correction surface for a hazard that
// did not exist yet; one card later is the gap the argument was written to close.
//
// ── Coordinates, not cuids ────────────────────────────────────────────────
// It addresses the pull request exactly as its sibling does — `(owner/name, number)`
// or the `url` `gh pr create` printed — and shares that resolver rather than
// re-implementing it. The actor is an agent that mis-linked a pull request seconds
// ago; it knows the coordinate and does not know Motir's internal id. The item-page
// affordance keeps its own cuid-addressed path.
//
// ── The permission, stated as a decision ──────────────────────────────────
// `work_item:edit` — THE SAME KEY `link_pull_request` ASSERTS. Undoing a link is
// editing the card the link was made against, exactly as making it was, and a
// correction door that a token could not reach while it could reach the door that
// creates the mistake would be a strictly worse arrangement than having no door.
// `CLI_TOKEN_GRANT` already carries the key, so a sandboxed run can call this and
// nothing is widened by adding the tool — the same argument, and the same two
// counter-examples (MOTIR-3058, MOTIR-3051), that chose the key for the link tool.

export const UNLINK_PULL_REQUEST_TOOL_NAME = 'unlink_pull_request';

const inputSchema = {
  key: workItemKeyField,
  repository: z
    .string()
    .trim()
    .optional()
    .describe(
      'The repository as "owner/name", exactly as it is connected in Motir (case-insensitive). ' +
        'Give this WITH `number`, or give `url` instead — not neither.',
    ),
  number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The pull-request number, e.g. 2291. Give this with `repository`.'),
  url: z
    .string()
    .trim()
    .optional()
    .describe(
      'The full pull-request URL, e.g. "https://github.com/acme/web/pull/2291". An alternative ' +
        'to `repository` + `number`, never a supplement: if both are given they must agree.',
    ),
};

/** The adapter: resolve the item + the coordinate, then remove the one link. */
export async function runUnlinkPullRequest(
  args: { key: string; repository?: string; number?: number; url?: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const coordinate = resolveCoordinate(args);
    // A TOOL error, not a throw — the same treatment the link tool gives it: the
    // agent can fix an address in one hop, and an opaque internal error would tell
    // it nothing about which argument is wrong.
    if (!coordinate.ok) return toolError('INVALID_PULL_REQUEST_REF', coordinate.message);

    const item = await resolveWorkItemByKey(args.key, ctx);
    const where = `${coordinate.owner}/${coordinate.name}#${coordinate.number}`;
    const result = await githubPullRequestService.unlinkPullRequestByCoordinates(
      {
        workItemId: item.id,
        projectId: item.projectId,
        owner: coordinate.owner,
        name: coordinate.name,
        number: coordinate.number,
      },
      ctx,
    );

    // `removed: false` is reported as an ANSWER rather than dressed up as a
    // success: the pair was not linked, which on a correction is the difference
    // between "fixed" and "you unlinked the wrong one".
    return toolOk(
      result.removed
        ? `Unlinked ${where} from ${item.identifier}. Its other deliveries are untouched, and ` +
            `so is every other card ${where} delivers.`
        : `${where} was not linked to ${item.identifier} — nothing to remove.`,
      exempt(UNLINK_PULL_REQUEST_TOOL_NAME, {
        key: item.identifier,
        removed: result.removed,
        pullRequest: where,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerUnlinkPullRequest(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    UNLINK_PULL_REQUEST_TOOL_NAME,
    {
      title: 'Unlink pull request',
      description:
        'Undo ONE `link_pull_request` — remove the delivery recorded between this work item and ' +
        'this pull request. Reach for it when a link named the wrong card: a delivery is a ROW ' +
        'now, not a column, so linking the RIGHT card ADDS a second delivery and leaves the ' +
        'mistaken one in place, holding the card open on a pull request that will never merge ' +
        'for it. Re-linking is not a correction; this is. ' +
        'It removes EXACTLY ONE delivery — the (work item, pull request) pair you name. Every ' +
        'other card the same pull request delivers keeps its own delivery, and this card keeps ' +
        'every other pull request that delivers it, so unlinking one repository of a multi-repo ' +
        'card does not retract the others. ' +
        'Address the pull request as `repository` ("owner/name") + `number`, or as `url` — the ' +
        'same two forms `link_pull_request` takes. An unknown repository or number is REFUSED ' +
        'rather than answered as a no-op, because a typo and a link that was never there are ' +
        'opposite facts; `removed: false` means the pull request and the item both exist and ' +
        'were simply not linked. ' +
        'It leaves the pull request itself alone — its state, its title and its checks are the ' +
        'webhook’s to say, not the caller’s. Honors the same access checks as the UI and ' +
        'asserts the same permission `link_pull_request` does.',
      inputSchema,
    },
    async (args, extra) => runUnlinkPullRequest(args, resolveContext(extra)),
  );
}
