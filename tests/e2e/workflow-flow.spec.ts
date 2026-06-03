// E2E: the workflow LIFECYCLE through the real stack (Story 2.2 · Subtask 2.2.7).
//
// @smoke — the Story-closing journey E2E. Complements the BROWSER-UI editing
// spec (workflow-settings.spec.ts, 2.2.5: render / rename / add / toggle / flip)
// by proving the work-item lifecycle end to end over real HTTP: the gated
// transition enforcement (restricted vs open), readiness against the per-project
// terminal set (finding #21), and cross-workspace isolation. Transitions are
// driven through the `_test` route's `?status=` path (workItemsService.
// updateStatus) — the sanctioned surface until Story 2.4 ships an issue-detail
// status control.
//
// Scenarios the card lists that are covered ELSEWHERE (not duplicated here):
//   • workflow render / status rename / add / transition toggle / policy flip
//     → workflow-settings.spec.ts (2.2.5, real browser UI).
//   • delete-protections, atomic initial-status flip, owner-only gate
//     → the vitest suites (management.test.ts), which exercise the same service
//     gate the UI/route call; an owner-only BROWSER check + a two-session
//     atomic-flip RACE are flaky/low-value at the E2E layer, so they stay in
//     vitest (noted in the PR).

import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import {
  signUp,
  createProject,
  createItem,
  transition,
  linkBlockedBy,
  isReady,
} from './_helpers/workflow';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('restricted mode enforces transitions; open mode allows any', async () => {
  const owner = await signUp('e2e-wf-flow@example.com');
  const project = await createProject(owner, 'Flow', 'FLOW');
  const item = await createItem(owner.ctx, project.id, 'Task');
  expect(item.status, 'fresh item lands in the initial status').toBe('todo');

  // Restricted (default): todo→done has no transition row → rejected.
  expect((await transition(owner.ctx, item.id, 'done')).status()).toBe(422);

  // todo→in_progress IS a default edge → allowed.
  const legal = await transition(owner.ctx, item.id, 'in_progress');
  expect(legal.status()).toBe(200);
  expect((await legal.json()).status).toBe('in_progress');

  // An unknown status key → 422 (not a transition issue — it doesn't exist).
  expect((await transition(owner.ctx, item.id, 'nope')).status()).toBe(422);

  // Flip policy to open → in_progress→done (no edge) now succeeds.
  await db.project.update({
    where: { id: project.id },
    data: { workflowPolicyMode: 'open' },
  });
  const open = await transition(owner.ctx, item.id, 'done');
  expect(open.status()).toBe(200);
  expect((await open.json()).status).toBe('done');
});

test('readiness uses the per-project terminal set — a cancelled blocker resolves (finding #21)', async () => {
  const owner = await signUp('e2e-wf-ready@example.com');
  const project = await createProject(owner, 'Ready', 'RDY');
  const x = await createItem(owner.ctx, project.id, 'X');
  const blocker = await createItem(owner.ctx, project.id, 'B');
  await linkBlockedBy(owner.ctx, x.id, blocker.id);

  expect(await isReady(owner.ctx, x.id), 'blocked while blocker is todo').toBe(false);

  // todo→cancelled is a default edge; cancelled is category=done → terminal.
  expect((await transition(owner.ctx, blocker.id, 'cancelled')).status()).toBe(200);
  expect(await isReady(owner.ctx, x.id), 'cancelled blocker counts as resolved').toBe(true);

  // Recategorize cancelled → non-terminal: readiness re-reads the LIVE category.
  await db.workflowStatus.updateMany({
    where: { projectId: project.id, key: 'cancelled' },
    data: { category: 'todo' },
  });
  expect(await isReady(owner.ctx, x.id), 'no longer terminal → blocks again').toBe(false);
});

test('cross-workspace isolation: another workspace cannot transition or read the item', async () => {
  const a = await signUp('e2e-wf-iso-a@example.com');
  const b = await signUp('e2e-wf-iso-b@example.com');
  const projectA = await createProject(a, 'IsoA', 'ISOA');
  const item = await createItem(a.ctx, projectA.id, 'Secret');

  // B's session: a transition AND a read of A's item both 404 (tenant gate
  // fires before any status logic — no existence leak).
  expect((await transition(b.ctx, item.id, 'in_progress')).status()).toBe(404);
  expect((await b.ctx.get(`/api/_test/work-items?id=${item.id}`)).status()).toBe(404);
});
