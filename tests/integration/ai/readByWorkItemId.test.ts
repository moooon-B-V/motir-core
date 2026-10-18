import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { toToolError } from '@/lib/mcp/toolResult';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  makeWorkItemFixture as makeFixture,
  createTestLink,
  createTestProject,
} from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-8940 — a plan names its committed cards by ID (`parentRef`,
// `blockedByRefs`, `workItemId`), and both work-item read doors took a KEY only.
// A planning session that followed the blocker ref its own plan stores was
// refused (`PROJECT_NOT_FOUND: Project CMVD16SJ… not found` on the MCP door, a
// 404 on the internal one) and had to search by title to find the card. Both
// doors now take either form, in one call, behind the same gates.

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A card and the committed blocker a plan would name by id. */
async function blockedCard() {
  const fx = await makeFixture();
  const blocker = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The blocker' },
    fx.ctx,
  );
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  await createTestLink({
    workspaceId: fx.workspaceId,
    fromId: card.id,
    toId: blocker.id,
    kind: 'is_blocked_by',
    createdById: fx.ownerId,
  });
  return { fx, blocker, card };
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

/** The tool as a client sees it: `registerGetWorkItem` maps a throw through `toToolError`. */
async function callTool(args: { key: string }, ctx: Parameters<typeof runGetWorkItem>[1]) {
  try {
    return await runGetWorkItem(args, ctx);
  } catch (err) {
    return toToolError(err);
  }
}

describe('get_work_item (MCP) — by work-item id', () => {
  it('reads the blocker a plan names by id in one call, the same card as by key', async () => {
    const { fx, blocker } = await blockedCard();

    const byId = await runGetWorkItem({ key: blocker.id }, fx.ctx);
    const byKey = await runGetWorkItem({ key: blocker.identifier }, fx.ctx);

    expect(byId.isError).toBeFalsy();
    expect(byId.structuredContent).toEqual(byKey.structuredContent);
    expect(textOf(byId)).toContain(`${blocker.identifier} [task] The blocker`);
  });

  it('an unknown id is the ordinary not-found, never a project miss', async () => {
    const { fx } = await blockedCard();

    const res = await callTool({ key: 'cmvd16sj700ykhmqa7wl1wzhq' }, fx.ctx);

    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('PROJECT_NOT_FOUND');
    expect(textOf(res)).toContain('WORK_ITEM_NOT_FOUND');
  });

  it('another workspace’s id is not-found, exactly as an unknown one', async () => {
    const { blocker } = await blockedCard();
    const other = await makeFixture({ name: 'Other' });

    const res = await callTool({ key: blocker.id }, other.ctx);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('WORK_ITEM_NOT_FOUND');
  });
});

describe('aiBoundaryService.getItem (the hosted planner’s get_item) — by work-item id', () => {
  it('reads the blocker a plan names by id in one call', async () => {
    const { fx, blocker, card } = await blockedCard();

    const res = await aiBoundaryService.getItem(fx.projectId, blocker.id, fx.ctx);

    expect(res.item.identifier).toBe(blocker.identifier);
    expect(res.item.blocks.map((l) => l.item.identifier)).toEqual([card.identifier]);
  });

  it('holds an id to the token’s project: another project’s card is not-found', async () => {
    const fx = await makeFixture();
    const otherProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const foreign = await workItemsService.createWorkItem(
      { projectId: otherProject.id, kind: 'task', title: 'Not this project' },
      fx.ctx,
    );

    await expect(
      aiBoundaryService.getItem(fx.projectId, foreign.id, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    // ...while its KEY is not-found here too: the id arm adds no reach the key arm lacks.
    await expect(
      aiBoundaryService.getItem(fx.projectId, foreign.identifier, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});
