import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { runChangeKind } from '@/lib/mcp/tools/changeKind';
import { runCreateWorkItem } from '@/lib/mcp/tools/createWorkItem';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { runUpdateWorkItem } from '@/lib/mcp/tools/updateWorkItem';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A leaf's DIFFICULTY on the MCP work-item tools (Story MOTIR-6016 ·
// MOTIR-6098) against real Postgres: `create_work_item` and `update_work_item`
// write it, `get_work_item` returns it, and a container is refused with the
// TYPED `DIFFICULTY_NOT_ALLOWED_ON_KIND` — a tool error the agent can act on,
// never an opaque internal error.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Structured = { identifier: string; difficulty: string | null };

describe('difficulty on the MCP work-item tools', () => {
  it('create writes it, get returns it, update changes and clears it', async () => {
    const fx = await makeWorkItemFixture();
    const created = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'Subtle lock work', difficulty: 'high' },
      fx.ctx,
    );
    expect(created.isError).toBeFalsy();
    const dto = created.structuredContent as Structured;
    expect(dto.difficulty).toBe('high');

    const got = await runGetWorkItem({ key: dto.identifier }, fx.ctx);
    expect(got.isError).toBeFalsy();
    expect((got.structuredContent as { item: Structured }).item.difficulty).toBe('high');

    const changed = await runUpdateWorkItem({ key: dto.identifier, difficulty: 'low' }, fx.ctx);
    expect(changed.isError).toBeFalsy();
    expect((changed.structuredContent as Structured).difficulty).toBe('low');

    const cleared = await runUpdateWorkItem({ key: dto.identifier, difficulty: null }, fx.ctx);
    expect(cleared.isError).toBeFalsy();
    expect((cleared.structuredContent as Structured).difficulty).toBeNull();
  });

  it('refuses a difficulty on a story, on create and on update, with the typed code', async () => {
    const fx = await makeWorkItemFixture();
    const refusedCreate = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'story', title: 'A container', difficulty: 'medium' },
      fx.ctx,
    );
    expect(refusedCreate.isError).toBe(true);
    expect(JSON.stringify(refusedCreate.content)).toContain('DIFFICULTY_NOT_ALLOWED_ON_KIND');

    const story = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'story', title: 'A container' },
      fx.ctx,
    );
    const key = (story.structuredContent as Structured).identifier;
    const refusedUpdate = await runUpdateWorkItem({ key, difficulty: 'medium' }, fx.ctx);
    expect(refusedUpdate.isError).toBe(true);
    expect(JSON.stringify(refusedUpdate.content)).toContain('DIFFICULTY_NOT_ALLOWED_ON_KIND');
  });

  it('change_kind refuses a leaf that still carries a difficulty, naming the code', async () => {
    const fx = await makeWorkItemFixture();
    const task = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'Carries one', difficulty: 'medium' },
      fx.ctx,
    );
    const key = (task.structuredContent as Structured).identifier;
    const res = await runChangeKind({ key, kind: 'story' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('DIFFICULTY_NOT_ALLOWED_ON_KIND');
  });
});
