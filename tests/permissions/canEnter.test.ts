import type { ProjectAccessMode } from '@/generated/prisma/client';
import { describe, expect, it } from 'vitest';
import { canEnter } from '@/lib/permissions/resolve';
import { canEnter as canEnterReexport } from '@/lib/projects/access';

// The ONE entry rule (Story MOTIR-6169 · MOTIR-6543; `role-model.md` Q1) over
// every cell of its table: 3 access modes × 5 actors. Written out by hand — a
// table computed from `canEnter` would only prove it agrees with itself.

type Actor = 'manager' | 'added' | 'fullNotAdded' | 'limitedNotAdded' | 'noMembership';

const INPUTS: Record<
  Actor,
  {
    workspaceRole: 'manager' | 'member' | null;
    accessScope: 'full' | 'limited' | null;
    addedToProject: boolean;
  }
> = {
  // A Manager — the org Owner / Admin arrive here as `manager` via composeOwnerReach.
  manager: { workspaceRole: 'manager', accessScope: 'full', addedToProject: false },
  // Added to the project — enters whatever their scope; Limited proves it.
  added: { workspaceRole: 'member', accessScope: 'limited', addedToProject: true },
  fullNotAdded: { workspaceRole: 'member', accessScope: 'full', addedToProject: false },
  limitedNotAdded: { workspaceRole: 'member', accessScope: 'limited', addedToProject: false },
  noMembership: { workspaceRole: null, accessScope: null, addedToProject: false },
};

const TABLE: Array<[Actor, ProjectAccessMode, boolean]> = [
  ['manager', 'members', true],
  ['manager', 'workspace', true],
  ['manager', 'public', true],
  ['added', 'members', true],
  ['added', 'workspace', true],
  ['added', 'public', true],
  ['fullNotAdded', 'members', false],
  ['fullNotAdded', 'workspace', true],
  ['fullNotAdded', 'public', true],
  ['limitedNotAdded', 'members', false],
  ['limitedNotAdded', 'workspace', false],
  ['limitedNotAdded', 'public', false],
  ['noMembership', 'members', false],
  ['noMembership', 'workspace', false],
  ['noMembership', 'public', false],
];

describe('canEnter — the 15 cells', () => {
  it('covers every (actor, mode) pair exactly once', () => {
    expect(new Set(TABLE.map(([a, m]) => `${a}/${m}`)).size).toBe(15);
  });

  it.each(TABLE)('%s on a %s project → %s', (actor, accessMode, expected) => {
    expect(canEnter({ accessMode, ...INPUTS[actor] })).toBe(expected);
  });

  it('is the same function lib/projects/access re-exports', () => {
    expect(canEnterReexport).toBe(canEnter);
  });

  it('a Manager enters even with a Limited scope — scope is never read for a Manager', () => {
    for (const accessMode of ['members', 'workspace', 'public'] as const) {
      expect(
        canEnter({
          accessMode,
          workspaceRole: 'manager',
          accessScope: 'limited',
          addedToProject: false,
        }),
      ).toBe(true);
    }
  });

  it('being added never lets someone with no workspace membership in', () => {
    for (const accessMode of ['members', 'workspace', 'public'] as const) {
      expect(
        canEnter({ accessMode, workspaceRole: null, accessScope: null, addedToProject: true }),
      ).toBe(false);
    }
  });
});
