import { expect, type Locator, type Page } from '@playwright/test';
import { planRowDestination } from '@/lib/planning/planDestination';
import type { PlanStatusDto } from '@/lib/dto/plans';
import en from '@/messages/en.json';

// OPEN AN UNDECIDED PLAN WHERE IT IS DECIDED — the planning overlay (Story
// MOTIR-7883 · MOTIR-7886).
//
// Once the story lands, a member's bare `/plans/<id>` for a plan that is still
// undecided replace-redirects to `/plans` with the planning overlay open on that
// plan's conversation. A spec that used to `goto` the plan page to read, peek or
// approve an undecided plan comes through here instead, and lands on the overlay
// address directly — so it passes before the redirect merges and after it.
//
// ⚠️ THE ADDRESS HAS ONE AUTHOR. It is composed by `planRowDestination` (and so by
// `withPlanningOverlay`), from the same review read the in-app doors make —
// never by assembling the overlay's query parameters here. The story's
// integration gate guards that, and a helper writing them by hand would be the
// exception it had to carve out.
//
// ⚠️ A DECIDED PLAN DOES NOT COME THROUGH HERE. Its page is a record and still
// renders at `/plans/<id>`; a spec reading one keeps its `goto`. A plan with no
// session is a SEED defect (every shipped path attaches one): fix the seed, do not
// route around it. Both throw, naming the plan's status.

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });

export interface OpenUndecidedPlanOptions {
  /** The page the overlay opens over. Defaults to the Plans list, where the redirect lands. */
  host?: string;
  /** Switch the plan pane to this view after it renders. The overlay never reads `?view=`. */
  view?: 'list' | 'canvas';
  /** How long the overlay's plan pane may take to paint. */
  timeout?: number;
}

/**
 * Open `planId` in the planning overlay, wait until the overlay's plan pane has
 * rendered, and return the overlay's root (the planning workspace dialog). Specs
 * that scoped to the plan page's `main` re-scope to the returned locator.
 */
export async function openUndecidedPlan(
  page: Page,
  planId: string,
  opts: OpenUndecidedPlanOptions = {},
): Promise<Locator> {
  const response = await page.request.get(`/api/plans/${encodeURIComponent(planId)}`, {
    headers: { Accept: 'application/json' },
  });
  expect(response.status(), `the review read for plan ${planId}`).toBe(200);
  const review = (await response.json()) as {
    status: PlanStatusDto;
    conversation: { sessionId: string; targetKeys: string[] } | null;
  };

  const destination = planRowDestination({
    planStatus: review.status,
    planId,
    sessionId: review.conversation?.sessionId ?? null,
    anchorKey: review.conversation?.targetKeys[0] ?? null,
    host: opts.host ?? '/plans',
  });
  if (destination.kind !== 'planning-surface') {
    throw new Error(
      `openUndecidedPlan: plan ${planId} is ${review.status} ` +
        `${review.conversation ? 'with' : 'WITHOUT'} a session, so it does not open the ` +
        `overlay (${destination.reason}). A decided plan keeps its page — goto it — and a ` +
        `plan without a session is a seed defect.`,
    );
  }

  await page.goto(destination.href);
  const overlay = workspace(page);
  // THE AUTHORITATIVE SIGNAL: the overlay's plan pane, which renders only once the
  // named session's plan has been read — never its loading skeleton.
  await expect(overlay.getByTestId('plan-proposal-views')).toBeVisible({
    timeout: opts.timeout ?? 30_000,
  });

  if (opts.view) {
    const label = opts.view === 'list' ? en.planReview.viewList : en.planReview.viewCanvas;
    await overlay
      .getByRole('group', { name: en.planReview.viewSwitchAria })
      .getByRole('button', { name: label, exact: true })
      .click();
    if (opts.view === 'list') {
      await expect(overlay.getByTestId('plan-proposal-list')).toBeVisible();
    } else {
      await expect(overlay.getByTestId('planning-canvas')).toBeVisible();
    }
  }
  return overlay;
}
