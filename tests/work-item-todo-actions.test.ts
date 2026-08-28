import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import enMessages from '@/messages/en.json';

// Action-wiring tests for the work item page's To-do list Server Actions
// (Story MOTIR-3808 · MOTIR-3814). They prove the TRANSPORT layer —
// `todoActions.ts` — resolves the workspace context, makes exactly ONE service
// call, revalidates, and maps each typed store error to real catalog copy.
//
// ⚠️ THE SERVICE AND THE DATABASE ARE REAL. The only mocks are the ones the
// vitest environment forces: `getSession` (no cookies), `next/headers`
// (no request scope), `next/cache` (no router), and `next-intl/server`, whose
// stub resolves keys out of the ACTUAL `messages/en.json` — so a test asserting
// "a translated message" is asserting the shipped English string, and a missing
// key fails here rather than shipping as a raw key on the page.
//
// What the card's acceptance criteria ask this file to prove:
//   1  the mapper carries `commandText` / `executor` on its OUTPUT, and a row
//      with no command maps to `null` and not `''`  → 'the DTO on the wire'
//   2  each action returns { ok, todo, progress } | { ok: false, error }, makes
//      ONE service call, and has a covered failure path per typed store error
//      → 'the five actions' and 'error translation'
//   3  each action independently asserts `work_item:edit` — proven with an
//      actor holding `work_item:archive` and NOT `work_item:edit`
//      → 'every action re-checks the permission'
//   4  `progress` is the count committed BY that write  → 'progress'
//   6  `revalidatePath` is called on every write  → 'revalidation'

const sessionState: { user: { id: string; email: string; name: string } | null } = { user: null };

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(async () =>
    sessionState.user ? { user: sessionState.user, session: { token: 't' } } : null,
  ),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => new Headers()),
}));

const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

// A real translator over the shipped catalog: `t('errors.textTooLong', { limit })`
// resolves the actual string and interpolates it, so these assertions break if a
// key is renamed or a placeholder is dropped.
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => {
    const root = (enMessages as Record<string, unknown>)[namespace] as Record<string, unknown>;
    return (key: string, values?: Record<string, string | number>) => {
      const raw = key
        .split('.')
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], root);
      if (typeof raw !== 'string') throw new Error(`missing message: ${namespace}.${key}`);
      return raw.replace(/\{(\w+)\}/g, (_m, name: string) => String(values?.[name] ?? `{${name}}`));
    };
  },
}));

const { db } = await import('@/lib/db');
const { adminDb } = await import('./helpers/adminDb');
const { workItemTodosService } = await import('@/lib/services/workItemTodosService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectMembershipRepository } =
  await import('@/lib/repositories/projectMembershipRepository');
const { CUSTOM_ROLE_TIER } = await import('@/lib/permissions/builtinRoles');
const { createTestUser, makeWorkItemFixture } = await import('./fixtures');
const { addTodoAction, updateTodoAction, moveTodoAction, setTodoDoneAction, deleteTodoAction } =
  await import('@/app/(authed)/items/[key]/todoActions');
const { TODO_COMMAND_MAX_LENGTH, TODO_NOTES_MAX_LENGTH, TODO_TEXT_MAX_LENGTH } =
  await import('@/lib/workItemTodos/limits');
const { toWorkItemTodoDto } = await import('@/lib/mappers/workItemTodoMappers');

const COPY = enMessages.workItemTodos.errors;

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_todo", "work_item_revision", "work_item_link", "work_item", "project_role_definition" RESTART IDENTITY CASCADE',
  );
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "workspace_membership", "workspace", "session", "account", "verification", "user" RESTART IDENTITY CASCADE',
  );
}

beforeEach(async () => {
  await truncateAll();
  revalidatePath.mockClear();
  sessionState.user = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function scenario() {
  const fx = await makeWorkItemFixture();
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Cut the release' },
    fx.ctx,
  );
  sessionState.user = { id: fx.owner.id, email: fx.owner.email, name: fx.owner.name };
  return { fx, cardId: card.id };
}

// ── the DTO on the wire (criterion 1) ───────────────────────────────────────

describe('the DTO on the wire', () => {
  it('carries commandText and executor on the mapped OUTPUT, not merely in the table', async () => {
    const { cardId } = await scenario();
    const result = await addTodoAction({
      workItemId: cardId,
      text: 'Apply the migration',
      commandText: 'pnpm prisma migrate deploy',
      executor: 'coding_agent',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The copy affordance is discharged by a value the client RECEIVES.
    expect(result.todo.commandText).toBe('pnpm prisma migrate deploy');
    expect(result.todo.executor).toBe('coding_agent');
    expect(result.todo).toMatchObject({ done: false, doneAt: null, doneBy: null });
  });

  it('maps a row with no command to null, never to an empty string', async () => {
    const { cardId } = await scenario();
    const result = await addTodoAction({ workItemId: cardId, text: 'Open the console' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.todo.commandText).toBeNull();
    expect(result.todo.commandText).not.toBe('');
  });

  it('the mapper itself normalises an empty-string command to null — asserted directly, because a client tests this field to decide whether to draw a copy button', () => {
    const dto = toWorkItemTodoDto({
      id: 't1',
      workspaceId: 'w',
      workItemId: 'i',
      text: 'A step',
      notesMd: null,
      commandText: '',
      executor: null,
      position: 'a0',
      doneAt: null,
      doneById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(dto.commandText).toBeNull();
    expect(dto.done).toBe(false);
  });

  it('carries the INSTRUCTIONS on the response body, and null when there are none', async () => {
    const { cardId } = await scenario();
    const withNotes = await addTodoAction({
      workItemId: cardId,
      text: 'Create a restricted Stripe key',
      notesMd: '1. Dashboard → Developers → **API keys**\n2. Scope to `charges:write`',
    });
    const without = await addTodoAction({ workItemId: cardId, text: 'Tick this' });

    expect(withNotes.ok && withNotes.todo.notesMd).toContain('**API keys**');
    expect(without.ok && without.todo.notesMd).toBeNull();
  });

  it('the mapper normalises an empty-string notes to null — the client tests this to draw the disclosure', () => {
    const dto = toWorkItemTodoDto({
      id: 't2',
      workspaceId: 'w',
      workItemId: 'i',
      text: 'A step',
      notesMd: '',
      commandText: null,
      executor: null,
      position: 'a0',
      doneAt: null,
      doneById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(dto.notesMd).toBeNull();
  });

  it('resolves doneBy to the USER, so the section can render a name rather than an id', async () => {
    const { fx, cardId } = await scenario();
    const added = await addTodoAction({ workItemId: cardId, text: 'A step' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const ticked = await setTodoDoneAction({ todoId: added.todo.id, done: true });
    expect(ticked.ok).toBe(true);
    if (!ticked.ok) return;
    expect(ticked.todo.done).toBe(true);
    expect(ticked.todo.doneBy).toEqual({ id: fx.owner.id, name: fx.owner.name });
  });
});

// ── the five actions (criterion 2) ──────────────────────────────────────────

describe('the five actions', () => {
  it('each makes EXACTLY ONE service call and returns the written row plus progress', async () => {
    const { cardId } = await scenario();

    const add = vi.spyOn(workItemTodosService, 'addTodo');
    const added = await addTodoAction({ workItemId: cardId, text: 'A' });
    expect(add).toHaveBeenCalledTimes(1);
    add.mockRestore();
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.progress).toEqual({ done: 0, total: 1 });

    const update = vi.spyOn(workItemTodosService, 'updateTodo');
    const updated = await updateTodoAction({ todoId: added.todo.id, text: 'A prime' });
    expect(update).toHaveBeenCalledTimes(1);
    update.mockRestore();
    expect(updated.ok && updated.todo.text).toBe('A prime');

    const move = vi.spyOn(workItemTodosService, 'moveTodo');
    const moved = await moveTodoAction({ todoId: added.todo.id, toIndex: 0 });
    expect(move).toHaveBeenCalledTimes(1);
    move.mockRestore();
    expect(moved.ok).toBe(true);

    const tick = vi.spyOn(workItemTodosService, 'setTodoDone');
    const ticked = await setTodoDoneAction({ todoId: added.todo.id, done: true });
    expect(tick).toHaveBeenCalledTimes(1);
    tick.mockRestore();
    expect(ticked.ok && ticked.progress).toEqual({ done: 1, total: 1 });

    const del = vi.spyOn(workItemTodosService, 'deleteTodo');
    const deleted = await deleteTodoAction({ todoId: added.todo.id });
    expect(del).toHaveBeenCalledTimes(1);
    del.mockRestore();
    expect(deleted.ok && deleted.progress).toEqual({ done: 0, total: 0 });
  });

  it('the update patch is SPARSE end to end: editing the text leaves an untouched command alone', async () => {
    const { cardId } = await scenario();
    const added = await addTodoAction({
      workItemId: cardId,
      text: 'Apply it',
      commandText: 'pnpm migrate',
    });
    if (!added.ok) throw new Error('setup failed');

    const updated = await updateTodoAction({ todoId: added.todo.id, text: 'Apply the migration' });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.todo).toMatchObject({
      text: 'Apply the migration',
      commandText: 'pnpm migrate',
    });

    // …and an EXPLICIT null clears it, which is the distinction the sparse
    // patch exists to preserve.
    const cleared = await updateTodoAction({ todoId: added.todo.id, commandText: null });
    expect(cleared.ok && cleared.todo.commandText).toBeNull();

    // …and the same over the instructions, which are the field a caller is most
    // likely to send alone (MOTIR-1344's assistant writes exactly this one).
    const noted = await updateTodoAction({ todoId: added.todo.id, notesMd: 'Dashboard → keys' });
    expect(noted.ok && noted.todo).toMatchObject({
      notesMd: 'Dashboard → keys',
      text: 'Apply the migration',
    });
  });

  it('refuses every action with the generic message when there is no workspace context', async () => {
    const { cardId } = await scenario();
    const added = await addTodoAction({ workItemId: cardId, text: 'A' });
    if (!added.ok) throw new Error('setup failed');

    sessionState.user = null;
    for (const call of [
      () => addTodoAction({ workItemId: cardId, text: 'x' }),
      () => updateTodoAction({ todoId: added.todo.id, text: 'x' }),
      () => moveTodoAction({ todoId: added.todo.id, toIndex: 0 }),
      () => setTodoDoneAction({ todoId: added.todo.id, done: true }),
      () => deleteTodoAction({ todoId: added.todo.id }),
    ]) {
      expect(await call()).toEqual({ ok: false, error: COPY.generic });
    }
  });
});

// ── error translation (criterion 2's failure paths) ─────────────────────────

describe('error translation', () => {
  it('an empty step returns the catalog`s empty message', async () => {
    const { cardId } = await scenario();
    expect(await addTodoAction({ workItemId: cardId, text: '   ' })).toEqual({
      ok: false,
      error: COPY.empty,
    });
  });

  it('an over-long step returns the granularity message WITH the cap interpolated', async () => {
    const { cardId } = await scenario();
    const result = await addTodoAction({
      workItemId: cardId,
      text: 'x'.repeat(TODO_TEXT_MAX_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(String(TODO_TEXT_MAX_LENGTH));
    // The copy asks for a SPLIT, not for brevity — the bar is about
    // granularity, and the message has to say so or a user just trims words.
    expect(result.error.toLowerCase()).toContain('split');
  });

  it('an over-long command returns its own message with its own cap', async () => {
    const { cardId } = await scenario();
    const result = await addTodoAction({
      workItemId: cardId,
      text: 'Run it',
      commandText: 'x'.repeat(TODO_COMMAND_MAX_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(String(TODO_COMMAND_MAX_LENGTH));
  });

  it('over-long INSTRUCTIONS return their own message, which asks for a card and not a split', async () => {
    const { cardId } = await scenario();
    const result = await addTodoAction({
      workItemId: cardId,
      text: 'A step',
      notesMd: 'x'.repeat(TODO_NOTES_MAX_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(String(TODO_NOTES_MAX_LENGTH));
    expect(result.error).toContain('work item');
    expect(result.error.toLowerCase()).not.toContain('split');
  });

  it('an unknown to-do id returns the not-found message rather than leaking one', async () => {
    await scenario();
    expect(await setTodoDoneAction({ todoId: 'cmno0000000000000000000', done: true })).toEqual({
      ok: false,
      error: COPY.notFound,
    });
    expect(await deleteTodoAction({ todoId: 'cmno0000000000000000000' })).toEqual({
      ok: false,
      error: COPY.notFound,
    });
  });

  it('a cross-workspace card is the SAME not-found message — no existence leak through the action layer', async () => {
    const { cardId } = await scenario();
    const other = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
    const theirs = await workItemsService.createWorkItem(
      { projectId: other.projectId, kind: 'task', title: 'Theirs' },
      other.ctx,
    );
    expect(await addTodoAction({ workItemId: theirs.id, text: 'nope' })).toEqual({
      ok: false,
      error: COPY.notFound,
    });
    // Control: the same call on the caller's OWN card succeeds, so the refusal
    // above is the tenant boundary and not a broken fixture.
    expect((await addTodoAction({ workItemId: cardId, text: 'mine' })).ok).toBe(true);
  });

  it('an UNRECOGNISED error is RETHROWN, not flattened into a generic message', async () => {
    const { cardId } = await scenario();
    const boom = new Error('a bug nobody has a message for');
    const spy = vi.spyOn(workItemTodosService, 'addTodo').mockRejectedValueOnce(boom);
    // A bug that returns `{ ok: false, error: 'Something went wrong' }` is a bug
    // nobody ever reports.
    await expect(addTodoAction({ workItemId: cardId, text: 'A' })).rejects.toThrow(boom);
    spy.mockRestore();
  });
});

// ── the permission (criterion 3) ────────────────────────────────────────────

describe('every action re-checks the permission', () => {
  it('an actor holding `work_item:archive` but NOT `work_item:edit` is refused by all five', async () => {
    const { fx, cardId } = await scenario();
    const seeded = await addTodoAction({ workItemId: cardId, text: 'A step' });
    if (!seeded.ok) throw new Error('setup failed');

    // A CUSTOM role is what makes this actor expressible: the built-in roles
    // pair the two keys, and `work_item:archive` is not implied by
    // `work_item:edit` in either direction (`PERMISSION_IMPLICATIONS` carries
    // only `work_item:delete -> work_item:archive`).
    const archivist = await createTestUser({ email: 'archivist@ex.com', name: 'Archivist' });
    await workspacesService.addMember({ userId: archivist.id, workspaceId: fx.workspaceId });
    const definition = await adminDb.projectRoleDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Archivist',
        permissions: ['project:browse', 'work_item:archive'],
      },
    });
    // The membership has to EXIST before the role definition can be set on it —
    // `setRoleDefinition` is an UPDATE, not an upsert.
    await adminDb.$transaction(async (tx) => {
      await projectMembershipRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          userId: archivist.id,
          role: CUSTOM_ROLE_TIER,
        },
        tx,
      );
      await projectMembershipRepository.setRoleDefinition(
        archivist.id,
        fx.projectId,
        { roleDefinitionId: definition.id, role: CUSTOM_ROLE_TIER },
        tx,
      );
    });
    sessionState.user = { id: archivist.id, email: archivist.email, name: archivist.name };

    // A hidden control is not an authorization: each action is a public HTTP
    // endpoint and each one refuses on its own.
    for (const call of [
      () => addTodoAction({ workItemId: cardId, text: 'nope' }),
      () => updateTodoAction({ todoId: seeded.todo.id, text: 'nope' }),
      () => moveTodoAction({ todoId: seeded.todo.id, toIndex: 0 }),
      () => setTodoDoneAction({ todoId: seeded.todo.id, done: true }),
      () => deleteTodoAction({ todoId: seeded.todo.id }),
    ]) {
      expect(await call()).toEqual({ ok: false, error: COPY.forbidden });
    }

    // And nothing was written: the refusal is the service's, before the write.
    sessionState.user = { id: fx.owner.id, email: fx.owner.email, name: fx.owner.name };
    const list = await workItemTodosService.listTodos(cardId, fx.ctx);
    expect(list.items.map((t) => t.text)).toEqual(['A step']);
    expect(list.items[0]!.done).toBe(false);
  });
});

// ── progress and revalidation (criteria 4 and 6) ────────────────────────────

describe('progress', () => {
  it('is the count COMMITTED by that write — read from the returned envelope, never a follow-up query', async () => {
    const { cardId } = await scenario();
    const a = await addTodoAction({ workItemId: cardId, text: 'A' });
    const b = await addTodoAction({ workItemId: cardId, text: 'B' });
    if (!a.ok || !b.ok) throw new Error('setup failed');

    expect(a.progress).toEqual({ done: 0, total: 1 });
    expect(b.progress).toEqual({ done: 0, total: 2 });

    const ticked = await setTodoDoneAction({ todoId: a.todo.id, done: true });
    expect(ticked.ok && ticked.progress).toEqual({ done: 1, total: 2 });

    // A delete moves the DENOMINATOR, which is why progress rides on every
    // write and not only on the tick.
    const deleted = await deleteTodoAction({ todoId: b.todo.id });
    expect(deleted.ok && deleted.progress).toEqual({ done: 1, total: 1 });
  });
});

describe('revalidation', () => {
  it('every write revalidates the items path, matching commentActions', async () => {
    const { cardId } = await scenario();
    const added = await addTodoAction({ workItemId: cardId, text: 'A' });
    if (!added.ok) throw new Error('setup failed');
    expect(revalidatePath).toHaveBeenCalledWith('/items');

    revalidatePath.mockClear();
    await updateTodoAction({ todoId: added.todo.id, text: 'B' });
    await moveTodoAction({ todoId: added.todo.id, toIndex: 0 });
    await setTodoDoneAction({ todoId: added.todo.id, done: true });
    await deleteTodoAction({ todoId: added.todo.id });
    expect(revalidatePath).toHaveBeenCalledTimes(4);
  });

  it('does NOT revalidate on a refusal — a failed write changed nothing to re-render', async () => {
    const { cardId } = await scenario();
    revalidatePath.mockClear();
    await addTodoAction({ workItemId: cardId, text: '   ' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
