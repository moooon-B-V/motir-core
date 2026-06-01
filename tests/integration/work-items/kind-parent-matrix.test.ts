import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItemKind } from '@prisma/client';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { IllegalParentTypeError } from '@/lib/workItems/errors';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';

// Subtask 1.4.7 — the FULL kind-parent matrix, driven through
// workItemsService.createWorkItem (the service path). repository.test.ts
// already proves the DB trigger fires on the direct-repo path for two cells;
// this file proves the SERVICE pre-flight (assertKindParent) agrees with the
// trigger across EVERY (parentKind, childKind) cell — 5 child kinds × {null,
// epic, story, task, bug, subtask} parents = 30 cells. Legal cells must
// succeed; illegal cells must reject with the typed IllegalParentTypeError
// (never a raw Postgres/Prisma error leaking past the service boundary).
//
// Runs against a REAL Postgres (Yue's no-mocks rule). Each cell gets a fresh
// truncated DB (beforeEach) and its own fixture so accumulated rows from one
// cell never perturb another's depth/sibling state.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

const CHILD_KINDS: readonly WorkItemKind[] = ['epic', 'story', 'task', 'bug', 'subtask'];
const PARENT_KINDS: readonly (WorkItemKind | null)[] = [
  null,
  'epic',
  'story',
  'task',
  'bug',
  'subtask',
];

// The expected legal-parent matrix — the spec, written INDEPENDENTLY of the
// service's private ALLOWED_PARENT_KINDS table so this test pins the contract
// rather than mirroring the implementation. `null` (top-level) is legal for
// every kind EXCEPT subtask (a subtask must have a parent).
const ALLOWED_PARENTS: Record<WorkItemKind, ReadonlySet<WorkItemKind>> = {
  epic: new Set<WorkItemKind>([]),
  story: new Set<WorkItemKind>(['epic']),
  task: new Set<WorkItemKind>(['epic', 'story']),
  bug: new Set<WorkItemKind>(['epic', 'story', 'task']),
  subtask: new Set<WorkItemKind>(['story', 'task', 'bug']),
};

function isLegal(child: WorkItemKind, parent: WorkItemKind | null): boolean {
  if (parent === null) return child !== 'subtask';
  return ALLOWED_PARENTS[child].has(parent);
}

/**
 * Build (via the service) a structurally-valid item of the requested kind to
 * serve as a parent, returning its id. Each kind needs a minimal legal
 * ancestor chain: a story needs an epic above it, a subtask needs a
 * story (under an epic), etc. Returns null for the top-level (null-parent)
 * case so the caller can pass it straight through.
 */
async function createParentOfKind(
  fx: WorkItemFixture,
  kind: WorkItemKind | null,
): Promise<string | null> {
  if (kind === null) return null;

  const make = (k: WorkItemKind, title: string, parentId?: string) =>
    workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: k, title, ...(parentId ? { parentId } : {}) },
      fx.ctx,
    );

  switch (kind) {
    case 'epic':
      return (await make('epic', 'P-epic')).id;
    case 'story': {
      const epic = await make('epic', 'P-epic');
      return (await make('story', 'P-story', epic.id)).id;
    }
    case 'task': {
      const epic = await make('epic', 'P-epic');
      return (await make('task', 'P-task', epic.id)).id;
    }
    case 'bug': {
      const epic = await make('epic', 'P-epic');
      return (await make('bug', 'P-bug', epic.id)).id;
    }
    case 'subtask': {
      const epic = await make('epic', 'P-epic');
      const story = await make('story', 'P-story', epic.id);
      return (await make('subtask', 'P-subtask', story.id)).id;
    }
  }
}

describe('kind-parent matrix — service-driven (every cell)', () => {
  for (const parentKind of PARENT_KINDS) {
    for (const childKind of CHILD_KINDS) {
      const legal = isLegal(childKind, parentKind);
      const parentLabel = parentKind ?? 'null (top-level)';
      const verb = legal ? 'allows' : 'rejects';

      it(`${verb} a ${childKind} under ${parentLabel}`, async () => {
        const fx = await makeWorkItemFixture();
        const parentId = await createParentOfKind(fx, parentKind);

        const attempt = workItemsService.createWorkItem(
          {
            projectId: fx.projectId,
            kind: childKind,
            title: `${childKind} under ${parentLabel}`,
            ...(parentId ? { parentId } : {}),
          },
          fx.ctx,
        );

        if (legal) {
          const created = await attempt;
          expect(created.kind).toBe(childKind);
          expect(created.parentId).toBe(parentId);
        } else {
          await expect(attempt).rejects.toBeInstanceOf(IllegalParentTypeError);
        }
      });
    }
  }
});
