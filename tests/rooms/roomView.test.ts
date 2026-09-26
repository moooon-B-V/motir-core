import { describe, expect, it, vi } from 'vitest';
import {
  PLAN_ACT_PERMISSIONS,
  RUN_ACT_PERMISSIONS,
  availableRoomViews,
  holdsAnyOf,
  parseRoomView,
  resolveRoomView,
} from '@/lib/rooms/roomView';
import type { PermissionKey } from '@/lib/permissions/catalog';

// Story MOTIR-6179 — the one statement of which view a room serves (design
// MOTIR-6327 § The SWITCH).

describe('parseRoomView', () => {
  it('reads mine / project and treats anything else as absent', () => {
    expect(parseRoomView('mine')).toBe('mine');
    expect(parseRoomView(['project', 'mine'])).toBe('project');
    expect(parseRoomView('everything')).toBeNull();
    expect(parseRoomView(undefined)).toBeNull();
  });
});

describe('availableRoomViews', () => {
  it('Mine follows acting, Project follows the view key — always in that order', () => {
    expect(availableRoomViews({ hasViewKey: true, canAct: true })).toEqual(['mine', 'project']);
    expect(availableRoomViews({ hasViewKey: true, canAct: false })).toEqual(['project']);
    expect(availableRoomViews({ hasViewKey: false, canAct: true })).toEqual(['mine']);
    expect(availableRoomViews({ hasViewKey: false, canAct: false })).toEqual([]);
  });
});

describe('resolveRoomView', () => {
  const never = vi.fn(async () => {
    throw new Error('must not be asked');
  });

  it('serves a requested view the reader has', async () => {
    expect(
      await resolveRoomView({
        requested: 'project',
        available: ['mine', 'project'],
        mineHasRows: never,
      }),
    ).toBe('project');
  });

  it('falls back SILENTLY to the one view a reader has', async () => {
    expect(
      await resolveRoomView({ requested: 'project', available: ['mine'], mineHasRows: never }),
    ).toBe('mine');
    expect(
      await resolveRoomView({ requested: 'mine', available: ['project'], mineHasRows: never }),
    ).toBe('project');
  });

  it('defaults a two-view reader to Mine when Mine has rows, else Project', async () => {
    const both = ['mine', 'project'] as const;
    expect(
      await resolveRoomView({ requested: null, available: both, mineHasRows: async () => true }),
    ).toBe('mine');
    expect(
      await resolveRoomView({ requested: null, available: both, mineHasRows: async () => false }),
    ).toBe('project');
  });

  it('answers null for a reader with no view', async () => {
    expect(
      await resolveRoomView({ requested: 'mine', available: [], mineHasRows: never }),
    ).toBeNull();
  });
});

describe('holdsAnyOf — a room’s act keys (MOTIR-6336 coverage floor)', () => {
  const set = (...keys: PermissionKey[]) => new Set<PermissionKey>(keys);
  it('is true on any one act key, false on none', () => {
    expect(holdsAnyOf(set('ai:decide_plan'), PLAN_ACT_PERMISSIONS)).toBe(true);
    expect(holdsAnyOf(set('work_item:edit'), RUN_ACT_PERMISSIONS)).toBe(true);
    expect(holdsAnyOf(set('project:browse', 'plan:view_any'), PLAN_ACT_PERMISSIONS)).toBe(false);
  });
});
