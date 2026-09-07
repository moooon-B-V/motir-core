// MOTIR-2491 — the `Modal.Body`-bypass class, at the THREE sites an app-wide
// sweep found still clipping.
//
// `Modal`'s panel caps itself at `max-h-[90vh] overflow-hidden`. A call site
// whose content is a bare `<div>` gets a flex item that cannot shrink below its
// content, so on a short viewport the overflow is clipped by the panel and no
// scrollbar appears anywhere: whatever sits at the bottom is unreachable by any
// means. Two earlier instances (MOTIR-462, MOTIR-2488) were each fixed at the
// one reported site; this card measured every `<Modal>` call site at 1280×700
// in its tallest reachable state and found three more. The first is the dashboard's
// Add-widget picker, a 3-column grid that grows a row every third registered
// widget type. At six types and a `md` panel the cards' descriptions wrap to
// five lines, so two rows are already 778px of content in a 628px panel — the
// second row and the Cancel button clipped outside it.
//
// Asserted with `toBeInViewport({ ratio: 1 })`, not `toBeVisible`: a clipped element still
// has a bounding box and answers every role query, which is exactly why all
// three instances passed their own suites — and `ratio: 1` because a footer cut
// three-quarters of the way through still intersects the viewport. Then the widget on the LAST row is
// actually picked, so the fix is proven to keep the surface usable rather than
// merely to put pixels on screen. Fails before the `Modal.Body` wrap; passes
// after. The structural guard that keeps a fourth instance from shipping is
// `tests/theme/modalScrollContainer.test.ts`.
import { test, expect } from '@playwright/test';
import { signUp, signIn, createFirstProject } from './_helpers/shell-session';
import { seedSprintLifecycle } from './_helpers/sprint-lifecycle-seed';
import { resetDatabase } from './_helpers/db-reset';
import { WIDGET_TYPES } from '@/lib/dashboards/widgetRegistry';
import { encodeFilterParam, FILTER_PARAM, type FilterAst } from '@/lib/filters/ast';

// Sign-up + first project + a seeded sprint tree all happen inside each test,
// which is more than the config's 30 s default on a loaded runner.
test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  await resetDatabase();
});

test('the add-widget picker keeps its last row and Cancel reachable in a short viewport', async ({
  page,
}) => {
  await signUp(page, 'modal-scroll-container-e2e@example.com');
  await createFirstProject(page, 'Modal Scroll E2E');

  // Shorter than the 720 default and than any laptop the suite has run on —
  // the same recipe as MOTIR-2488's regression test.
  await page.setViewportSize({ width: 1280, height: 700 });

  await page.goto('/dashboard');
  await page.getByTestId('new-dashboard').click();
  const create = page.getByRole('dialog', { name: 'New dashboard' });
  await create.getByTestId('create-dashboard-name').fill('Short viewport');
  await create.getByTestId('create-dashboard-submit').click();
  await page.waitForURL(/\/dashboard\/[^/]+$/, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Edit' }).click();

  await page.getByTestId('dashboard-add-widget').click();
  const picker = page.getByRole('dialog', { name: 'Add a widget' });
  await expect(picker).toBeVisible();

  // THE TALLEST SHAPE THE PICKER HAS: one card per registered type. The count
  // is read off the registry, not written down, so a story that registers an
  // eighth widget grows this modal — and this test — without touching either.
  const cards = picker.locator('[data-testid^="add-widget-"]');
  await expect(cards).toHaveCount(WIDGET_TYPES.length);

  // The panel obeys its own cap — it grows no further than 90vh (630px here).
  const panel = await picker.boundingBox();
  expect(panel).not.toBeNull();
  expect(panel!.height).toBeLessThanOrEqual(700 * 0.9 + 1);

  // THE REGRESSION: the footer is pinned inside the panel, not clipped below it.
  await expect(picker.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport({
    ratio: 1,
  });

  // And the last row is REACHABLE — it scrolls into view inside the body rather
  // than being cut by the panel's overflow-hidden.
  const last = picker.getByTestId(`add-widget-${WIDGET_TYPES[WIDGET_TYPES.length - 1]}`);
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 1 });

  // It still works: picking it opens that widget's config modal.
  await last.click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByTestId('widget-config-save')).toBeInViewport({ ratio: 1 });
});

// The SECOND site the sweep found clipping. `StartSprintDialog` stacks an
// "already active" alert (only when another sprint is running) on top of a
// custom-duration window (two date pickers, only when Custom is picked) —
// two progressively disclosed rows that no fixture rendered together. Both
// present, at 1280×700 the form is 683px inside a 628px panel and the whole
// footer sits outside it. Same recipe as MOTIR-2488: build the TALLEST shape
// deliberately, assert with `toBeInViewport`, then prove the footer still acts
// (Cancel closes it — Start is disabled by design while another sprint runs).
test('the start-sprint dialog keeps its footer reachable with the active-sprint alert and custom dates', async ({
  page,
}) => {
  const seed = await seedSprintLifecycle('modal-scroll-container-sprint-e2e@example.com');
  await signIn(page, seed.email, seed.password);
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto('/backlog');
  await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });

  const region = (name: string) => page.getByRole('region', { name: new RegExp(`^${name},`) });

  // Start the main sprint so the second one's dialog carries the alert.
  await region(seed.mainSprintName).getByRole('button', { name: 'Start sprint' }).click();
  const first = page.getByRole('dialog', { name: 'Start sprint' });
  await first.getByRole('button', { name: 'Start sprint' }).click();
  await page.waitForURL('**/boards', { timeout: 30_000 });

  await page.goto('/backlog');
  await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });
  await region(seed.secondSprintName).getByRole('button', { name: 'Start sprint' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start sprint' });

  // THE TALLEST SHAPE: the alert names the running sprint, and Custom reveals
  // the two date pickers beneath the duration picker.
  await expect(dialog.getByRole('alert')).toContainText(seed.mainSprintName);
  await dialog.getByRole('group').getByRole('button', { name: 'Custom' }).click();
  await expect(dialog.getByLabel('Start date')).toBeVisible();
  await expect(dialog.getByLabel('End date')).toBeVisible();

  // The panel obeys its own cap.
  const panel = await dialog.boundingBox();
  expect(panel).not.toBeNull();
  expect(panel!.height).toBeLessThanOrEqual(700 * 0.9 + 1);

  // THE REGRESSION: both footer buttons are inside the viewport and the panel.
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const start = dialog.getByRole('button', { name: 'Start sprint', exact: true });
  await expect(start).toBeInViewport({ ratio: 1 });
  await expect(cancel).toBeInViewport({ ratio: 1 });
  await expect(start).toBeDisabled();

  // And the footer still acts.
  await cancel.click();
  await expect(dialog).toBeHidden();
});

// The THIRD site. `EditFilterDialog` stacks the name, a three-row description,
// the two visibility cards and — only when a shared filter is being made
// private — a go-private note. All four present, at 1280×700 the form is 701px
// inside a 628px panel and both footer buttons are outside it. (Its twin,
// `SaveFilterDialog`, is the same shape minus the note and measured 623px
// against a 630px cap, so it took the same `Modal.Body` wrap.)
test('the edit-filter dialog keeps its footer reachable with the go-private note showing', async ({
  page,
}) => {
  await signUp(page, 'modal-scroll-container-filter-e2e@example.com');
  await createFirstProject(page, 'Modal Scroll Filter E2E');
  await page.setViewportSize({ width: 1280, height: 700 });

  // A PROJECT-visible saved filter — the only kind whose edit dialog can show
  // the go-private note.
  const param = encodeFilterParam({
    combinator: 'and',
    conditions: [{ field: 'priority', operator: 'is_none_of', value: ['lowest'] }],
  } as FilterAst);
  await page.goto(`/items?view=list&${FILTER_PARAM}=${encodeURIComponent(param)}`);
  await page.getByRole('button', { name: 'Save as' }).click();
  const save = page.getByRole('dialog', { name: 'Save filter' });
  await save.getByLabel(/Name/).first().fill('Short viewport');
  await save.getByText('Project', { exact: true }).click();
  await save.getByRole('button', { name: 'Save filter' }).click();
  await expect(save).toBeHidden({ timeout: 15_000 });

  await page.goto('/filters');
  await page
    .getByRole('button', { name: /Actions/ })
    .first()
    .click();
  await page.getByRole('menuitem', { name: /^Edit/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel(/Name/).first()).toHaveValue('Short viewport');

  // THE TALLEST SHAPE: switching a shared filter to Private reveals the note.
  await dialog.getByText('Private', { exact: true }).click();
  await expect(dialog.getByText(/private/i).last()).toBeVisible();

  const panel = await dialog.boundingBox();
  expect(panel).not.toBeNull();
  expect(panel!.height).toBeLessThanOrEqual(700 * 0.9 + 1);

  // THE REGRESSION: both footer buttons are inside the viewport and the panel.
  const submit = dialog.getByRole('button', { name: 'Save changes', exact: true });
  await expect(submit).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport({
    ratio: 1,
  });

  // And it still submits — the footer stayed inside the <form>.
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && /saved-filters|filters/.test(r.url()),
  );
  await submit.click();
  expect((await saved).ok()).toBe(true);
});
