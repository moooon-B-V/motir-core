import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import { buildMcpServer } from '@/lib/mcp/registry';
import { obsolescenceLines } from '@/lib/mcp/obsolescence';
import { runCreateWorkItem } from '@/lib/mcp/tools/createWorkItem';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { runLinkWorkItems } from '@/lib/mcp/tools/linkWorkItems';
import { runListReady } from '@/lib/mcp/tools/listReady';
import { runMoveToParent } from '@/lib/mcp/tools/moveToParent';
import { runNextReady } from '@/lib/mcp/tools/nextReady';
import { runSearchWorkItems } from '@/lib/mcp/tools/searchWorkItems';
import { runSkeleton } from '@/lib/mcp/tools/skeleton';
import { runTransitionStatus } from '@/lib/mcp/tools/transitionStatus';
import { runUpdateWorkItem } from '@/lib/mcp/tools/updateWorkItem';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The OBSOLESCENCE mark on the MCP work-item doors (Story MOTIR-6574 ·
// MOTIR-6582), over real Postgres: `create_work_item` / `update_work_item` write
// it (a `done` card included, `null` clears, a value outside the enum is the
// TYPED `INVALID_OBSOLESCENCE`), and every read the card names returns it —
// `get_work_item` (item + child rows + text block), `search_work_items` (rows +
// text), `skeleton` (the mark only), `list_ready` / `next_ready` rows. The
// load-bearing negative: no read drops or re-sorts a marked card.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Marked = {
  id: string;
  identifier?: string;
  key?: string;
  obsolescence: WorkItemObsolescenceDto | null;
  obsolescenceNoteMd?: string | null;
};

const text = (res: CallToolResult): string =>
  res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

const mk = (fx: WorkItemFixture, title: string, kind: 'story' | 'task' = 'task') =>
  workItemsService.createWorkItem({ projectId: fx.projectId, kind, title }, fx.ctx);

/** Mark a card the only way it may be since MOTIR-6672: finish it, then mark it. */
const mark = async (
  fx: WorkItemFixture,
  id: string,
  obsolescence: WorkItemObsolescenceDto | null,
  obsolescenceNoteMd: string | null,
) => {
  await adminDb.workItem.update({ where: { id }, data: { status: 'done' } });
  return workItemsService.updateWorkItem(id, { obsolescence, obsolescenceNoteMd }, fx.ctx);
};

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'obsolescence-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('update_work_item / create_work_item write the mark', () => {
  it('marks a DONE story, changes the mark, and clears both with null', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Shipped long ago', 'story');
    await adminDb.workItem.update({ where: { id: story.id }, data: { status: 'done' } });

    const marked = await runUpdateWorkItem(
      {
        key: story.identifier,
        obsolescence: 'outdated',
        obsolescenceNoteMd: 'Rewritten by the v2 flow.\nSee the new story.',
      },
      fx.ctx,
    );
    expect(marked.isError).toBeFalsy();
    const dto = marked.structuredContent as Marked & { status: string };
    expect(dto.status).toBe('done');
    expect(dto.obsolescence).toBe('outdated');
    expect(dto.obsolescenceNoteMd).toBe('Rewritten by the v2 flow.\nSee the new story.');
    expect(text(marked)).toContain('Patched: obsolescence, obsolescenceNoteMd');

    const changed = await runUpdateWorkItem(
      { key: story.identifier, obsolescence: 'deprecated' },
      fx.ctx,
    );
    expect((changed.structuredContent as Marked).obsolescence).toBe('deprecated');
    // The note is independent of the mark — untouched by a mark-only patch.
    expect((changed.structuredContent as Marked).obsolescenceNoteMd).toBe(
      'Rewritten by the v2 flow.\nSee the new story.',
    );

    const cleared = await runUpdateWorkItem(
      { key: story.identifier, obsolescence: null, obsolescenceNoteMd: null },
      fx.ctx,
    );
    expect(cleared.isError).toBeFalsy();
    expect((cleared.structuredContent as Marked).obsolescence).toBeNull();
    expect((cleared.structuredContent as Marked).obsolescenceNoteMd).toBeNull();
  });

  it('create_work_item takes the NOTE on any kind, and writes nothing for a MARK', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runCreateWorkItem(
      {
        projectKey: 'PROD',
        kind: 'story',
        title: 'Recorded with a note',
        obsolescenceNoteMd: 'Kept for the record.',
      },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    const dto = res.structuredContent as Marked;
    expect([dto.obsolescence, dto.obsolescenceNoteMd]).toEqual([null, 'Kept for the record.']);

    // A new card lands at the unfinished initial status, and a mark is a FINISHED
    // card's state (MOTIR-6672) — a TYPED refusal naming the remedy (MOTIR-6673),
    // and nothing is created.
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    const refused = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'story', title: 'Retired', obsolescence: 'deprecated' },
      fx.ctx,
    );
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('OBSOLESCENCE_REQUIRES_FINISHED');
    expect(text(refused)).toContain('archived, not marked');
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
  });

  it('a value outside the enum is the TYPED INVALID_OBSOLESCENCE — on the wire and at the runner', async () => {
    const fx = await makeWorkItemFixture();
    const task = await mk(fx, 'Target');

    // Over the MCP wire: the published enum refuses it, and the message leads
    // with the code and names the field.
    const client = await connectClient(fx.ctx);
    const wire = (await client.callTool({
      name: 'update_work_item',
      arguments: { key: task.identifier, obsolescence: 'stale' },
    })) as CallToolResult;
    expect(wire.isError).toBe(true);
    expect(text(wire)).toContain('INVALID_OBSOLESCENCE');
    expect(text(wire)).toContain('obsolescence');

    // A caller that bypasses the schema reaches the service backstop, which the
    // tool maps to the same typed code — never an opaque internal error.
    const direct = await runUpdateWorkItem(
      { key: task.identifier, obsolescence: 'stale' as never },
      fx.ctx,
    );
    expect(direct.isError).toBe(true);
    expect(JSON.stringify(direct.content)).toContain('INVALID_OBSOLESCENCE');
    const createDirect = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'x', obsolescence: 'stale' as never },
      fx.ctx,
    );
    expect(createDirect.isError).toBe(true);
    expect(JSON.stringify(createDirect.content)).toContain('INVALID_OBSOLESCENCE');

    // Nothing was written.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.obsolescence).toBeNull();
  });
});

describe('the MCP reads return the mark', () => {
  it('get_work_item: the item, every child row, and the text block', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Parent', 'story');
    const [a, b] = await Promise.all([
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'Old child', parentId: story.id },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'Current child', parentId: story.id },
        fx.ctx,
      ),
    ]);
    const replacement = await mk(fx, 'The new way');
    await mark(fx, story.id, 'outdated', '\nThe flow moved.\nSecond line.');
    await mark(fx, a.id, 'deprecated', 'Dropped.');
    await runLinkWorkItems(
      { fromKey: replacement.identifier, toKey: story.identifier, relationship: 'supersedes' },
      fx.ctx,
    );

    const res = await runGetWorkItem({ key: story.identifier }, fx.ctx);
    expect(res.isError).toBeFalsy();
    const payload = res.structuredContent as { item: Marked; children: Marked[] };
    expect([payload.item.obsolescence, payload.item.obsolescenceNoteMd]).toEqual([
      'outdated',
      '\nThe flow moved.\nSecond line.',
    ]);
    // Both children come back — the marked one is neither hidden nor moved.
    const byId = new Map(payload.children.map((c) => [c.id, c]));
    expect(payload.children).toHaveLength(2);
    expect([byId.get(a.id)!.obsolescence, byId.get(a.id)!.obsolescenceNoteMd]).toEqual([
      'deprecated',
      'Dropped.',
    ]);
    expect([byId.get(b.id)!.obsolescence, byId.get(b.id)!.obsolescenceNoteMd]).toEqual([
      null,
      null,
    ]);

    const lines = text(res).split('\n');
    expect(lines).toContain(`obsolescence: outdated — superseded by ${replacement.identifier}`);
    expect(lines).toContain('note: The flow moved.');
    expect(text(res)).not.toContain('Second line.');
  });

  it('get_work_item prints no new line for an unmarked card', async () => {
    const fx = await makeWorkItemFixture();
    const task = await mk(fx, 'Current');
    // A note alone is not a mark: the card is still current.
    await mark(fx, task.id, null, 'Just a note.');
    const res = await runGetWorkItem({ key: task.identifier }, fx.ctx);
    expect(text(res)).not.toMatch(/obsolescence:|note:/);
  });

  it('search_work_items: both fields on every row, the mark in the text, no row dropped or re-sorted', async () => {
    const fx = await makeWorkItemFixture();
    const first = await mk(fx, 'First');
    const second = await mk(fx, 'Second');
    const before = (await runSearchWorkItems({ projectKey: 'PROD' }, fx.ctx)).structuredContent as {
      items: Marked[];
    };
    await mark(fx, first.id, 'outdated', 'Superseded.');

    const res = await runSearchWorkItems({ projectKey: 'PROD' }, fx.ctx);
    const items = (res.structuredContent as { items: Marked[] }).items;
    expect(items.map((i) => i.id)).toEqual(before.items.map((i) => i.id));
    const byId = new Map(items.map((i) => [i.id, i]));
    expect([byId.get(first.id)!.obsolescence, byId.get(first.id)!.obsolescenceNoteMd]).toEqual([
      'outdated',
      'Superseded.',
    ]);
    expect([byId.get(second.id)!.obsolescence, byId.get(second.id)!.obsolescenceNoteMd]).toEqual([
      null,
      null,
    ]);
    const lines = text(res).split('\n');
    expect(lines).toContain('  obsolescence: outdated');
    expect(lines).toContain('  note: Superseded.');
    // Exactly one marked row → exactly one mark line.
    expect(lines.filter((l) => l.includes('obsolescence:'))).toHaveLength(1);
  });

  it('skeleton: the mark on every row, never the note', async () => {
    const fx = await makeWorkItemFixture();
    const marked = await mk(fx, 'Marked');
    const current = await mk(fx, 'Current');
    await mark(fx, marked.id, 'deprecated', 'Retired.');

    const res = await runSkeleton({ projectKey: 'PROD' }, fx.ctx);
    const items = (res.structuredContent as { items: Marked[]; total: number }).items;
    expect(items).toHaveLength(2);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(marked.id)!.obsolescence).toBe('deprecated');
    expect(byId.get(current.id)!.obsolescence).toBeNull();
    for (const row of items) expect(Object.keys(row)).not.toContain('obsolescenceNoteMd');
  });

  it('list_ready and next_ready rows carry both — a LEGACY marked open card stays in the ready set', async () => {
    const fx = await makeWorkItemFixture();
    const task = await mk(fx, 'Ready but outdated');
    // No door may mark an open card since MOTIR-6672, but a row marked before that
    // rule is not migrated, and the ready reads must still carry its mark.
    await adminDb.workItem.update({
      where: { id: task.id },
      data: { obsolescence: 'outdated', obsolescenceNoteMd: 'Check the new spec first.' },
    });

    const listed = (
      (await runListReady({ projectKey: 'PROD' }, fx.ctx)).structuredContent as {
        items: Marked[];
      }
    ).items.find((r) => r.id === task.id)!;
    expect([listed.obsolescence, listed.obsolescenceNoteMd]).toEqual([
      'outdated',
      'Check the new spec first.',
    ]);

    const next = (
      (await runNextReady({ projectKey: 'PROD' }, fx.ctx)).structuredContent as {
        item: Marked | null;
      }
    ).item!;
    expect(next.id).toBe(task.id);
    expect([next.obsolescence, next.obsolescenceNoteMd]).toEqual([
      'outdated',
      'Check the new spec first.',
    ]);
  });
});

describe('obsolescenceLines', () => {
  it('prints nothing on an unmarked card, and the mark alone when there is no note or successor', () => {
    expect(obsolescenceLines({ obsolescence: null, obsolescenceNoteMd: 'x' })).toEqual([]);
    expect(obsolescenceLines({ obsolescence: 'deprecated', obsolescenceNoteMd: null })).toEqual([
      'obsolescence: deprecated',
    ]);
    expect(
      obsolescenceLines({
        obsolescence: 'outdated',
        obsolescenceNoteMd: '  \n  why  \nmore',
        supersededByKeys: ['PROD-2', 'PROD-3'],
        indent: '  ',
      }),
    ).toEqual(['  obsolescence: outdated — superseded by PROD-2, PROD-3', '  note: why']);
  });

  it('prints no note line when the note is only whitespace (MOTIR-6584)', () => {
    expect(
      obsolescenceLines({ obsolescence: 'outdated', obsolescenceNoteMd: '  \n\t\n ' }),
    ).toEqual(['obsolescence: outdated']);
  });
});

describe('the finished-card refusals are typed on every MCP door (MOTIR-6673)', () => {
  it('update_work_item refuses a mark on an unfinished card with OBSOLESCENCE_REQUIRES_FINISHED', async () => {
    const fx = await makeWorkItemFixture();
    const task = await mk(fx, 'Open');
    const res = await runUpdateWorkItem({ key: task.identifier, obsolescence: 'outdated' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('OBSOLESCENCE_REQUIRES_FINISHED');
    expect(text(res)).toContain(task.identifier);
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: task.id } })).obsolescence,
    ).toBeNull();
  });

  it('transition_status refuses to reopen a marked card with MARKED_CARD_CANNOT_REOPEN and the remedy', async () => {
    const fx = await makeWorkItemFixture();
    const task = await mk(fx, 'Shipped');
    await mark(fx, task.id, 'deprecated', 'Retired.');
    const res = await runTransitionStatus({ key: task.identifier, status: 'in_progress' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('MARKED_CARD_CANNOT_REOPEN');
    expect(text(res)).toContain('clear the mark to reopen this item');
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      'done',
    );
  });

  it('create_work_item and move_to_parent under a marked parent answer MARKED_CARD_CANNOT_REOPEN', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Old story', 'story');
    await mark(fx, story.id, 'outdated', null);

    const created = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'subtask', title: 'New child', parentKey: story.identifier },
      fx.ctx,
    );
    expect(created.isError).toBe(true);
    expect(text(created)).toContain('MARKED_CARD_CANNOT_REOPEN');

    const task = await mk(fx, 'Loose task');
    const moved = await runMoveToParent(
      { key: task.identifier, parentKey: story.identifier },
      fx.ctx,
    );
    expect(moved.isError).toBe(true);
    expect(text(moved)).toContain('MARKED_CARD_CANNOT_REOPEN');
  });
});
