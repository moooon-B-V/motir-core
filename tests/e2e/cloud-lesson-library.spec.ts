import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedLessonLibrary, type LessonLibrarySeed } from './_helpers/lesson-library-seed';
import { openAiPlanningSettings } from './_helpers/ai-planning-settings';
import { expectSettledVisible } from './_helpers/settle';

// Story MOTIR-3329 — the lesson library, end to end (Subtask MOTIR-3340).
//
// The story's acceptance walk, as a person: an admin opens project settings,
// reaches AI planning, finds the door, opens the library, reads one lesson in
// full — and a non-admin never sees the door at all.
//
// ⚠️ EVERY ARRIVAL IS REACHED BY CLICKING, NEVER BY TYPING A URL — except the
// non-admin step, where a direct navigation IS the case under test. "Can you
// find it" is a real assertion about this feature: a route can resolve perfectly
// while nothing in the interface links to it, and this drill-down has TWO doors
// to get wrong (the card into the list, the row into the detail). Both clicks
// are in the spec, so both doors are verified alongside the rooms.
//
// ── WHAT IS STUBBED, AND WHAT IS NOT ────────────────────────────────────────
//
// Only the motir-ai TRANSPORT (`lib/test-lessons-mock`, E2E_TEST_LESSONS=1 in
// this lane's webServer env). Everything on motir-core's side is real: the
// pages, the permission catalog, `guardSettingsPage`, the `lesson:view` gate and
// the service's own tenant narrowing. So the member's missing door is produced
// by the shipped access path rather than by the stub — which is the only way
// that assertion means anything.
//
// The lessons themselves CANNOT be seeded through a motir-core service: they
// live in motir-ai's database, on the other side of the boundary. The fixture
// file is the seam, and it is rewritten between steps — a project with lessons
// and the same project with none are both real screens.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a role/text landmark
// or a settled navigation. There is no bare timeout in this file.

test.describe.configure({ timeout: 180_000 });

const FIXTURE =
  process.env['MOTIR_AI_LESSONS_FIXTURE_PATH'] ??
  path.join(process.cwd(), 'out', 'e2e-lessons-fixture.json');

const TAKEAWAY = 'Name a sibling by its work-item key, never by description';
const RETIRED_TAKEAWAY = 'Put the migration before the service that reads the column';
const AGED_TAKEAWAY = 'Prefer a service seam over a direct repository call from a route';

/** The library, as motir-ai would answer it. `total` is set ABOVE the page. */
function writeLessons(): void {
  mkdirSync(path.dirname(FIXTURE), { recursive: true });
  writeFileSync(
    FIXTURE,
    JSON.stringify(
      {
        // 12, while only three rows exist — so "View all 12 lessons" can only be
        // right if the door quotes the LIBRARY's total rather than the preview
        // it was handed. The wrong version reads perfectly.
        total: 12,
        retentionDays: 90,
        lessons: [
          {
            id: 'les_key',
            title: TAKEAWAY,
            body: 'A card named the work it depended on in prose instead of naming that work item.',
            why: 'A dependency written as a phrase is invisible to everything that decides what is startable.',
            howToApply: 'Name the work by its key and wire the dependency.',
            kinds: ['story'],
            types: ['code'],
            phases: ['skeleton'],
            sourceRef: 'MOTIR-2848',
            recurrenceCount: 4,
          },
          {
            id: 'les_aged',
            title: AGED_TAKEAWAY,
            types: ['code'],
            recurrenceCount: 2,
            injectionBlock: 'not_recurred',
          },
          {
            id: 'les_off',
            title: RETIRED_TAKEAWAY,
            types: ['migration'],
            injectionBlock: 'disabled',
          },
        ],
      },
      null,
      2,
    ),
  );
}

/** The same project, with nothing learned yet — the common case for weeks. */
function writeEmptyLibrary(): void {
  mkdirSync(path.dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, JSON.stringify({ total: 0, retentionDays: 90, lessons: [] }, null, 2));
}

const railEntry = (page: Page) => page.getByRole('link', { name: 'AI planning' });
const doorCard = (page: Page) => page.getByTestId('lesson-library-card');
const doorLink = (page: Page) => page.getByTestId('lesson-library-link');

// Reaching AI-planning settings the way a person does — by clicking — is
// `_helpers/ai-planning-settings.ts`'s `openAiPlanningSettings`, imported above.
// This spec kept its own third variant of that walk until MOTIR-3692; the
// shared one additionally SETTLES the panel's count, which is what stops the
// transient double-subtree strict-mode violation taking the whole
// `billing-cloud` leg down.
//
// `railEntry` above stays local and UNSCOPED on purpose: the member's step
// asserts it resolves to ZERO, and unscoped is the stronger claim there — no
// such link anywhere on the page, rail or `#main`.

let seed: LessonLibrarySeed;

test.beforeEach(async () => {
  await resetDatabase();
  writeLessons();
  seed = await seedLessonLibrary(`lesson-${Date.now().toString(36)}`);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('an admin reaches the lessons from settings and reads one in full', async ({ page }) => {
  await signIn(page, seed.adminEmail, seed.password);

  // 1 · Project settings → AI planning, by clicking.
  await openAiPlanningSettings(page);

  // 2 · The DOOR is on the page they are already on.
  await expectSettledVisible(doorCard(page));
  await expect(doorCard(page).getByText('What Motir has learned')).toBeVisible();
  // The preview shows takeaways, and the link quotes the LIBRARY total (12) —
  // not the three rows beside it.
  await expect(doorCard(page).getByText(TAKEAWAY)).toBeVisible();
  await expect(doorLink(page)).toContainText('View all 12 lessons');

  // 3 · Through the drawn affordance, not a typed URL.
  await doorLink(page).click();
  await expect(page).toHaveURL(/\/settings\/project\/ai-planning\/lessons$/);
  await expect(page.getByRole('heading', { name: 'What Motir has learned' })).toBeVisible();

  // 4 · The seeded lessons are listed, with the count line.
  await expect(page.getByTestId('lessons-count')).toContainText('12 lessons');
  const rows = page.getByTestId('lesson-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText(TAKEAWAY);
  // Both numbers, as prose.
  await expect(rows.first()).toContainText('seen 4 times');
  // The axes, each carrying its axis name.
  await expect(rows.first()).toContainText('kind');
  await expect(rows.first()).toContainText('story');

  // 5 · Open one and read it — the reasoning, not a summary of it.
  //
  // ⚠️ The row's LINK, not the row. Since MOTIR-3346 the row is a CONTAINER
  // holding the link and the retire button as siblings (a `<button>` inside an
  // `<a>` is invalid HTML and axe flags it), so a click at the row's centre is
  // no longer guaranteed to land on the link.
  await rows.first().getByRole('link').click();
  await expect(page).toHaveURL(/\/lessons\/les_key$/);
  await expect(page.getByRole('heading', { name: TAKEAWAY })).toBeVisible();
  for (const label of [
    'What happened',
    'Why it matters',
    'How to apply it',
    'Where it came from',
  ]) {
    await expect(page.getByRole('heading', { name: label })).toBeVisible();
  }
  await expect(page.getByText(/A dependency written as a phrase is invisible/)).toBeVisible();
  // Its provenance, and the state it is in.
  await expect(page.getByText('MOTIR-2848')).toBeVisible();
  await expect(page.getByTestId('lesson-applying')).toBeVisible();

  // 6 · Back the way we came.
  await page.getByTestId('lesson-back').click();
  await expect(page).toHaveURL(/\/settings\/project\/ai-planning\/lessons$/);
});

test('the two not-applied states are told apart on the row', async ({ page }) => {
  // The pair the design draws apart (§L6): a lesson somebody switched off, and
  // one the clock aged out. Both are RETURNED — the point of the surface is what
  // the planner has stopped saying — and each says WHICH in words.
  await signIn(page, seed.adminEmail, seed.password);
  await openAiPlanningSettings(page);
  await doorLink(page).click();

  const aged = page.getByTestId('lesson-row').filter({ hasText: AGED_TAKEAWAY });
  const off = page.getByTestId('lesson-row').filter({ hasText: RETIRED_TAKEAWAY });
  await expect(aged).toContainText('Not seen in 90 days');
  await expect(off).toContainText('Not applied');
  // Neither is mistakable for the other, and neither is hidden.
  await expect(aged).not.toContainText('Not applied');
  await expect(off).not.toContainText('Not seen in');
  // The state is on the row itself, not only in its copy.
  await expect(aged).toHaveAttribute('data-not-applied', 'true');

  // ⚠️ The retire control IS here now — MOTIR-3330 landed it, and this
  // assertion used to read `toHaveCount(0)`: it was the deliberate seam between
  // the two cards. It is INVERTED rather than deleted, because this spec owns
  // the two BADGES and should still notice if a row ever stops carrying the
  // action they sit beside. The action's own behaviour is
  // cloud-lesson-retire.spec.ts.
  await expect(aged.getByRole('button', { name: /Apply again/ })).toHaveCount(1);
  await expect(off.getByRole('button', { name: /Apply again/ })).toHaveCount(1);
});

test('a project with no lessons gets the designed empty screen, not a blank panel', async ({
  page,
}) => {
  writeEmptyLibrary();
  await signIn(page, seed.adminEmail, seed.password);
  await openAiPlanningSettings(page);

  // The door is still there — it is how you learn what this is.
  await expectSettledVisible(doorCard(page));
  await doorLink(page).click();

  await expect(page.getByText("Motir hasn't learned anything here yet")).toBeVisible();
  // It EXPLAINS rather than apologising: what would appear, and where the switch
  // that stops it lives.
  await expect(page.getByText(/Motir writes down the correction/)).toBeVisible();
  await expect(page.getByText(/Recording can be switched off/)).toBeVisible();
  await expect(page.getByTestId('lesson-row')).toHaveCount(0);
});

test('a non-admin never sees the door, and the route refuses a typed URL', async ({ page }) => {
  // The negative half of the story, with a REAL member session.
  //
  // ⚠️ WHERE THE MEMBER IS ACTUALLY STOPPED, stated so this test is not read as
  // proving more than it does. Two gates stand in front of the library and the
  // member fails the FIRST: the AI-planning settings AREA is `ai:configure`
  // (the registry entry's key), which no built-in role but `admin` holds — so a
  // member never reaches the page that carries the door. The narrower
  // `lesson:view` gate is what separates them for a CUSTOM role, and it is
  // asserted where a custom role is cheap to build:
  // `tests/permissions/lessonLibraryKeys.test.ts` resolves exactly that role,
  // and `tests/ai/projectLessons.test.ts` proves the service refuses before it
  // calls motir-ai.
  //
  // What this test is for is the product-level claim: a non-admin cannot find
  // this, AND cannot reach it by typing the URL. Hiding is presentation and
  // never protection, so both halves are asserted — the second is the one that
  // would still fail if only the first were implemented.
  await signIn(page, seed.memberEmail, seed.password);

  // 1 · The rail does not offer the area at all.
  await page.goto('/settings/project');
  await expect(railEntry(page)).toHaveCount(0);

  // 2 · Nor does typing the address work — neither the area's own page…
  await page.goto('/settings/project/ai-planning');
  await expect(doorCard(page)).toHaveCount(0);

  // …nor the library behind it.
  await page.goto('/settings/project/ai-planning/lessons');
  await expect(page.getByTestId('lesson-row')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What Motir has learned' })).toHaveCount(0);

  // 3 · And the DETAIL route, by a real lesson id the admin can open — so this
  // is a refusal, not a 404 for an id that happens not to exist.
  await page.goto('/settings/project/ai-planning/lessons/les_key');
  await expect(page.getByRole('heading', { name: TAKEAWAY })).toHaveCount(0);
});
