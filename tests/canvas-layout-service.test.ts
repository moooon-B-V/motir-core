import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { canvasLayoutService } from '@/lib/services/canvasLayoutService';
import { canvasNodePositionRepository } from '@/lib/repositories/canvasNodePositionRepository';
import { InvalidCanvasPositionError } from '@/lib/canvasLayout/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ProjectAccessLevel } from '@/generated/prisma/client';
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
  workspaceId: string;
  projectId: string;
}

let seq = 0;
async function makeTenant(label: string, accessLevel?: ProjectAccessLevel): Promise<Tenant> {
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
      ...(accessLevel ? { accessLevel } : {}),
    },
  });
  return { userId: user.id, workspaceId: ws.workspace.id, projectId: project.id };
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

// The PROJECT GATE (Subtask MOTIR-2346). Until this card the arrangement was
// reachable by any signed-in actor whose active project resolved — `session only`
// in the inventory, and mapped to `ai:plan`, a key for operations that spend AI
// credits. It is now `project:browse`, asserted in the service so BOTH the route
// and any future caller inherit it.
describe('canvasLayoutService — the project gate', () => {
  /** A workspace member holding NO project membership, on a PRIVATE project: cannot browse it. */
  async function nonBrowser(t: Tenant, label: string): Promise<Tenant> {
    seq += 1;
    const user = await usersService.createUser({
      email: `canvas-outsider-${label}-${seq}@example.com`,
      password: 'hunter2hunter2',
      name: `Canvas outsider ${label}`,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: t.workspaceId });
    return { userId: user.id, workspaceId: t.workspaceId, projectId: t.projectId };
  }

  it('refuses a READ by an actor who cannot browse the project — as a 404-shaped refusal', async () => {
    const owner = await makeTenant('gate-read', 'private');
    const outsider = await nonBrowser(owner, 'read');
    await expect(canvasLayoutService.getLayout(outsider)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('refuses a SAVE by the same actor, and writes nothing', async () => {
    const owner = await makeTenant('gate-save', 'private');
    const outsider = await nonBrowser(owner, 'save');
    await expect(
      canvasLayoutService.savePositions(outsider, [{ nodeKey: 'discovery', x: 1, y: 2 }]),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    // The gate runs BEFORE the transaction — nothing reached the table.
    expect(
      await canvasNodePositionRepository.findByUserAndProject(outsider.userId, outsider.projectId),
    ).toEqual([]);
  });

  it('still admits an actor who CAN browse it (the gate is not "deny everyone")', async () => {
    const owner = await makeTenant('gate-allow', 'private');
    const saved = await canvasLayoutService.savePositions(owner, [
      { nodeKey: 'discovery', x: 4, y: 5 },
    ]);
    expect(saved.positions).toEqual([{ nodeKey: 'discovery', x: 4, y: 5 }]);
    expect(await canvasLayoutService.getLayout(owner)).toEqual(saved);
  });
});
