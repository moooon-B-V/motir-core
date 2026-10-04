import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { decisionPageService } from '@/lib/services/decisionPageService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { pageIdField } from './pageRef';
import { resolveWorkItemByKey, workItemKeyField } from './workItemRef';

// `publish_decision_page` (Story MOTIR-5761 · MOTIR-7434) — hand a page to a
// `decision` card as its decision, under `work_item:edit` on the card and
// `page:view` on the page (`docs/decisions/approval-gates.md` §8 NINTH AMENDMENT).
// A thin adapter over `decisionPageService.publish`: it SEALS the page's latest
// version and records the publication; on an agent's decision card it raises the
// decision question about that version and moves the card to review.
//
// Retrying is safe: publishing the version that is already the card's decision
// writes nothing and returns the same publication (`replayed: true`).
//
// EXEMPT from payload derivation (`payloads/exemptions.ts`): no `/api/v1`
// operation returns a publication.

export const PUBLISH_DECISION_PAGE_TOOL_NAME = 'publish_decision_page';

const inputSchema = {
  key: workItemKeyField,
  pageId: pageIdField,
};

/** The adapter: resolve the card by key, then publish the page as its decision. */
export async function runPublishDecisionPage(
  args: { key: string; pageId: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const item = await resolveWorkItemByKey(args.key, ctx);
    const publication = await decisionPageService.publish(
      { workItemId: item.id, pageId: args.pageId },
      ctx,
    );
    const asked = publication.gateId
      ? ' The decision question is waiting on a person — the card is NOT finished.'
      : '';
    const text = publication.replayed
      ? `${publication.workItemKey}'s decision is already version ${publication.versionNumber} ` +
        `of "${publication.pageTitle || 'Untitled'}" (${publication.pageId}); nothing changed.`
      : `Published version ${publication.versionNumber} of "${publication.pageTitle || 'Untitled'}" ` +
        `(${publication.pageId}) as ${publication.workItemKey}'s decision. That version is now ` +
        `sealed: later edits start a new version, and publishing again asks about the new one.` +
        asked;
    return toolOk(text, exempt(PUBLISH_DECISION_PAGE_TOOL_NAME, { ...publication }));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerPublishDecisionPage(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    PUBLISH_DECISION_PAGE_TOOL_NAME,
    {
      title: 'Publish decision page',
      description:
        'Publish a page as a DECISION card’s decision — call it ONCE, after `create_page` / ' +
        '`update_page` have written the decision, in the same run. It SEALS the page’s newest ' +
        'version (later edits start a new version) and records it as the card’s decision. On a ' +
        'card an agent runs, it then asks a person to approve exactly that version and moves the ' +
        'card to review: the card is waiting on them, not finished. Returns the publication ' +
        '(`versionNumber`, `pageId`, `gateId`). Publishing the same version again writes nothing ' +
        '(`replayed: true`); publishing after an edit replaces the question with one about the new ' +
        'version. Refused by name: NOT_A_DECISION_CARD, PAGE_NOT_FOUND, PAGE_IN_ANOTHER_PROJECT, ' +
        'PAGE_IS_EMPTY, PAGE_ARCHIVED, CARD_IS_FINISHED.',
      inputSchema,
    },
    async (args, extra) => runPublishDecisionPage(args, resolveContext(extra)),
  );
}
