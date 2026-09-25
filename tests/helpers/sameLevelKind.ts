import { edgeLevel } from '@/lib/workItems/edgeLevel';
import { adminDb } from './adminDb';

/**
 * The kind to give a ROOT blocker created for `blockedId`, so the `blocked_by`
 * a fixture wires is SAME-LEVEL (Story MOTIR-6015 · MOTIR-6369 refuses a
 * cross-level one at every write door). A root has no parent, so the edge also
 * needs no parent edge (MOTIR-6370).
 *
 * For the many fixtures whose blocker is incidental — "something open that
 * gates this item" — and which used to create a root `task` whatever the item
 * was. Fixtures whose subject IS the edge's shape seed it deliberately instead.
 */
export async function sameLevelRootKind(blockedId: string): Promise<'epic' | 'story' | 'task'> {
  const row = await adminDb.workItem.findUniqueOrThrow({
    where: { id: blockedId },
    select: { kind: true },
  });
  const level = edgeLevel(row.kind);
  return level === 'leaf' ? 'task' : level;
}
