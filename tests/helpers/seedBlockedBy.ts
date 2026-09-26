import { adminDb } from './adminDb';

/**
 * Write an `is_blocked_by` edge BELOW every service door (Story MOTIR-6015).
 *
 * The link doors refused a cross-LEVEL edge from MOTIR-6369 until MOTIR-6509
 * (`edge-level-is-position.md` Amendment 2), which made them write it and made
 * `validate_work_item` report it INVALID (`crossLevelEdges`); only the plan
 * gate still refuses one. This helper stays for the fixtures written in that
 * window and for any fixture that must not depend on a door's behaviour. A
 * fixture that asserts `valid` over a cross-level edge now reads `false` — one
 * whose blocker level is merely incidental re-levels the blocker instead.
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
