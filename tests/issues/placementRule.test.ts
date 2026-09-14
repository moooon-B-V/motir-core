import { describe, expect, it } from 'vitest';
import { ISSUE_TYPES, assertValidPlacement, type IssueType } from '@/lib/issues/parentRules';
import { PlacementConflictError } from '@/lib/folders/errors';
import { IllegalParentTypeError } from '@/lib/workItems/errors';

// MOTIR-5407 — the FOLDER-AWARE placement gate, every arm × every kind. Pure
// logic, no DB. The expectations are written from the kind-parent trigger as
// the folder migration re-created it (`20260913090000_folder`), not from the
// implementation: a folder admits any kind, a parent AND a folder is refused,
// and every other placement is the unchanged kind-parent matrix.

const ALLOWED_PARENTS: Record<IssueType, ReadonlySet<IssueType>> = {
  epic: new Set<IssueType>([]),
  story: new Set<IssueType>(['epic']),
  task: new Set<IssueType>(['epic', 'story']),
  bug: new Set<IssueType>(['epic', 'story', 'task']),
  subtask: new Set<IssueType>(['story', 'task', 'bug']),
};

describe('assertValidPlacement', () => {
  for (const child of ISSUE_TYPES) {
    it(`admits a ${child} filed in a folder`, () => {
      expect(() => assertValidPlacement({ parentKind: null, filed: true }, child)).not.toThrow();
    });

    it(`${child === 'subtask' ? 'refuses' : 'admits'} a ${child} at the root, unfiled`, () => {
      const place = () => assertValidPlacement({ parentKind: null, filed: false }, child);
      if (child === 'subtask') expect(place).toThrow(IllegalParentTypeError);
      else expect(place).not.toThrow();
    });

    for (const parent of ISSUE_TYPES) {
      it(`refuses a ${child} under a ${parent} AND in a folder`, () => {
        expect(() => assertValidPlacement({ parentKind: parent, filed: true }, child)).toThrow(
          PlacementConflictError,
        );
      });

      const legal = ALLOWED_PARENTS[child].has(parent);
      it(`${legal ? 'admits' : 'refuses'} a ${child} under a ${parent}, unfiled`, () => {
        const place = () => assertValidPlacement({ parentKind: parent, filed: false }, child);
        if (legal) expect(place).not.toThrow();
        else expect(place).toThrow(IllegalParentTypeError);
      });
    }
  }

  it('carries the PLACEMENT_CONFLICT code', () => {
    try {
      assertValidPlacement({ parentKind: 'story', filed: true }, 'subtask');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PlacementConflictError);
      expect((error as PlacementConflictError).code).toBe('PLACEMENT_CONFLICT');
      expect((error as PlacementConflictError).name).toBe('PlacementConflictError');
    }
  });
});
