import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { canvasLayoutService } from '@/lib/services/canvasLayoutService';
import { canvasNodePositionRepository } from '@/lib/repositories/canvasNodePositionRepository';
import { InvalidCanvasPositionError } from '@/lib/canvasLayout/errors';
import { truncateAuthTables } from './helpers/db';

// Real-Postgres tests for the canvas-layout persistence (MOTIR-1237) — the
// per-user-per-project node arrangement. truncateAuthTables truncates `user` /
// `workspace` CASCADE, which clears `canvas_node_position` (its child) too.

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
});

interface Tenant {
  userId: string;
  projectId: string;
}

let seq = 0;
async function makeTenant(label: string): Promise<Tenant> {
  seq += 1;
  const user = await usersService.createUser({
    email: `canvas-${label}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Canvas ${label}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Canvas WS ${label} ${seq}`,
    ownerUserId: user.id,
  });
  const project = await db.project.create({
    data: {
      workspaceId: ws.workspace.id,
      name: `Canvas P ${label}`,
      slug: 'canvas',
      identifier: 'CNV',
    },
  });
  return { userId: user.id, projectId: project.id };
}

describe('canvasLayoutService', () => {
  it('returns an empty layout for a never-arranged project (the auto-layout default)', async () => {
    const t = await makeTenant('empty');
    expect(await canvasLayoutService.getLayout(t)).toEqual({ positions: [] });
  });

  it('persists moved nodes and reloads them (save → load round-trip)', async () => {
    const t = await makeTenant('roundtrip');
    const saved = await canvasLayoutService.savePositions(t, [
      { nodeKey: 'discovery', x: 300, y: 50 },
      { nodeKey: 'vision', x: 300, y: 530 },
    ]);
    expect(saved.positions).toEqual([
      { nodeKey: 'discovery', x: 300, y: 50 },
      { nodeKey: 'vision', x: 300, y: 530 },
    ]);
    // a fresh read sees the committed arrangement
    expect(await canvasLayoutService.getLayout(t)).toEqual(saved);
  });

  it('upserts — re-saving a node updates it in place, never duplicates', async () => {
    const t = await makeTenant('upsert');
    await canvasLayoutService.savePositions(t, [{ nodeKey: 'plan', x: 10, y: 20 }]);
    const after = await canvasLayoutService.savePositions(t, [{ nodeKey: 'plan', x: 999, y: 888 }]);
    expect(after.positions).toEqual([{ nodeKey: 'plan', x: 999, y: 888 }]);
    const rows = await canvasNodePositionRepository.findByUserAndProject(t.userId, t.projectId);
    expect(rows).toHaveLength(1);
  });

  it('RESETS — `remove` drops the given nodes, leaving the rest (and re-saves atomically)', async () => {
    const t = await makeTenant('reset');
    await canvasLayoutService.savePositions(t, [
      { nodeKey: 'epicA', x: 10, y: 10 },
      { nodeKey: 'epicB', x: 20, y: 20 },
      { nodeKey: 'discovery', x: 30, y: 30 }, // a station — untouched by the reset
    ]);
    // reset epicA/epicB AND move discovery in the same call
    const after = await canvasLayoutService.savePositions(
      t,
      [{ nodeKey: 'discovery', x: 99, y: 99 }],
      ['epicA', 'epicB'],
    );
    expect(after.positions).toEqual([{ nodeKey: 'discovery', x: 99, y: 99 }]);
    expect(await canvasLayoutService.getLayout(t)).toEqual(after);
  });

  it('reset of an unknown key is a harmless no-op', async () => {
    const t = await makeTenant('reset-noop');
    await canvasLayoutService.savePositions(t, [{ nodeKey: 'plan', x: 1, y: 2 }]);
    const after = await canvasLayoutService.savePositions(t, [], ['ghost']);
    expect(after.positions).toEqual([{ nodeKey: 'plan', x: 1, y: 2 }]);
  });

  it("isolates per user — one user cannot see another user's arrangement", async () => {
    const a = await makeTenant('iso-a');
    const b = await makeTenant('iso-b');
    await canvasLayoutService.savePositions(a, [{ nodeKey: 'discovery', x: 1, y: 2 }]);
    expect((await canvasLayoutService.getLayout(b)).positions).toEqual([]);
    // and a user's own positions are scoped to the project they were saved in
    expect((await canvasLayoutService.getLayout(a)).positions).toHaveLength(1);
  });

  it('rejects invalid coordinates / keys atomically (nothing persists)', async () => {
    const t = await makeTenant('invalid');
    await expect(
      canvasLayoutService.savePositions(t, [
        { nodeKey: 'ok', x: 1, y: 2 },
        { nodeKey: '', x: 3, y: 4 }, // empty key → reject the whole save
      ]),
    ).rejects.toBeInstanceOf(InvalidCanvasPositionError);
    await expect(
      canvasLayoutService.savePositions(t, [{ nodeKey: 'nan', x: Number.NaN, y: 0 }]),
    ).rejects.toBeInstanceOf(InvalidCanvasPositionError);
    await expect(
      canvasLayoutService.savePositions(t, [{ nodeKey: 'huge', x: 0, y: 5_000_000 }]),
    ).rejects.toBeInstanceOf(InvalidCanvasPositionError);
    // the valid entry in the first call must NOT have been written (atomic)
    expect((await canvasLayoutService.getLayout(t)).positions).toEqual([]);
  });
});
