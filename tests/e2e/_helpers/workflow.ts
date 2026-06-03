import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';

// Reusable workflow-lifecycle helpers for the Story-2.2 E2E (Subtask 2.2.7).
// Lifted from the inline spec setup so later Stories (boards, list view) that
// need a workflow-seeded fixture can share them — mirrors the lift pattern of
// shell-session.ts / work-item-setup.ts. Re-exports the work-item-setup
// primitives (signUp + createProject) so a spec imports one module.

export { signUp, createProject, type TestUser, type ProjectRef } from './work-item-setup';

/** Create a work item through the `_test` route. Returns its id + seeded status. */
export async function createItem(
  ctx: APIRequestContext,
  projectId: string,
  title: string,
): Promise<{ id: string; status: string }> {
  const res = await ctx.post('/api/_test/work-items', {
    data: { projectId, kind: 'task', title },
  });
  expect(res.status(), `create work item "${title}"`).toBe(201);
  return (await res.json()) as { id: string; status: string };
}

/**
 * Drive the GATED status transition (workItemsService.updateStatus) via the
 * `_test` route's `?status=` path. Returns the raw response so the caller can
 * assert the status code (200 legal / 422 illegal-or-unknown / 404 cross-tenant).
 */
export async function transition(
  ctx: APIRequestContext,
  itemId: string,
  statusKey: string,
): Promise<APIResponse> {
  return ctx.patch(`/api/_test/work-items?id=${itemId}&status=${statusKey}`);
}

/** Add an `is_blocked_by` link: `fromId` is blocked by `toId`. */
export async function linkBlockedBy(
  ctx: APIRequestContext,
  fromId: string,
  toId: string,
): Promise<void> {
  const res = await ctx.post('/api/_test/work-item-links', {
    data: { fromId, toId, kind: 'is_blocked_by' },
  });
  expect(res.status(), 'create is_blocked_by link').toBe(201);
}

/** The readiness verdict for a work item (every blocker terminal). */
export async function isReady(ctx: APIRequestContext, workItemId: string): Promise<boolean> {
  const res = await ctx.get(`/api/_test/work-item-links?workItemId=${workItemId}&ready=1`);
  expect(res.status(), 'ready query').toBe(200);
  return ((await res.json()) as { ready: boolean }).ready;
}
