import { adminDb } from './adminDb';

/**
 * Write an `is_blocked_by` edge BELOW every service door (Story MOTIR-6015).
 *
 * The doors now refuse a cross-LEVEL edge (MOTIR-6367 / MOTIR-6369), but the
 * tree still carries them — 151 were live on the product tenant when the rule
 * shipped — and every reader (readiness, the cascade, the sprint walk, the
 * roadmap) must keep handling one. A fixture whose SUBJECT is how a reader
 * treats such an edge seeds it here, and says why at the call site. A fixture
 * whose blocker kind is merely incidental re-levels the blocker instead.
 */
export async function seedBlockedBy(
  fx: { workspaceId: string; ctx: { userId: string } },
  fromId: string,
  toId: string,
): Promise<void> {
  await adminDb.workItemLink.create({
    data: {
      workspaceId: fx.workspaceId,
      fromId,
      toId,
      kind: 'is_blocked_by',
      createdById: fx.ctx.userId,
    },
  });
}
