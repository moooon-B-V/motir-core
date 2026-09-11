import { test, expect, type Page } from '@playwright/test';

import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  seedDesignApproval,
  servePublishedMock,
  type DesignApprovalSeed,
} from './_helpers/design-approval-seed';

// THE GUARD FOR *DECIDING A GATE REPAINTS THE PAGE* (Bug MOTIR-5118).
//
// ⚠️ THE DEFECT IS INTERMITTENT, AND THAT IS THE MOST IMPORTANT THING TO KNOW
// BEFORE READING A GREEN RUN OF THIS FILE. Approving a `design_result` gate left
// the core-fields rail reading `In Progress` and the record band's `Files kept`
// line absent until a reload. Driven on the UNFIXED code it did not reproduce at
// all in the main lane, reproduced in the acceptance lane on one run of two, and
// failed there at exactly the reported assertion with the full 20 s budget. So a
// green run of these two tests is not by itself evidence the defect is gone —
// the diagnosis below is, and it came from the trace rather than from a re-run.
//
// ⚠️ WHAT THE TRACE SAYS, AND WHY THE CARD'S ROOT CAUSE NEEDED SHARPENING. The
// card said `router.refresh()` "does not reach" the server surfaces. It reaches
// them; it is just not sufficient. In the failing run the decide action POSTs at
// `14:23:14.429` and returns 200 in 95 ms, and the refresh GETs
// `/items/GATE-2?_rsc=…` at `14:23:14.526` and returns 200 in 113 ms — and the
// rail still read `In Progress` twenty seconds later, next to a frame reading
// `Approved`. The action's response carried no revalidation, so the fresh tree
// arrived on a SECOND apply, and that apply is what intermittently goes missing.
// The fix puts the tree on the action's own response (`revalidatePath`), where
// nothing can race it; the client `router.refresh()` stays beside it.
//
// ⚠️ AND THE GUARD IS PROVEN ABLE TO GO RED, which a guard written against an
// intermittent defect otherwise cannot claim: deleting the one `router.refresh()`
// line in `DesignResultSection.onDecide` fails test 1 at the rail assertion
// (`Done` never appears, 5 s) and leaves test 2 green — exactly the asymmetry
// the pair is for. That is a deliberate break of the CLIENT half; the server
// half is covered by the same assertion, and by the acceptance receipt, which
// drops the `page.reload()` this defect put there.
//
// ⚠️ WHY IT IS A BROWSER TEST. Nothing here is visible to a database read: the
// decide transaction writes `work_item.status = 'done'` and `completed_at`
// correctly, and every card the design was blocking becomes ready in the same
// millisecond — that was never in doubt, on the reporter's run either. Only an
// assertion taken in a real browser, on a page nobody reloaded, can see it.
//
// ⚠️ NO `page.reload()` ANYWHERE IN THIS FILE, ON PURPOSE. A reload is an
// authoritative committed-state read, and committed state is exactly what this
// guard is NOT about. Adding one to steady a flake here would delete the
// detector — which is the mistake this whole card exists to undo one lane over.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is an element's own
// visible state. The frame's state pill is rendered from the gate row the decide
// action RETURNED (`setCurrent(result.gate)`), so it is the authoritative signal
// that the server recorded the decision — and it is what each assertion about
// the SERVER-rendered surfaces waits behind. There is no `waitForTimeout`.
//
// THE PAIR IS THE POINT. Approving is TERMINAL for `design_result`, so the rail
// must MOVE; requesting changes records a decision and settles nothing, so the
// rail must STAY. A blanket refresh passes the first and a page that never
// repaints passes the second — only both together say the surfaces are routed by
// what they actually show.

/** The detail rail's Status field card — the Pill beside the "Edit Status"
 *  chevron, scoped so an activity-log mention of the same label can't match
 *  (the `status-derivation.spec.ts` / `github.spec.ts` precedent). */
function statusCard(page: Page) {
  return page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
}

/** Publish the design, sign the reviewer in, and leave them on the design card
 *  with an AWAITING gate and its verbs on screen. */
async function arriveAtTheGate(
  page: Page,
  baseURL: string,
  seed: DesignApprovalSeed,
): Promise<void> {
  await servePublishedMock(page);

  const client = await openAgentSession(seed.token, baseURL);
  const published = await publishDesignResult(client, seed.designKey);
  expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
  await client.close();

  await signIn(page, seed.reviewerEmail, seed.password);
  await page.goto(`/items/${seed.designKey}`);
  await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();

  // The BEFORE half of every assertion below: the card is In Progress and the
  // question is open. Asserted rather than assumed, so a seed that drifted
  // fails here instead of making the after-state look like a no-op.
  await expect(statusCard(page).getByText('In Progress', { exact: true })).toBeVisible();
  await expect(page.getByText('Awaiting you', { exact: true })).toBeVisible();
}

test.describe('deciding an approval gate repaints the item page in place', () => {
  let seed: DesignApprovalSeed;

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('approving moves the status rail and fills the record band, with no reload', async ({
    page,
    baseURL,
  }) => {
    seed = await seedDesignApproval('repaint-approve');
    await arriveAtTheGate(page, baseURL!, seed);

    await page.getByRole('button', { name: 'Approve' }).click();
    // Approving is TERMINAL for this kind, which is why this verb confirms.
    await expect(page.getByText('Approving this will:')).toBeVisible();
    await page.getByRole('button', { name: 'Yes, Approve' }).click();

    // ⚠️ THE AUTHORITATIVE SIGNAL — the frame's own state, reconciled from the
    // decide action's response. Everything after this line is a claim about a
    // SERVER-rendered surface that the same decision moved.
    await expect(page.getByText('Approved', { exact: true })).toBeVisible();

    // The page-state contract's case 2 (`motir-core/CLAUDE.md`). The rail is a
    // Server-Component surface elsewhere on the page; the decision changed it,
    // so the decision owes it a repaint. This is the assertion the defect failed
    // and the one that goes red when either half is removed.
    await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible();
    await expect(statusCard(page).getByText('In Progress', { exact: true })).toHaveCount(0);

    // The record band's `Files kept` line. It reads the gate's
    // SUBJECT, which is a server prop (`DesignResultSection`'s `subject`) and is
    // null until the server re-renders: the reassurance that the approved bytes
    // were pinned, arriving in the moment it is earned rather than after a
    // reload.
    await expect(page.getByText('Files kept')).toBeVisible();
  });

  test('requesting changes records the decision and the status rail does NOT move', async ({
    page,
    baseURL,
  }) => {
    seed = await seedDesignApproval('repaint-changes');
    await arriveAtTheGate(page, baseURL!, seed);

    // A reversible act asked twice is friction rather than care, so this verb
    // does not confirm — one press is the whole decision.
    await page.getByRole('button', { name: 'Request changes' }).click();
    await expect(page.getByText('Changes requested', { exact: true })).toBeVisible();

    // Sending a design back feeds the revise loop; it settles
    // nothing, so the card stays exactly where it was. This is the half a
    // blanket refresh would also pass — it is here to say that the repaint
    // renders what the server actually holds rather than what the press implied.
    await expect(statusCard(page).getByText('In Progress', { exact: true })).toBeVisible();
    await expect(statusCard(page).getByText('Done', { exact: true })).toHaveCount(0);
    // Only an approval pins the bytes, so there is no `Files kept` line to draw.
    await expect(page.getByText('Files kept')).toHaveCount(0);
  });
});
