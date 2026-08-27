import { expect, type Locator, type Page } from '@playwright/test';
import { expectSettledVisible } from './settle';

// The ONE door onto project settings → AI planning, shared by every cloud spec
// that walks it (MOTIR-3692).
//
// ⚠️ IT EXISTED FOUR TIMES BEFORE THIS FILE, and that is what made one race cost
// a whole day of deploys. `cloud-cadence` and `cloud-lesson-recording` each
// carried their own `openAiPlanningSettings`; `cloud-lesson-library` and
// `cloud-lesson-retire` each carried a `railEntry` variant of the same three
// lines. All four navigate the same way, so all four are exposed to the same
// transient double-subtree strict-mode violation — and the `billing-cloud` leg
// they share fails whichever of them loses the race first, which is why a re-run
// redistributed the failure instead of clearing it. One helper means the
// settling assertion below lands once, for all of them.
//
// TWO defects are closed here, and they are independent:
//
//  1. **The SETTLE.** `waitForURL` resolves on the URL, which the App Router
//     writes BEFORE the old subtree unmounts, so the next assertion can run with
//     both segment subtrees attached. `expectSettledVisible` waits for the count
//     to come back to one; see `_helpers/settle.ts` for why a narrower locator
//     and `.first()` are both wrong here.
//
//  2. **The SCOPED rail entry.** `/settings/project` renders an "AI planning"
//     call-to-action in `#main` as well as the rail row, for a reader whose role
//     reaches few settings areas — so an UNSCOPED
//     `getByRole('link', { name: 'AI planning' })` matches two links and fails
//     strict mode on that one actor. `cloud-lesson-retire` had found this and
//     scoped its own copy; the other three had not, and were one test identity
//     away from the same red for a completely different reason. Scoping here
//     fixes it everywhere at once.

/** The settings rail's own AI-planning row, scoped to the rail (defect 2). */
export const aiPlanningRailEntry = (page: Page): Locator =>
  page.getByLabel('Project settings').getByRole('link', { name: 'AI planning' });

/** The settings panel the AI-planning page renders — the arrival landmark. */
export const aiPlanningPanel = (page: Page): Locator => page.getByTestId('ai-planning-settings');

/**
 * Reach AI-planning settings the way a person does — BY CLICKING, from
 * `/settings/project`, never by typing the URL.
 *
 * Every one of these specs walks the door on purpose: a route can resolve
 * perfectly while nothing in the interface links to it, so the click is part of
 * what is under test and is not a slower `page.goto`.
 *
 * Returns on a SETTLED, rendered panel — an authoritative signal rather than a
 * URL that merely reads right (`CLAUDE.md` § E2E).
 */
export async function openAiPlanningSettings(page: Page): Promise<void> {
  await page.goto('/settings/project');
  await expect(aiPlanningRailEntry(page)).toBeVisible();
  await aiPlanningRailEntry(page).click();
  await page.waitForURL('**/settings/project/ai-planning');
  await expectSettledVisible(aiPlanningPanel(page));
}
