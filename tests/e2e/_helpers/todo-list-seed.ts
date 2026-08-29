// E2E fixture for the Story MOTIR-3808 to-do-list specs (MOTIR-3817).
//
// Stands up the journey's cast and surface: the PM signs up through the real
// browser UI (the page needs a live session) and creates the first project via
// the projects-empty-state CTA, which pins it active; then, server-side through
// the sanctioned test cross-layer reach, two work items —
//
//   * a `manual` card carrying FOUR to-dos, written through the REAL
//     `workItemTodosService` so their `position` keys are the ones the shipped
//     fractional index mints rather than values a fixture invented. One carries
//     a command, one is the agent's, and one is already done — so the walk
//     starts from a partly-done list rather than an empty one.
//   * a SECOND card with NO to-dos, for the empty state.
//
// The to-dos are seeded through the service (not `db.workItemTodo.createMany`)
// deliberately: this journey is about ORDER and PROGRESS, and both are computed
// by the service. A fixture that wrote rows directly would be asserting against
// positions the product never produced.

import { expect, type Page } from '@playwright/test';
import { adminDb } from './db-reset';
import { signUp, createFirstProject } from './shell-session';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';

export const TODO_PASSWORD = 'todo-list-e2e-pass-123';

/** The command the copy step asserts on the clipboard, character for character. */
export const TODO_COMMAND = 'fly secrets set STRIPE_RESTRICTED_KEY=rk_live_x --app motir-core';

export interface TodoListFixture {
  pm: { id: string; name: string; email: string };
  workspaceId: string;
  projectId: string;
  /** The `manual` card with a partly-done list. */
  item: { id: string; identifier: string };
  /** A card with no to-dos at all — the empty state. */
  emptyItem: { id: string; identifier: string };
}

export async function seedTodoListFixture(page: Page, pmEmail: string): Promise<TodoListFixture> {
  await signUp(page, pmEmail);
  await createFirstProject(page, 'Platform');

  const local = pmEmail.split('@')[0]!;
  // ⚠️ `adminDb`, NOT the `db` singleton. A seeding helper that reads through
  // the runtime client neither raises nor works once `motir_app` is the only
  // connection — the write matches nothing and the read returns `[]`, so the
  // spec drives a browser against a database it believes it populated.
  // `tests/rls/test-singleton-statement-guard.test.ts` ratchets the remaining
  // `tests/e2e/**` sites and may only ever fall, so a new helper does not add
  // to them (it went red at 454 > 452 on this branch's first CI run, which is
  // the instrument doing its job).
  const pm = await adminDb.user.findFirst({ where: { email: pmEmail } });
  const ws = await adminDb.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(pm, 'PM user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await adminDb.project.findFirst({ where: { workspaceId: ws!.id } });
  expect(project, 'first project exists').not.toBeNull();

  const ctx = { userId: pm!.id, workspaceId: ws!.id };

  const item = await workItemsService.createWorkItem(
    {
      projectId: project!.id,
      kind: 'task',
      title: 'Provision the Stripe restricted key',
      type: 'manual',
    },
    ctx,
  );

  const emptyItem = await workItemsService.createWorkItem(
    { projectId: project!.id, kind: 'task', title: 'A card with no steps yet' },
    ctx,
  );

  // Written in the order the reader sees them.
  const first = await workItemTodosService.addTodo(
    item.id,
    { text: 'Open the Stripe dashboard', notesMd: '1. Developers → **API keys**' },
    ctx,
  );
  await workItemTodosService.addTodo(
    item.id,
    { text: 'Create a restricted key', commandText: TODO_COMMAND },
    ctx,
  );
  await workItemTodosService.addTodo(
    item.id,
    { text: 'Regenerate the typed client', executor: 'coding_agent' },
    ctx,
  );
  await workItemTodosService.addTodo(item.id, { text: 'Confirm the deploy picked it up' }, ctx);

  // One already done, so the header starts at `1 of 4` and the walk can watch
  // the number MOVE rather than appear.
  await workItemTodosService.setTodoDone(first.todo.id, true, ctx);

  return {
    pm: { id: pm!.id, name: pm!.name, email: pmEmail },
    workspaceId: ws!.id,
    projectId: project!.id,
    item: { id: item.id, identifier: item.identifier },
    emptyItem: { id: emptyItem.id, identifier: emptyItem.identifier },
  };
}

/** The work item's status, read straight from the service — the ADR's assertion. */
export async function readStatus(fx: TodoListFixture, identifier: string): Promise<string> {
  const detail = await workItemsService.getIssueDetail(fx.projectId, identifier, {
    userId: fx.pm.id,
    workspaceId: fx.workspaceId,
  });
  return detail.item.status;
}
