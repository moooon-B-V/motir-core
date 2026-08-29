import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import {
  seedTodoListFixture,
  readStatus,
  TODO_COMMAND,
  type TodoListFixture,
} from './_helpers/todo-list-seed';

// Story MOTIR-3808 — a work item carries the ORDERED STEPS of its own work
// (MOTIR-3817).
//
// The story's `verification_recipe`, driven in a browser, and its ACCEPTANCE
// RECEIPT. What this story ships is something a person WORKS THROUGH, so the
// proof is a recording of somebody working through it.
//
// ⚠️ PACED FOR A HUMAN, DELIBERATELY (criterion 7). The `beat()`s below are not
// synchronisation — every wait in this spec is on an authoritative signal, and
// the beats sit AFTER those waits so a reviewer can read what just changed. The
// three that matter are named at their call sites: the header's count moving,
// the copy confirmation, and the all-done state. **A later edit that removes
// them to make the spec faster makes the VIDEO useless while leaving every
// assertion green**, which is why this paragraph is here rather than in a
// commit message.
//
// ⚠️ EVERY WAIT IS ON A COMMITTED SIGNAL — the header's `N of M done`, which the
// server computes inside the same transaction as the write it reports. Never on
// the checkbox's optimistic state, and never on a bare timeout.
//
// ⚠️ SELECTORS ARE TEST IDS, not row text: the fixture's wording is a fixture
// detail, and a spec that selects `getByText('Create a restricted key')` breaks
// the day somebody improves the copy.

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

let fx: TodoListFixture;

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  fx = await seedTodoListFixture(page, `todo-pm-${Date.now()}@example.com`);
});

/** The section's committed progress, as the header renders it. */
function progress(page: import('@playwright/test').Page) {
  return page.getByTestId('todo-progress');
}

function rows(page: import('@playwright/test').Page) {
  return page.getByTestId('todo-row');
}

test('a person works a manual card’s to-do list end to end', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-3808');

  const statusBefore = await readStatus(fx, fx.item.identifier);

  await chapter('Open a manual card — its steps are there, in order', async () => {
    await page.goto(`/items/${fx.item.identifier}`);
    await expect(page.getByTestId('todo-list')).toBeVisible();
    // Four steps, one already done — the header says so before anything moves.
    await expect(rows(page)).toHaveCount(4);
    await expect(progress(page)).toHaveText('1 of 4 done');
    await beat();

    // The agent's step is MARKED…
    const agentRow = rows(page).filter({ has: page.getByTestId('todo-executor-agent') });
    await expect(agentRow).toHaveCount(1);
    // …and — asserted NEGATIVELY, which is the whole point of the seam this
    // story ships — offers nothing that runs it. MOTIR-3809 is where that lives.
    await expect(
      page.getByTestId('todo-list').getByRole('button', { name: /run|dispatch/i }),
    ).toHaveCount(0);
    await beat();
  });

  await chapter('Tick a step — the count moves, and it is the SERVER’s count', async () => {
    const second = rows(page).nth(1);
    await second.getByRole('checkbox').click();
    // The authoritative signal: the header's committed number.
    await expect(progress(page)).toHaveText('2 of 4 done');
    await expect(second).toHaveAttribute('data-todo-done', 'true');
    // A beat here because the moving number is the thing a reviewer is watching.
    await beat();
  });

  await chapter('Copy a command — the clipboard gets it exactly', async () => {
    const commandRow = rows(page)
      .filter({ has: page.getByTestId('todo-command') })
      .first();
    await commandRow.getByRole('button', { name: 'Copy command' }).click();
    // The confirmation appearing is NOT the criterion — the value is.
    await expect(commandRow.getByText('Command copied')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TODO_COMMAND);
    await beat();
  });

  await chapter('Add a step — it lands at the end and the total moves', async () => {
    await page.getByTestId('todo-add-input').fill('Rotate the old key');
    await page.getByRole('button', { name: 'Add step' }).click();
    await expect(progress(page)).toHaveText('2 of 5 done');
    await expect(rows(page)).toHaveCount(5);
    await expect(rows(page).nth(4).getByTestId('todo-text')).toHaveText('Rotate the old key');
    await beat();
  });

  await chapter('Move it up two places — and the order SURVIVES A RELOAD', async () => {
    const added = rows(page).nth(4);
    const addedId = await added.getAttribute('data-todo-id');
    await added.getByRole('button', { name: 'Move step up' }).click();
    await expect(rows(page).nth(3)).toHaveAttribute('data-todo-id', addedId!);
    await rows(page).nth(3).getByRole('button', { name: 'Move step up' }).click();
    await expect(rows(page).nth(2)).toHaveAttribute('data-todo-id', addedId!);
    await beat();

    // The reload is the point: it is what separates a persisted move from a
    // client-side one.
    await page.reload();
    await expect(page.getByTestId('todo-list')).toBeVisible();
    await expect(rows(page).nth(2)).toHaveAttribute('data-todo-id', addedId!);
    await beat();
  });

  await chapter('Delete one, through its confirm', async () => {
    const victim = rows(page).nth(4);
    await victim.getByRole('button', { name: 'Delete step' }).click();
    await victim.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(progress(page)).toHaveText('2 of 4 done');
    await expect(rows(page)).toHaveCount(4);
    await beat();
  });

  await chapter('Tick the rest — the list finishes, and the CARD DOES NOT', async () => {
    // Tick every not-yet-done row until the header says the list is complete.
    for (let i = 0; i < 4; i += 1) {
      const row = rows(page).nth(i);
      if ((await row.getAttribute('data-todo-done')) === 'false') {
        await row.getByRole('checkbox').click();
        await expect(row).toHaveAttribute('data-todo-done', 'true');
      }
    }
    await expect(progress(page)).toHaveText('4 of 4 done');
    await expect(page.getByTestId('todo-all-done')).toBeVisible();
    // The state a reviewer is being asked to accept — hold on it.
    await beat();

    // ⚠️ THE CRITERION THAT PROVES THE DECISION SHIPPED. A finished checklist
    // is not a finished card: `docs/decisions/work-item-todo-list.md` §3 refuses
    // a third authority over `work_item.status`, and this is where that refusal
    // is observable rather than argued.
    expect(await readStatus(fx, fx.item.identifier)).toBe(statusBefore);
    // …and the surface offers nothing that would transition it either.
    await expect(
      page.getByTestId('todo-list').getByRole('button', { name: /mark.*done|close|in review/i }),
    ).toHaveCount(0);
    await beat();
  });
});

test('a card with no steps shows the empty state and its invitation', async ({ page }) => {
  await page.goto(`/items/${fx.emptyItem.identifier}`);
  await expect(page.getByTestId('todo-empty')).toBeVisible();
  await expect(page.getByTestId('todo-progress')).toHaveText('0 of 0 done');
  // The invitation, not an apology — and the add affordance is still there.
  await expect(page.getByTestId('todo-add-input')).toBeVisible();
  await expect(page.getByTestId('todo-list')).toHaveCount(0);
});

test('a failed write degrades INSIDE the section, and the page does not blank', async ({
  page,
}) => {
  await page.goto(`/items/${fx.item.identifier}`);
  await expect(page.getByTestId('todo-list')).toBeVisible();

  // Fail the write at the NETWORK boundary — the Server Action POST — rather
  // than by stubbing the client, so the section's own error path is what runs.
  await page.route('**/items/**', async (route) => {
    if (route.request().method() === 'POST') return route.abort('failed');
    return route.fallback();
  });

  await page.getByTestId('todo-row').nth(1).getByRole('checkbox').click();

  // The section says so itself…
  await expect(page.getByTestId('todo-error')).toBeVisible();
  // …and the rest of the page is still standing: the list, and the item's own
  // title outside the section.
  await expect(page.getByTestId('todo-list')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Provision the Stripe restricted key' }),
  ).toBeVisible();
});
