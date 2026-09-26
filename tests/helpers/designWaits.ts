import type { ServiceContext } from '@/lib/workItems/serviceContext';

// A design result is published only while an OPEN work item is `blocked_by` the
// design card (`docs/decisions/design-result.md` AMENDMENT 4 Q2; MOTIR-5491). So
// every test that publishes one first makes something wait on it — through the
// real service, so the edge is the one readiness and the publish gate both read.
//
// The service is imported lazily: the suites that call this `vi.mock` the blob
// uploader before their own dynamic imports, and a static import here would pull
// the service graph in ahead of that mock.

/** Create a `task` in the project and wire it `blocked_by` the design card. */
export async function makeWorkWaitOn(
  designItemId: string,
  fx: { projectId: string; ctx: ServiceContext },
  opts: { title?: string; parentId?: string; kind?: 'task' | 'subtask' } = {},
): Promise<{ id: string; key: string }> {
  const { workItemsService } = await import('@/lib/services/workItemsService');
  // Placed as the design card's SIBLING unless the caller names a parent: a
  // `blocked_by` joins two items at the same depth below their nearest common
  // ancestor (MOTIR-6387 / 6411), and a design card usually hangs under a story,
  // so a root task waiting on it would be cross-level.
  let parentId = opts.parentId;
  let kind = opts.kind;
  if (!parentId) {
    const { adminDb } = await import('./adminDb');
    const design = await adminDb.workItem.findUniqueOrThrow({
      where: { id: designItemId },
      select: { parent: { select: { id: true, kind: true } } },
    });
    if (design.parent) {
      parentId = design.parent.id;
      kind ??= design.parent.kind === 'task' || design.parent.kind === 'bug' ? 'subtask' : 'task';
    }
  }
  const dependent = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: kind ?? 'task',
      title: opts.title ?? 'Build to the design',
      ...(parentId ? { parentId } : {}),
    },
    fx.ctx,
  );
  await workItemsService.linkWorkItems(
    { fromId: dependent.id, toId: designItemId, kind: 'is_blocked_by' },
    fx.ctx,
  );
  return { id: dependent.id, key: dependent.identifier };
}

/**
 * {@link makeWorkWaitOn}, but only when nothing is `blocked_by` the card yet — for
 * a suite's `publish()` helper, which republishes onto one card many times.
 */
export async function ensureWorkWaitsOn(
  designItemId: string,
  fx: { projectId: string; ctx: ServiceContext },
): Promise<void> {
  const { adminDb } = await import('./adminDb');
  const existing = await adminDb.workItemLink.count({
    where: { toId: designItemId, kind: 'is_blocked_by' },
  });
  if (existing === 0) await makeWorkWaitOn(designItemId, fx);
}
