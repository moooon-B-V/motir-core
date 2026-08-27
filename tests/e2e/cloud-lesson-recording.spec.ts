import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedLessonLibrary, type LessonLibrarySeed } from './_helpers/lesson-library-seed';
import { openAiPlanningSettings } from './_helpers/ai-planning-settings';
import { expectSettledVisible } from './_helpers/settle';

// Story MOTIR-3331 — "Record planning mistakes", end to end (Subtask MOTIR-3353).
//
// The acceptance walk, as a person: an admin reaches AI planning from settings,
// READS what the setting actually does, switches it off, and the planner stops
// writing things down about their project — while everything they did not ask to
// lose stays.
//
// ⚠️ STEP 4 IS THE STORY. Steps 1–3 prove a boolean round-trips through a form,
// which is true of any setting and worth almost nothing on its own. The claim
// this feature makes is that the switch stops something happening in ANOTHER
// SERVICE, and only a walk that provokes the capture and then looks at the store
// can show it. So the assertion is over the lesson store, never over a UI state.
//
// ── WHAT IS REAL, AND WHAT IS SIMULATED ─────────────────────────────────────
//
// Real: the settings page, the permission catalog, `guardSettingsPage`, the
// PATCH, `projectAiSettingsService`, the nullable column and its default,
// `resolveRecordPlanningMistakesForJob` reading it back at submit time, the real
// `motirAiClient` serializing the envelope, and the real `/api/ai/replan` route
// and service behind the pass.
//
// Simulated: motir-ai's own decision, because motir-ai does not run in this lane.
// `lib/test-lessons-mock` answers `POST /v1/jobs` and applies the SAME gate
// motir-ai applies — absent means on, only an explicit `false` disables —
// appending to the store when it is allowed to. That gate has its own tests over
// there (`lessonCaptureConsent`, `lessonCaptureEnvelopeContract`).
//
// So what only THIS spec can prove is the part in between: that the switch a
// person flips in the interface reaches the wire. A store that grows when the
// setting is on and does not when it is off is that property, observed from the
// outside.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a role/text landmark
// or a settled navigation. There is no bare timeout in this file.

test.describe.configure({ timeout: 180_000 });

// ⚠️ THE SPEC AND THE SERVER MUST NAME THE SAME FILE, and the lane decides which.
// `playwright.cloud.config.ts` hands the webServer a HARDCODED
// `<repo>/out/e2e-lessons-fixture.json` — it does not forward this env var — so a
// runner that resolved a different path would read a store the server never
// writes, and "no new row" would pass because nothing could ever have written
// one. The env var is honoured first for a lane that sets BOTH; otherwise this
// resolves to exactly the config's path.
const FIXTURE =
  process.env['MOTIR_AI_LESSONS_FIXTURE_PATH'] ??
  path.join(process.cwd(), 'out', 'e2e-lessons-fixture.json');

const EXISTING_TAKEAWAY = 'Name a sibling by its work-item key, never by description';

interface StoreRow {
  id: string;
  title: string;
}

/** The store as it stands — the same file motir-ai's seam reads and writes. */
function readStore(): StoreRow[] {
  try {
    return (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { lessons?: StoreRow[] }).lessons ?? [];
  } catch {
    return [];
  }
}

/** Seed the store with ONE lesson this project already had. */
function seedStore(): void {
  mkdirSync(path.dirname(FIXTURE), { recursive: true });
  writeFileSync(
    FIXTURE,
    JSON.stringify({
      retentionDays: 90,
      lessons: [
        {
          id: 'les_existing',
          title: EXISTING_TAKEAWAY,
          body: 'A card named the work it depended on in prose instead of naming that work item.',
          why: 'A dependency written as a phrase is invisible to what decides readiness.',
          howToApply: 'Name the work by its key and wire the dependency.',
        },
      ],
    }),
  );
}

/**
 * Pin the active WORKSPACE after signing in.
 *
 * The pages resolve their workspace happily enough, but `/api/ai/replan` goes
 * through `getWorkspaceContext`, which reads the `workspace_id` cookie and falls
 * back to "the user's first workspace" when it is unset — ambiguous the moment an
 * actor holds more than one, which a seeded member can. The UI keeps this cookie
 * in sync in real use, so pinning it is matching real app state rather than
 * working around anything.
 */
async function pinWorkspace(page: Page, seed: LessonLibrarySeed): Promise<void> {
  await page
    .context()
    .addCookies([
      { name: 'workspace_id', value: seed.workspaceId, domain: 'localhost', path: '/' },
    ]);
}

// Reaching AI-planning settings BY CLICKING, never by typing the URL, is
// `_helpers/ai-planning-settings.ts`'s `openAiPlanningSettings`, imported above
// — one copy for every spec that walks this door (MOTIR-3692).

const recordSwitch = (page: Page) => page.getByRole('switch', { name: 'Record planning mistakes' });

/**
 * Run a planning pass — a RE-PLAN of the seeded story, through the app's own
 * endpoint from the signed-in page context.
 *
 * Driven as a request rather than through the row menu deliberately: the door
 * itself is MOTIR-910's subject and is walked by `cloud-augment-replan`, and
 * what this spec needs is the SUBMIT — the whole real chain from the stored
 * setting to the serialized envelope. Nothing about the request is faked; it is
 * the same call the menu item makes, with the same session.
 */
async function runPlanningPass(page: Page, seed: LessonLibrarySeed): Promise<void> {
  const res = await page.request.post('/api/ai/replan', {
    // `itemKey`, which is what the route requires — the same argument the row
    // menu sends.
    data: { itemKey: seed.storyKey },
  });
  expect(res.ok(), `re-plan submit failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

test.beforeEach(async () => {
  await resetDatabase();
  seedStore();
});

test('the setting reads ON by default, explains itself, and switching it off stops capture', async ({
  page,
}) => {
  const seed = await seedLessonLibrary(`lesson-rec-${Date.now()}`);
  await signIn(page, seed.adminEmail, seed.password);
  await pinWorkspace(page, seed);

  // ── 1–2 · Reach it from settings, and find it ON with its explanation ──────
  await openAiPlanningSettings(page);

  // By ROLE, not by text: 'Planning mistakes' is a substring of the toggle's own
  // label ('Record planning mistakes'), so a text locator resolves to two nodes
  // and fails strict mode.
  await expect(page.getByRole('heading', { name: 'Planning mistakes' })).toBeVisible();
  // ON for a project that has never touched the setting — and NOT because a row
  // was written for it: the column is null and the read resolves it.
  await expect(recordSwitch(page)).toHaveAttribute('aria-checked', 'true');

  // The explanation is the deliverable, so the walk READS it. All five points,
  // including the one most likely to be dropped for being unflattering.
  // SETTLED, not merely visible: this is the assertion that lost the race in
  // MOTIR-3692 — a strict `toBeVisible()` here THROWS on the transient second
  // segment subtree instead of retrying it, so the retry fails identically.
  const explanation = page.getByTestId('ai-planning-record-mistakes-explanation');
  await expectSettledVisible(explanation);
  await expect(explanation).toContainText('the correction itself');
  await expect(explanation).toContainText('never shared with any other');
  await expect(explanation).toContainText('the same mistake is less likely twice');
  await expect(explanation).toContainText('Turn this off');
  await expect(explanation).toContainText('keeps applying until you stop it');
  // Point five — the list is one step away.
  await expect(page.getByTestId('ai-planning-record-mistakes-lessons-link')).toBeVisible();

  // ── 3 · Switch it off; reload and confirm it STAYED off ───────────────────
  await recordSwitch(page).click();
  await page.getByTestId('ai-planning-save').click();
  await expect(page.getByText('AI planning settings saved')).toBeVisible();

  await page.reload();
  await expect(recordSwitch(page)).toHaveAttribute('aria-checked', 'false');

  // ── 4 · Provoke a capture, and look at the STORE ───────────────────────────
  //
  // FIRST prove the store this spec reads is the one the SERVER writes — the
  // seeded lesson must be visible through the product. Without this, "no new
  // row" would pass just as well against a file nothing writes, which is the
  // one way this assertion can be silently worthless.
  const before = readStore();
  expect(before.length, 'the seeded store must be non-empty before the pass').toBe(1);
  await runPlanningPass(page, seed);

  const after = readStore();
  // NO NEW ROW. Asserted against the store, not against anything on screen —
  // the whole claim is about another service, and a UI assertion could not see
  // it either way.
  expect(after.map((l) => l.id)).toEqual(before.map((l) => l.id));

  // ── What OFF leaves alone ─────────────────────────────────────────────────
  // The lesson this project already had is still there and still applied. A
  // person switching capture off has not asked to lose what it already learned.
  expect(after.some((l) => l.title === EXISTING_TAKEAWAY)).toBe(true);
  await page.getByTestId('ai-planning-record-mistakes-lessons-link').click();
  await expect(page.getByRole('heading', { name: 'What Motir has learned' })).toBeVisible();
  await expect(page.getByText(EXISTING_TAKEAWAY)).toBeVisible();

  // ── 5 · Switch it back on; the SAME pass records one ───────────────────────
  await openAiPlanningSettings(page);
  await recordSwitch(page).click();
  await page.getByTestId('ai-planning-save').click();
  await expect(page.getByText('AI planning settings saved')).toBeVisible();

  const beforeOn = readStore();
  await runPlanningPass(page, seed);
  const afterOn = readStore();

  // The pass that recorded nothing a moment ago now records. Same project, same
  // pass — the setting is the only thing that changed, which is what makes step
  // 4's silence evidence rather than an absence of anything happening.
  expect(afterOn.length).toBe(beforeOn.length + 1);
});

test('a non-admin cannot change the setting — the page itself refuses', async ({ page }) => {
  const seed = await seedLessonLibrary(`lesson-rec-member-${Date.now()}`);
  await signIn(page, seed.memberEmail, seed.password);
  await pinWorkspace(page, seed);

  // A DIRECT navigation IS the case under test here, as in the sibling walk: the
  // question is what a member gets when they go there anyway, not whether the
  // rail offers it.
  await page.goto('/settings/project/ai-planning');

  // ⚠️ THE REFUSAL IS AT THE PAGE, not at the control — and that is stronger
  // than the disabled-toggle shape this test was first written for. The whole
  // AI-planning destination is gated on `ai:configure`
  // (`lib/settings/projectSettingsNav.ts`), so a project member never reaches
  // the surface at all; the editor's read-only banner is for an actor who CAN
  // open the page and cannot manage, which a member is not. Asserting the real
  // boundary rather than the imagined one is the point of running the walk.
  await expect(page.getByText('Admins only')).toBeVisible();
  await expect(page.getByText(/configured by project admins/)).toBeVisible();

  // And there is no toggle to reach — the setting is not merely un-writable, it
  // is not on the page.
  await expect(recordSwitch(page)).toHaveCount(0);
});
