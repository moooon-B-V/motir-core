import { expect, type Locator, type Page } from '@playwright/test';
import en from '@/messages/en.json';

// DECIDING A CARD'S PULL REQUESTS, THROUGH THE ONE DOOR (Bug MOTIR-6323).
//
// ⚠️ THE ITEM PAGE'S DEVELOPMENT SECTION HAS NO VERBS ANY MORE. MOTIR-5229 made the item
// page HAND THE DECISION OVER — the page shows the question and one control into the
// approval overlay, the single place a `GateDecision` is submitted — and the Development
// block was the one section still drawing *Approve and merge* · *Request changes* in place.
// Now an awaiting gate its reader may decide renders the block plus the call-to-action band,
// and the frame with its verbs lives in the overlay. This is the Development twin of
// `acceptance-decide.ts`: one place that knows where the verbs live.
//
// ⚠️ WHAT THE PRESS REMEMBERS STAYS IN THE OVERLAY. A merged or refused member's outcome is
// the press's own response, drawn by the frame that pressed it; the page underneath repaints
// from the server (`router.refresh()`), which knows only what a reload knows — *Queued to
// merge*, a queue exit, the status. So assert a press's outcomes in the returned dialog,
// then close it and assert the page.

/**
 * The item page's Development section card, scoped to the live route subtree.
 *
 * ⚠️ THE PAGE HAS TWO DOORS TO THE SAME OVERLAY: the section's band and the status control's
 * held notice (`acceptance-decide.ts` says why a page-rooted `Review & approve` is a
 * strict-mode violation, not an ambiguity). This helper means the section's.
 */
export const developmentSection = (page: Page, title = en.github.development.title): Locator =>
  page
    .getByRole('main')
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });

/** Open the approval overlay from the Development section's call-to-action band. */
export async function openDevelopmentOverlay(page: Page, messages = en): Promise<Locator> {
  await developmentSection(page, messages.github.development.title)
    .getByRole('link', { name: messages.approvalGate.statusHeld.reviewAndApprove, exact: true })
    .click();
  const overlay = page.getByRole('dialog');
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  return overlay;
}

/**
 * Esc closes the overlay by stripping the parameters it added — a shallow pop. Whatever the
 * page shows next is the decision's own repaint.
 */
export async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
