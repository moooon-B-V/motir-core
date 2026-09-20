import { expect, type Locator, type Page } from '@playwright/test';

// DECIDING A STORY'S ACCEPTANCE, THROUGH THE ONE DOOR (Story MOTIR-4949 · Subtask
// MOTIR-5792).
//
// ⚠️ THE ITEM PAGE HAS NO VERBS ANY MORE, and three `cloud-*` specs were still pressing
// them. MOTIR-5229 made the item page HAND THE DECISION OVER — a page shows the question
// and one control that opens the approval overlay, which is the single place a
// `GateDecision` is submitted — and MOTIR-5790 brought the acceptance panel onto that
// contract with every other kind. The panel's own `Approve` / `Request changes` went with
// it.
//
// ⚠️ AND NOTHING CAUGHT IT, because `cloud-*.spec.ts` is SKIPPED on a pull request and
// runs only in the merge queue's at-scale lane. Six tests across three files pressed a
// button that had been gone for four commits, and the first red was an ejection from the
// queue. That is the cost this helper is paid to stop repeating: one place that knows
// where the verbs live, so the next move needs one edit rather than six.
//
// Every wait here is authoritative — a dialog by its role, a control by its name, the
// decided record the frame draws from the action's own response. No timed waits.

/** The item page's live route subtree — scoped, never page-rooted (CLAUDE.md § boundary). */
const detail = (page: Page): Locator => page.getByRole('main');

/**
 * The ACCEPTANCE section card, which is the door this helper means.
 *
 * ⚠️ THE PAGE HAS TWO DOORS TO THE SAME OVERLAY, and a page-rooted read finds both: the
 * acceptance section's call-to-action band, and the STATUS control's held notice — the
 * rail saying the move it owns is a gate's to make (MOTIR-4887, `status-held-notice`).
 * Both are correct and both carry the same address; asking for *a* `Review & approve`
 * link is a strict-mode violation rather than an ambiguity worth resolving by `.first()`,
 * because which one a test presses is part of what it is asserting.
 */
export const acceptanceSection = (page: Page): Locator =>
  detail(page)
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Acceptance', exact: true }) });

/**
 * Open the approval overlay from the card's call-to-action band.
 *
 * The band is what an AWAITING question this reader may answer renders, in place of the
 * verbs; its control carries a real `href` (so a modified click still opens a tab) and a
 * plain click pushes the overlay's address shallowly.
 */
export async function openAcceptanceOverlay(page: Page): Promise<Locator> {
  await acceptanceSection(page).getByRole('link', { name: 'Review & approve' }).click();
  const overlay = page.getByRole('dialog');
  await expect(overlay).toBeVisible();
  return overlay;
}

/**
 * Decide the story's acceptance question in the overlay and close it, leaving the reader
 * back on the item page — which is where every caller's assertion is.
 *
 * `Approve` confirms; `Request changes` does not (`ApprovalGateControl`'s verb set says
 * which, and only the approving verb carries a confirm step).
 */
export async function decideAcceptanceInOverlay(
  page: Page,
  decision: 'approve' | 'request_changes',
): Promise<void> {
  const overlay = await openAcceptanceOverlay(page);
  const verb = decision === 'approve' ? 'Approve' : 'Request changes';
  await overlay.getByRole('button', { name: verb, exact: true }).click();

  if (decision === 'approve') {
    await overlay.getByRole('button', { name: `Yes, ${verb}`, exact: true }).click();
  }

  // THE AUTHORITATIVE SIGNAL — the frame redraws from the action's OWN response, so the
  // decided record on screen is the server having answered. Waiting on it here is what
  // lets a caller assert about the page underneath without a timed wait of its own.
  await expect(
    overlay
      .getByText('Approved', { exact: true })
      .or(overlay.getByText('Changes requested', { exact: true })),
  ).toBeVisible();

  // Esc closes the overlay by stripping the two parameters it added — a shallow pop, so
  // the page underneath was never re-rendered by the navigation. Whatever it shows next
  // is the decision's own repaint, which is the thing these specs exist to measure.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
