import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardSwimlaneGroupBy } from '@prisma/client';
import { db } from '@/lib/db';
import {
  boardsService,
  BOARD_ISSUE_CAP,
  DONE_AGE_WINDOW_DAYS,
  resolveBoardIssueCap,
  resolveDoneAgeWindowDays,
} from '@/lib/services/boardsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { seedLargeBoard } from '../../scripts/seedLargeBoard';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// Subtask 3.5.1 — the at-scale board FIXTURE + cap/Done-age test SEAM. Two
// things, both unit-level against real Postgres (per CLAUDE.md, no mocks):
//
//   1. The SEAM (boardsService.resolve{BoardIssueCap,DoneAgeWindowDays}) reads an
//      env override when set, and falls back to the SHIPPED constants when unset —
//      so production behaviour is byte-for-byte unchanged (the headline guarantee
//      that makes this a test seam, not a behaviour change), while a test run can
//      reach the over-cap / Done-age states cheaply.
//   2. The board-shaped SEED (scripts/seedLargeBoard) yields the documented
//      distribution — every column populated (+ a tall one), many assignee/epic
//      lanes + their catch-alls, all five priority lanes, and a Done-age spread
//      that the projection visibly trims.
//
// It does NOT re-prove the load model itself (3.8.2/3.8.6 own that — the cap
// predicate over 5,000+ rows, the per-column projection, the banner component);
// here the seam lets us reach those states with TENS of rows.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('board load-model test seam (3.5.1)', () => {
  // Guard the process env so a set/unset in one case never leaks into another.
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved['BOARD_ISSUE_CAP_OVERRIDE'] = process.env['BOARD_ISSUE_CAP_OVERRIDE'];
    saved['DONE_AGE_WINDOW_DAYS_OVERRIDE'] = process.env['DONE_AGE_WINDOW_DAYS_OVERRIDE'];
    delete process.env['BOARD_ISSUE_CAP_OVERRIDE'];
    delete process.env['DONE_AGE_WINDOW_DAYS_OVERRIDE'];
  });
  afterEach(() => {
    for (const k of ['BOARD_ISSUE_CAP_OVERRIDE', 'DONE_AGE_WINDOW_DAYS_OVERRIDE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('falls back to the shipped constants when the override env is unset (production unchanged)', () => {
    expect(resolveBoardIssueCap()).toBe(BOARD_ISSUE_CAP);
    expect(resolveDoneAgeWindowDays()).toBe(DONE_AGE_WINDOW_DAYS);
    expect(BOARD_ISSUE_CAP).toBe(5000);
    expect(DONE_AGE_WINDOW_DAYS).toBe(14);
  });

  it('uses the override when set to a positive integer', () => {
    process.env['BOARD_ISSUE_CAP_OVERRIDE'] = '40';
    process.env['DONE_AGE_WINDOW_DAYS_OVERRIDE'] = '3';
    expect(resolveBoardIssueCap()).toBe(40);
    expect(resolveDoneAgeWindowDays()).toBe(3);
  });

  it('ignores a non-positive / non-numeric / empty override and keeps the constant', () => {
    for (const bad of ['0', '-5', 'abc', '', '1.5']) {
      process.env['BOARD_ISSUE_CAP_OVERRIDE'] = bad;
      expect(resolveBoardIssueCap(), `override="${bad}"`).toBe(BOARD_ISSUE_CAP);
    }
  });
});

interface Fixture {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  identifier: string;
  memberIds: string[];
}

async function makeFixture(): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: 'at-scale-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: 'At-scale WS',
    ownerUserId: owner.id,
  });
  const ctx: ServiceContext = { userId: owner.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    identifier: 'BIG',
  });
  // Four members for the assignee lanes.
  const memberIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const m = await usersService.createUser({
      email: `at-scale-m${i}@example.com`,
      password: 'hunter2hunter2',
      name: `Member ${i}`,
    });
    await workspacesService.addMember({ userId: m.id, workspaceId: ws.workspace.id });
    memberIds.push(m.id);
  }
  return { ctx, workspaceId: ws.workspace.id, projectId: project.id, identifier: 'BIG', memberIds };
}

async function setGroupBy(projectId: string, groupBy: BoardSwimlaneGroupBy): Promise<void> {
  await db.board.updateMany({ where: { projectId }, data: { swimlaneGroupBy: groupBy } });
}

// Small, fast distribution — round-robins 18 spread cards over the 6 default
// statuses (3 each) + 30 extras into the tall `in_progress` column.
const SMALL_OPTS = {
  epics: 3,
  storiesPerEpic: 4,
  rootStories: 3,
  tallColumnExtra: 30,
  unassignedEvery: 4,
  doneAgedOutEvery: 2,
};

describe('board-shaped large seed distribution (3.5.1)', () => {
  it('populates every column, with one tall column far above the rest', async () => {
    const fx = await makeFixture();
    const manifest = await seedLargeBoard(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        projectIdentifier: fx.identifier,
        ownerId: fx.ctx.userId,
        memberIds: fx.memberIds,
      },
      SMALL_OPTS,
    );

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    // Every column has cards (none empty) — the whole board is exercised.
    for (const col of board.columns) {
      expect(col.totalCount, `column ${col.name} populated`).toBeGreaterThan(0);
    }
    // The tall column dwarfs every other column (virtualization target).
    const tall = board.columns.find((c) => c.statusKeys.includes(manifest.tallStatusKey))!;
    const others = board.columns.filter((c) => c.id !== tall.id);
    for (const c of others) {
      expect(tall.totalCount, 'tall > others').toBeGreaterThan(c.totalCount);
    }
    expect(tall.totalCount).toBeGreaterThanOrEqual(SMALL_OPTS.tallColumnExtra);
  });

  it('spreads many assignee lanes + an unassigned catch-all', async () => {
    const fx = await makeFixture();
    const manifest = await seedLargeBoard(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        projectIdentifier: fx.identifier,
        ownerId: fx.ctx.userId,
        memberIds: fx.memberIds,
      },
      SMALL_OPTS,
    );
    expect(manifest.assigneeCount).toBe(fx.memberIds.length); // every member used
    expect(manifest.unassignedCount).toBeGreaterThan(0);

    await setGroupBy(fx.projectId, BoardSwimlaneGroupBy.assignee);
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    // One lane per assignee-with-cards + the unassigned catch-all (last).
    expect(board.swimlanes.length).toBeGreaterThanOrEqual(fx.memberIds.length + 1);
    expect(board.swimlanes.some((l) => l.key === BOARD_SWIMLANE_NO_VALUE)).toBe(true);
  });

  it('spreads epic lanes + a no-epic catch-all, and all five priority lanes', async () => {
    const fx = await makeFixture();
    await seedLargeBoard(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        projectIdentifier: fx.identifier,
        ownerId: fx.ctx.userId,
        memberIds: fx.memberIds,
      },
      SMALL_OPTS,
    );

    await setGroupBy(fx.projectId, BoardSwimlaneGroupBy.epic);
    const epicBoard = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(epicBoard.swimlanes.length).toBeGreaterThanOrEqual(SMALL_OPTS.epics + 1);
    expect(epicBoard.swimlanes.some((l) => l.key === BOARD_SWIMLANE_NO_VALUE)).toBe(true);

    await setGroupBy(fx.projectId, BoardSwimlaneGroupBy.priority);
    const prioBoard = await boardsService.getBoard(fx.projectId, fx.ctx);
    // All five priorities are seeded → five priority lanes (priority has no catch-all).
    expect(prioBoard.swimlanes.length).toBe(5);
  });

  it('seeds a Done-age spread the projection visibly trims (rendered < full total)', async () => {
    const fx = await makeFixture();
    const manifest = await seedLargeBoard(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        projectIdentifier: fx.identifier,
        ownerId: fx.ctx.userId,
        memberIds: fx.memberIds,
      },
      SMALL_OPTS,
    );
    expect(manifest.terminalAgedOut).toBeGreaterThan(0);
    expect(manifest.terminalInWindow).toBeGreaterThan(0);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    // A terminal (done/cancelled) column: its FULL count is surfaced, but the
    // aged-out cards (backdated outside the Done-age window) are trimmed from the
    // rendered set — so rendered < total, the age-based window (3.8.2) in action.
    const terminalCols = board.columns.filter((c) =>
      c.statusKeys.some((k) => manifest.terminalStatusKeys.includes(k)),
    );
    expect(terminalCols.length).toBeGreaterThan(0);
    const trimmed = terminalCols.filter((c) => c.cards.length < c.totalCount);
    expect(trimmed.length, 'at least one terminal column is Done-age trimmed').toBeGreaterThan(0);
  });
});
