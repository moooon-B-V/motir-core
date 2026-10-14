import { expect } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '@/tests/helpers/adminDb';

// A SECOND ACTOR'S WRITE BURST (Story MOTIR-8539 · Subtask MOTIR-8571).
//
// The story's reader sits still while somebody else works. "Somebody else" is
// an MCP session over `/api/mcp` with a bearer token — a real agent through the
// real door — running in NODE, so nothing the spec does touches the page it is
// counting. Every write moves the reader's Workbench watermark: the burst card
// is assigned to the reader and sits in To do, and each write renames it, which
// moves that tab's `updatedAt` high-water mark (`workbenchWatermarkService`).

/** Deliberately not a substring of any seeded title (strict-mode locators). */
export const BURST_CARD_TITLE = 'Keep the reader in place while the queue moves';

/** The title the `n`th write gives the burst card. */
export function burstTitle(n: number): string {
  return `${BURST_CARD_TITLE} (write ${n})`;
}

/**
 * Seed the card the burst writes to: a To do subtask assigned to the reader,
 * under the project's first story.
 */
export async function seedBurstCard(seed: {
  projectId: string;
  workspaceId: string;
  reviewerId: string;
}): Promise<{ key: string; id: string }> {
  const story = await adminDb.workItem.findFirstOrThrow({
    where: { projectId: seed.projectId, kind: 'story' },
    select: { id: true },
  });
  const card = await workItemsService.createWorkItem(
    {
      projectId: seed.projectId,
      kind: 'subtask',
      title: BURST_CARD_TITLE,
      parentId: story.id,
      type: 'code',
      assigneeId: seed.reviewerId,
    },
    { userId: seed.reviewerId, workspaceId: seed.workspaceId },
  );
  return { key: card.identifier, id: card.id };
}

/**
 * Make `count` writes to `key` through the agent's own door, one after the
 * other, and return when the last one was ACKNOWLEDGED (node clock).
 *
 * ⚠️ EACH RESULT IS CHECKED. An MCP tool reports a refusal as a result
 * (`isError`), not a rejected promise, so an unchecked burst could resolve
 * having written nothing and every count after it would be a count of nothing.
 */
export async function driveWriteBurst(
  client: Client,
  key: string,
  count: number,
): Promise<{ writes: number; lastWriteAt: number }> {
  for (let n = 1; n <= count; n += 1) {
    const result = (await client.callTool({
      name: 'update_work_item',
      arguments: { key, title: burstTitle(n) },
    })) as CallToolResult;
    expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
  }
  return { writes: count, lastWriteAt: Date.now() };
}
