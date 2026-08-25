import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedLessonLibrary, type LessonLibrarySeed } from './_helpers/lesson-library-seed';

// Story MOTIR-3330 — retiring a lesson, end to end (Subtask MOTIR-3348).
//
// The story's acceptance walk, as a person: an admin reaches the library the way
// the design draws it, stops applying a lesson, sees it marked and attributed,
// and brings it back.
//
// ⚠️ WHY THIS NEEDS A BROWSER AT ALL — the NO-FLICKER assertion. A
// revert-on-refresh is invisible to every other kind of test: the mutation
// succeeded, the store is right, and the component would render correctly given
// the right props. The only artifact is a row that visibly changes and changes
// back in front of a person. It exists at this level and nowhere else, and it is
// exactly what the page-state contract's first rule is about — so the row is
// asserted AFTER the `router.refresh()` the control fires has landed, not just
// immediately after the click.
//
// ⚠️ AND STEP 5 IS THE ONE THAT WOULD BE CUT for looking like a duplicate of a
// route test. It is not. The route proves an unauthorised REQUEST is refused;
// this proves a view-only reader gets a COHERENT SCREEN — a list they can read
// with no control they cannot use. Those come apart in the ordinary way: an
// implementation that renders a disabled button, or renders it and fails on
// click, passes every server-side assertion and is a bad experience over a
// correct guard.
//
// It is driven by a CUSTOM role (`viewOnlyEmail`), because every built-in role
// holds both lesson keys or neither — so a walk driven by the built-ins cannot
// tell a surface gated on `lesson:manage` from one gated on `lesson:view`.
//
// ── WHAT IS STUBBED ─────────────────────────────────────────────────────────
// Only the motir-ai TRANSPORT (`lib/test-lessons-mock`). The route, the
// `lesson:manage` gate, the service, the real client and the real page-state
// wiring are all under test. The mock PERSISTS its writes to the fixture file,
// so a re-read after the refresh returns the new state — without that, the
// no-flicker assertion would be measuring the harness.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a role/text landmark,
// a settled navigation, or the mutation's own response. No bare timeouts.

test.describe.configure({ timeout: 180_000 });

const FIXTURE =
  process.env['MOTIR_AI_LESSONS_FIXTURE_PATH'] ??
  path.join(process.cwd(), 'out', 'e2e-lessons-fixture.json');

const LIVE = 'Name a sibling by its work-item key, never by description';
const AGED = 'Prefer a service seam over a direct repository call from a route';

function writeLessons(): void {
  mkdirSync(path.dirname(FIXTURE), { recursive: true });
  writeFileSync(
    FIXTURE,
    JSON.stringify(
      {
        retentionDays: 90,
        lessons: [
          { id: 'les_live', title: LIVE, kinds: ['story'], types: ['code'], recurrenceCount: 4 },
          { id: 'les_aged', title: AGED, types: ['code'], injectionBlock: 'not_recurred' },
        ],
      },
      null,
      2,
    ),
  );
}

// ⚠️ SCOPED TO THE RAIL, unlike the sibling spec's. For a reader whose role
// reaches few settings areas, `/settings/project` ALSO renders an "AI planning"
// call-to-action in `#main`, so an unscoped lookup matches two links and fails
// strict mode — on the one actor this spec exists to exercise, and on no other.
const railEntry = (page: Page) =>
  page.getByLabel('Project settings').getByRole('link', { name: 'AI planning' });
const doorLink = (page: Page) => page.getByTestId('lesson-library-link');
const rowFor = (page: Page, text: string) =>
  page.getByTestId('lesson-row').filter({ hasText: text });

/** Reach the library the way a person does — by clicking, from settings. */
async function openLibrary(page: Page): Promise<void> {
  await page.goto('/settings/project');
  await expect(railEntry(page)).toBeVisible();
  await railEntry(page).click();
  await expect(page.getByRole('heading', { name: 'AI planning' })).toBeVisible();
  await doorLink(page).click();
  await expect(page).toHaveURL(/\/settings\/project\/ai-planning\/lessons$/);
  await expect(page.getByRole('heading', { name: 'What Motir has learned' })).toBeVisible();
}

/**
 * Click the row's action and WAIT FOR THE WRITE — the response, not the paint.
 *
 * Armed before the click so it cannot be missed, and the status is asserted, so
 * a refusal fails here rather than as a confusing assertion three lines later.
 */
async function act(page: Page, button: ReturnType<Page['getByRole']>): Promise<void> {
  const write = page.waitForResponse(
    (r) => /\/lessons\/[^/]+\/applied$/.test(r.url()) && r.request().method() === 'PUT',
  );
  await button.click();
  expect((await write).status()).toBe(200);
}

let seed: LessonLibrarySeed;

test.beforeEach(async () => {
  await resetDatabase();
  writeLessons();
  seed = await seedLessonLibrary(`retire-${Date.now().toString(36)}`);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('an admin stops applying a lesson, sees it attributed, and applies it again', async ({
  page,
}) => {
  await signIn(page, seed.adminEmail, seed.password);
  await openLibrary(page);

  const row = rowFor(page, LIVE);
  await expect(page.getByTestId('lessons-count')).toContainText('1 applied');

  // 1 · The affordance is a LABELLED button, named for its lesson (§L4, §L11) —
  // an unlabelled ban glyph beside a rule reads as "this rule is broken".
  const stop = row.getByRole('button', { name: `Stop applying ${LIVE}` });
  await expect(stop).toHaveCount(1);

  // 2 · Retire it. The row takes the designed treatment immediately, from the
  // response.
  await act(page, stop);
  await expect(row).toContainText('Not applied');
  await expect(row.getByRole('button', { name: `Apply again: ${LIVE}` })).toHaveCount(1);

  // 3 · ⚠️ AND IT DOES NOT FLICKER BACK. The control fires `router.refresh()`
  // for the server-rendered count; the row's own state must survive it. This is
  // the assertion the whole spec exists for, and it can only fail here.
  await expect(page.getByTestId('lessons-count')).toContainText('0 applied');
  await expect(row).toContainText('Not applied');
  // The same, through a genuine reload — the state is real, not just held in a
  // component.
  await page.reload();
  await expect(rowFor(page, LIVE)).toContainText('Not applied');

  // 4 · The detail says WHO switched it off and WHEN.
  await rowFor(page, LIVE).getByRole('link').click();
  await expect(page).toHaveURL(/\/lessons\/les_live$/);
  await expect(page.getByTestId('lesson-override-audit')).toBeVisible();
  await expect(page.getByTestId('lesson-override-audit')).toContainText('Switched off by');
  await expect(page.getByTestId('lesson-not-applied')).toBeVisible();

  // 5 · Bring it back, from the detail's own action.
  const detailAction = page
    .getByTestId('lesson-detail-action')
    .getByRole('button', { name: `Apply again: ${LIVE}` });
  await act(page, detailAction);
  await expect(page.getByTestId('lesson-applying')).toBeVisible();
  await expect(page.getByTestId('lesson-override-audit')).toHaveCount(0);

  // 6 · And the list agrees, on a fresh read.
  await page.getByTestId('lesson-back').click();
  await expect(rowFor(page, LIVE)).not.toContainText('Not applied');
  await expect(page.getByTestId('lessons-count')).toContainText('1 applied');
});

test('“Apply again” on an AGED-OUT row brings it back and the badge goes away', async ({
  page,
}) => {
  // §L6 gives BOTH not-applied rows the same action, and they need OPPOSITE
  // writes: one clears a retirement, the other exempts the row from the clock.
  // The browser sends neither — it sends a boolean, and the server reads the row.
  // What a person sees is one button that does the obvious thing on both.
  await signIn(page, seed.adminEmail, seed.password);
  await openLibrary(page);

  const aged = rowFor(page, AGED);
  await expect(aged).toContainText('Not seen in 90 days');

  await act(page, aged.getByRole('button', { name: `Apply again: ${AGED}` }));

  // The badge's own sentence — "not seen in 90 days" — is a claim about what the
  // planner is being TOLD, and it has stopped being true of this row.
  await expect(aged).not.toContainText('Not seen in 90 days');
  await expect(aged.getByRole('button', { name: `Stop applying ${AGED}` })).toHaveCount(1);
  await page.reload();
  await expect(rowFor(page, AGED)).not.toContainText('Not seen in 90 days');
});

test('a reader with view but NOT manage sees the library and no control at all', async ({
  page,
}) => {
  // The two-key split, as an experience. A custom role holding `lesson:view`
  // (and `ai:configure`, or it would stop at the area gate) — the role
  // MOTIR-3336 exists to make expressible.
  await signIn(page, seed.viewOnlyEmail, seed.password);
  await openLibrary(page);

  // They can READ everything.
  await expect(page.getByTestId('lesson-row')).toHaveCount(2);
  await expect(rowFor(page, LIVE)).toContainText(LIVE);
  await expect(rowFor(page, AGED)).toContainText('Not seen in 90 days');

  // ⚠️ And there is NO control — not a disabled one, not a hidden-then-failing
  // one. A button they cannot use is a worse screen than no button.
  await expect(page.getByRole('button', { name: /Stop applying|Apply again/ })).toHaveCount(0);
  await expect(page.getByTestId('lesson-apply-control')).toHaveCount(0);

  // The DETAIL too — the same reader, the same absence.
  await rowFor(page, LIVE).getByRole('link').click();
  await expect(page.getByRole('heading', { name: LIVE })).toBeVisible();
  await expect(page.getByTestId('lesson-detail-action')).toHaveCount(0);
  // …and they still see the status, because reading is what they may do.
  await expect(page.getByTestId('lesson-applying')).toBeVisible();

  // ⚠️ HIDING IS PRESENTATION, NEVER PROTECTION. The route refuses the same
  // reader independently — asserted through a real request from their session,
  // because that is the boundary a hidden button does not create.
  const refused = await page.request.put(
    `/api/projects/${seed.projectKey}/lessons/les_live/applied`,
    { data: { applied: false } },
  );
  expect(refused.status()).toBe(403);
  expect((await refused.json()).permission).toBe('lesson:manage');
});
